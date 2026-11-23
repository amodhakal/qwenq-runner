# qwenq-runner

A small Electron app that asks for a game page URL, finds the game inside it, and plays it full-window.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- [pnpm](https://pnpm.io/)

## Run

```sh
pnpm install
pnpm start
```

Paste a game page or iframe URL into the prompt and press **Fetch & Play**.

## How it works

1. The app fetches the page you enter.
2. If the page contains an `<iframe>`, that iframe is used.
3. If the iframe is injected by JavaScript, the page source is scanned for `.html` candidates (`app.html`, `app-js.html`, …) and each is verified before use.
4. If nothing is found, the page itself is loaded.
5. The game fills the maximized window. Exiting the game returns to the URL prompt.

Nothing is saved to disk — the URL is asked for on every launch.

## Controls

| Key | Action |
| --- | --- |
| `F11` | Toggle fullscreen |
| `Esc` | Exit fullscreen, or return to the URL prompt |
| `F12` | Toggle developer tools |
| `Cmd+W` / `Ctrl+W` | Close the window and quit |

## Build

```sh
pnpm build:mac      # macOS (dmg + zip, x64 and arm64)
pnpm build:linux    # Linux (AppImage + deb)
pnpm build:windows  # Windows (NSIS installer + zip)
pnpm build:dir      # unpacked app for quick testing
```

Each target is most reliable on its own OS. The GitHub Actions workflow builds all three on push to `main` and publishes a release.

### macOS

The macOS build is ad-hoc signed but not notarized. On first launch macOS may warn that the developer cannot be verified:

- Right-click the app and choose **Open**, or
- Run `xattr -cr /Applications/qwenq-runner.app` and open it again.

## Notes

- The local shell is served over `http://localhost:<port>` so game pages that only allow `localhost` framing work correctly.
- Only `http://` and `https://` URLs are supported.
