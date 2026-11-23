'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { URL } = require('node:url');
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const { parse } = require('node-html-parser');

const DEFAULT_ALLOW = 'autoplay; fullscreen; gamepad; screen-wake-lock; encrypted-media';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// The game page sends `frame-ancestors ... http://localhost:*`, so the local
// shell must be served over loopback HTTP instead of file:// (null origin).
// It has to be `localhost` specifically — 127.0.0.1 is not in that allowlist.
let servers = [];
let baseUrl = '';
let launcherWindow = null;
let launcherBounds = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Best-effort display name when a page has no <title>: 3rd-party URLs vary. */
function deriveGameName(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    let candidate = segments.length ? segments[segments.length - 1] : '';
    if (/^app(\.html?)?$/i.test(candidate) && segments.length > 1) {
      candidate = segments[segments.length - 2];
    }
    candidate = candidate.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_+]+/g, ' ').trim();
    if (!candidate) return url.hostname;
    return candidate.replace(/\b\w/g, (char) => char.toUpperCase());
  } catch {
    return 'Game';
  }
}

function looksLikeHostname(name) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name);
}

/** Prefer the short slug from the URL; fall back to the page's <title>. */
function chooseGameTitle(pageTitle, url) {
  const derived = deriveGameName(url);
  if (!looksLikeHostname(derived)) return derived;
  return pageTitle || derived;
}

/** For an extracted iframe, fall back to the page URL before the page title. */
function chooseExtractedTitle(pageTitle, sourceUrl, iframeUrl) {
  const iframeName = deriveGameName(iframeUrl);
  if (!looksLikeHostname(iframeName)) return iframeName;

  const sourceName = deriveGameName(sourceUrl);
  if (!looksLikeHostname(sourceName)) return sourceName;

  return pageTitle || iframeName;
}

/* -------------------------------------------------- dynamic iframe lookup */

const CANDIDATE_TIMEOUT = 6000;

/**
 * Collects quoted .html URLs from the page source. Pages like Minecraft build
 * their iframe from a script instead of putting it in the markup.
 */
function collectScriptCandidates(html, baseUrl) {
  const raw = new Set();
  const quoted = /["'`]([^"'`\s<>]+\.html?(?:\?[^"'`\s<>]*)?)["'`]/gi;
  const absolute = /https?:\/\/[^\s"'`<>]+/gi;
  let match;

  while ((match = quoted.exec(html))) raw.add(match[1]);
  while ((match = absolute.exec(html))) raw.add(match[0]);

  const urls = new Set();
  for (const item of raw) {
    let url;
    try {
      url = new URL(item, baseUrl);
    } catch {
      continue;
    }
    if (!isHttpUrl(url.toString())) continue;
    if (!/\.html?$/i.test(url.pathname)) continue;
    urls.add(url.toString());
  }
  return [...urls];
}

/** Prefer app.html (WASM default), then app-js.html, then anything near the page. */
function rankCandidates(urls, pageUrl) {
  const pageDir = new URL('.', pageUrl).pathname;

  const score = (value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      return -1;
    }
    const base = url.pathname.split('/').pop().toLowerCase();
    let points = 0;

    if (base === 'app.html') points += 100;
    else if (base === 'app-js.html') points += 80;
    else if (base.startsWith('app')) points += 50;
    else if (base === 'index.html') points += 10;

    if (url.pathname.startsWith(pageDir)) points += 20;
    return points;
  };

  return [...new Set(urls)].sort((a, b) => score(b) - score(a));
}

function conventionalCandidates(pageUrl) {
  const dir = new URL('.', pageUrl);
  return ['app.html', 'app-js.html', 'index.html'].map((name) => new URL(name, dir).toString());
}

async function probeCandidate(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANDIDATE_TIMEOUT);
  try {
    const response = await fetch(candidate, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) return null;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('html')) return null;
    return response.url || candidate;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------- static server */

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function createRequestHandler() {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    if (pathname === '/' || pathname === '') pathname = '/renderer/index.html';
    if (!pathname.startsWith('/renderer/')) {
      res.writeHead(404).end('Not Found');
      return;
    }

    const filePath = path.join(__dirname, pathname);
    const relative = path.relative(__dirname, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  };
}

async function startStaticServer() {
  const handler = createRequestHandler();

  // Bind on both loopback families so `localhost` resolves either way.
  const server4 = http.createServer(handler);
  await listen(server4, 0, '127.0.0.1');
  servers.push(server4);
  const port = server4.address().port;

  const server6 = http.createServer(handler);
  try {
    await listen(server6, port, '::1');
    servers.push(server6);
  } catch {
    server6.close();
  }

  baseUrl = `http://localhost:${port}`;
}

/* -------------------------------------------------------- URL resolution */

/**
 * Fetches the given URL (the Node equivalent of `curl`) and pulls the first
 * usable iframe out of the returned HTML. Falls back to the URL itself when
 * the response is not HTML or contains no iframe.
 */
