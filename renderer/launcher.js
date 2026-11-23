'use strict';

const modal = document.getElementById('url-modal');
const form = document.getElementById('url-form');
const input = document.getElementById('url-input');
const errorEl = document.getElementById('url-error');
const submitBtn = document.getElementById('url-submit');
const gameView = document.getElementById('game-view');
const gameFrame = document.getElementById('game-frame');
const gameLoading = document.getElementById('game-loading');

const DEFAULT_ALLOW = 'autoplay; fullscreen; gamepad; screen-wake-lock; encrypted-media';
const SCROLL_KEYS = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

let busy = false;
let currentUrl = '';

/* ------------------------------------------------------------------- utils */

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function setBusy(value, label) {
  busy = value;
  submitBtn.disabled = value;
  submitBtn.setAttribute('aria-busy', value ? 'true' : 'false');
  submitBtn.textContent = value ? label || 'Working…' : 'Fetch & Play';
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

/* ------------------------------------------------------------------ prompt */

function showPrompt() {
  errorEl.hidden = true;
  errorEl.textContent = '';
  input.value = currentUrl;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

async function submitUrl(event) {
  event.preventDefault();
  if (busy) return;

  const value = input.value.trim();
  if (!value) {
    showError('Enter a URL first.');
    input.focus();
    return;
  }
  if (!isValidUrl(value)) {
    showError('Only http:// and https:// URLs are supported.');
    input.focus();
    return;
  }

  errorEl.hidden = true;
  setBusy(true, 'Fetching…');

  try {
    const result = await window.runner.playWithUrl(value);
    if (!result || !result.ok) {
      showError((result && result.error) || 'Could not load that URL.');
      return;
    }
    enterGame(result);
  } catch {
    showError('Something went wrong while loading that URL.');
  } finally {
    setBusy(false);
  }
}

/* --------------------------------------------------------------- game view */

function focusGame() {
  try {
    gameFrame.focus();
    if (gameFrame.contentWindow) gameFrame.contentWindow.focus();
  } catch {
    /* cross-origin focus can fail; clicking the frame still focuses it */
  }
}

function enterGame(data) {
  if (!data || !data.iframeUrl) return;

  currentUrl = data.iframeUrl;
  gameFrame.setAttribute('allow', data.allow || DEFAULT_ALLOW);
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  gameLoading.hidden = false;
  gameView.hidden = false;
  gameFrame.src = currentUrl;
  if (data.title) document.title = `${data.title} — Quenq Runner`;
  window.runner.setGameMode(true);
}

function exitGame() {
  if (gameView.hidden) return;
  gameFrame.src = 'about:blank';
  gameView.hidden = true;
  gameLoading.hidden = true;
  window.runner.setGameMode(false);
  showPrompt();
}

/* ------------------------------------------------------------------ events */

form.addEventListener('submit', submitUrl);

gameFrame.addEventListener('load', () => {
  if (gameView.hidden) return;
  gameLoading.hidden = true;
  focusGame();
});

window.addEventListener('focus', () => {
  if (!gameView.hidden) focusGame();
});

document.addEventListener('click', () => {
  if (!gameView.hidden) focusGame();
});

window.addEventListener(
  'keydown',
  (event) => {
    if (gameView.hidden) return;

    if (document.activeElement !== gameFrame && SCROLL_KEYS.has(event.code)) {
      event.preventDefault();
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        exitGame();
      }
    }
  },
  { passive: false }
);

showPrompt();