async function resolveIframeUrl(input) {
  const source = new URL(input).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  let response;
  try {
    response = await fetch(source, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'the request timed out' : err.message;
    throw new Error(`Could not reach that URL — ${reason}.`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`That URL responded with HTTP ${response.status}.`);
  }

  const finalUrl = response.url || source;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const direct = {
    iframeUrl: finalUrl,
    allow: DEFAULT_ALLOW,
    extracted: false,
    title: chooseGameTitle('', finalUrl),
  };

  if (!contentType.includes('html')) return direct;

  const html = await response.text();
  let root;
  let frames;
  try {
    root = parse(html);
    frames = root.querySelectorAll('iframe');
  } catch {
    return direct;
  }

  const pageTitle = ((root.querySelector('title') || {}).text || '').trim();
  direct.title = chooseGameTitle(pageTitle, finalUrl);

  if (frames.length) {
    const preferred =
      frames.find((frame) => (frame.getAttribute('id') || '').trim() === 'app-iframe') || frames[0];
    const src = (preferred.getAttribute('src') || '').trim();

    if (src) {
      try {
        const iframeUrl = new URL(src, finalUrl).toString();
        if (isHttpUrl(iframeUrl)) {
          return {
            iframeUrl,
            allow: (preferred.getAttribute('allow') || DEFAULT_ALLOW).trim() || DEFAULT_ALLOW,
            extracted: true,
            via: 'iframe',
            title: chooseExtractedTitle(pageTitle, finalUrl, iframeUrl),
          };
        }
      } catch {
        /* fall through to script candidates */
      }
    }
  }

  // No usable <iframe> in the markup — many pages inject one from a script.
  const candidates = rankCandidates(
    [...collectScriptCandidates(html, finalUrl), ...conventionalCandidates(finalUrl)],
    finalUrl
  );

  for (const candidate of candidates.slice(0, 8)) {
    const verified = await probeCandidate(candidate);
    if (!verified) continue;
    return {
      iframeUrl: verified,
      allow: DEFAULT_ALLOW,
      extracted: true,
      via: 'script',
      title: chooseExtractedTitle(pageTitle, finalUrl, verified),
    };
  }

  return direct;
}

/* ---------------------------------------------------------------- windows */

function hardenWindow(win) {
  // Keep the top-level page on the local shell; send real links to the OS browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault();
      if (isHttpUrl(url)) shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 620,
    height: 520,
    minWidth: 420,
    minHeight: 460,
    resizable: true,
    backgroundColor: '#171c20',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  launcherWindow.setMenuBarVisibility(false);
  launcherWindow.once('ready-to-show', () => {
    launcherWindow.show();
  });

  launcherWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key || '';

    // No application menu is installed, so wire up the standard window
    // shortcuts explicitly (Cmd+W / Cmd+Q on macOS, Ctrl equivalents elsewhere).
    const accel = process.platform === 'darwin' ? input.meta : input.control;
    if (accel && !input.alt && !input.shift) {
      const lower = key.toLowerCase();
      if (lower === 'w') {
        event.preventDefault();
        launcherWindow.close();
        return;
      }
      if (lower === 'q') {
        event.preventDefault();
        app.quit();
        return;
      }
    }

    if (key === 'F11') {
      event.preventDefault();
      launcherWindow.setFullScreen(!launcherWindow.isFullScreen());
      return;
    }
    if (key === 'F12') {
      event.preventDefault();
      launcherWindow.webContents.toggleDevTools();
      return;
    }
    if (key === 'Escape' && launcherWindow.isFullScreen()) {
      event.preventDefault();
      launcherWindow.setFullScreen(false);
    }
  });

  hardenWindow(launcherWindow);
  launcherWindow.on('closed', () => {
    launcherWindow = null;
  });
  launcherWindow.loadURL(`${baseUrl}/renderer/index.html`);
}

/* -------------------------------------------------------------------- IPC */

ipcMain.handle('game:play-with-url', async (_event, rawUrl) => {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: 'Enter a URL first.' };
  }
  const input = rawUrl.trim();
  if (!isHttpUrl(input)) {
    return { ok: false, error: 'Only http:// and https:// URLs are supported.' };
  }

  try {
    const resolved = await resolveIframeUrl(input);
    return {
      ok: true,
      ...resolved,
      title: resolved.title || deriveGameName(resolved.iframeUrl),
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not load that URL.' };
  }
});

// Swap the single launcher window between its compact start size and the
// maximized in-window game view.
ipcMain.handle('window:game-mode', (_event, enabled) => {
  if (!launcherWindow || launcherWindow.isDestroyed()) return { ok: false };

  if (enabled) {
    if (!launcherBounds) launcherBounds = launcherWindow.getBounds();
    launcherWindow.maximize();
  } else {
    launcherWindow.unmaximize();
    if (launcherBounds) launcherWindow.setBounds(launcherBounds);
    launcherBounds = null;
    launcherWindow.focus();
  }
  return { ok: true };
});

ipcMain.handle('shell:open', (_event, url) => {
  if (isHttpUrl(url)) shell.openExternal(url);
  return { ok: true };
});

/* --------------------------------------------------------------- lifecycle */

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await startStaticServer();
  createLauncherWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  for (const server of servers) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
  servers = [];
});
