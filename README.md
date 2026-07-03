# Stealth Interview

A cross-platform **Electron** sandbox (macOS + Windows) that opens a site and returns **mocked**
answers to four browser signals, so you can test how well your webapp detects them:

| Signal | What the site sees |
|---|---|
| **Webcam** | Active, looping one of your videos as if it were a live stream |
| **Multiple monitors** | A single monitor (`screen.isExtended = false`, `getScreenDetails()` → 1 screen) |
| **Fullscreen** | Always fullscreen (`document.fullscreenElement` set, `display-mode: fullscreen`) |
| **Active tab** | Always visible and focused; `visibilitychange`/`blur` events never arrive |

> A tool for **security-testing your own webapp**. The bundled `test/detector.html` page shows in real
> time what a site sees, doubles as the app's **control panel**, and models the checks your app might run.

---

## Requirements

- macOS or Windows
- Node.js 18+ (`node`, `npm`) — for development only
- `ffmpeg` is **not** required: the app bundles `ffmpeg-static` for all video conversion

## Install (development)

```bash
npm install
```

## Run

```bash
npm start
```

A browser-like window with an **address bar** opens. Type your webapp's URL and press Enter (or `⌘/Ctrl+L`
to focus the bar). Back / Forward / Reload buttons are provided.

The **start page is `test/detector.html`** (unless you set `startUrl`). When running inside Stealth Interview,
**each signal card carries its own control** right below its readout:

- **Monitor** card — "Single-monitor mock" toggle.
- **Fullscreen** card — "Fullscreen mock" toggle + "Real fullscreen window" toggle.
- **Visibility / Focus** card — "Always-active-tab mock" toggle.
- **Webcam** card — "Webcam mock" toggle plus the fake-webcam source controls:
  - **Upload video…** — pick any video; it's converted to the working Y4M format and applied on restart.
  - **Record from camera** — restarts into a *recording mode* (fake-video flags off, so your **real**
    camera is reachable), lets you record a short clip, converts it, and restarts to apply it.

Toggling a mock reloads the site under test so the change takes effect before its scripts run *(runtime
toggles require `injection: "cdp"`, the default)*. The same toggles are also available in the native
**Mocks** menu. When `test/detector.html` is opened outside Stealth Interview, the controls are hidden and only
the signal readouts show.

## Configuration (`config.json`)

`config.json` holds the shipped defaults. Runtime changes made from the control panel/menu are persisted
to a writable `settings.json` in the app's user-data directory (the app bundle is read-only once packaged),
which takes precedence over `config.json`.

```jsonc
{
  "startUrl": "",              // empty = open test/detector.html; or "https://your-webapp"
  "webcamVideo": "media/webcam.y4m",
  "webcamFallbackCaptureStream": false, // true = override JS getUserMedia (see below)
  "userAgent": "",             // empty = automatic Google Chrome UA; or a custom UA
  "realFullscreen": false,     // false = NORMAL window that "looks" fullscreen to the site
                                //  true  = window REALLY fullscreen (macOS/Windows)
  "fullscreenMode": "kiosk",   // only used with realFullscreen:true — "fullscreen" or "kiosk"
  "injection": "cdp",          // "cdp" (default) or "preload" (fallback)
  "mocks": { "webcam": true, "singleMonitor": true, "fullscreen": true, "alwaysActive": true }
}
```

## Preparing a webcam clip from the CLI (optional)

The in-app **Upload / Record** flow is the easy path. If you prefer the CLI, convert a **short** clip
(Y4M is uncompressed → large files) with the bundled ffmpeg:

```bash
npm run convert -- /path/to/your/video.mp4
# writes media/webcam.y4m (1280px, 30fps)
```

`npm run convert` works on macOS and Windows (uses `ffmpeg-static`). `media/convert.sh` is a macOS/Linux
convenience that requires a system `ffmpeg`. If you skip this, the browser uses Chromium's default test
pattern until you set a clip from the control panel.

---

## Packaging (dmg / exe)

The app ships as a native installer with the detector page and ffmpeg bundled inside:

```bash
npm run dist        # build for the current OS (dmg on macOS, NSIS exe on Windows)
npm run dist:mac    # force macOS dmg
npm run dist:win    # force Windows exe
npm run pack        # unpacked build (no installer) for quick testing
```

Output goes to `dist/`. The ffmpeg binary is unpacked from the asar archive (see `asarUnpack` in
`package.json`) so it can execute; converted clips and settings are written to the per-user data directory.

---

## How it works (stealth)

- Mocks are injected into the **MAIN world** via **CDP `Page.addScriptToEvaluateOnNewDocument`**: they run
  **before** the site's scripts and **in every frame** (including same-process iframes), closing the "read
  the raw values from an iframe" bypass.
- Overrides use `Object.defineProperty` on the native **prototypes** (`Screen.prototype`,
  `Document.prototype`) with consistent descriptors, and `Function.prototype.toString` is patched to return
  `[native code]` (anti-tamper).
- The **webcam** stays 100% native: the Chromium flags (`--use-fake-device-for-media-stream`,
  `--use-file-for-fake-video-capture`) feed `getUserMedia` with no JS override.
  `--use-fake-ui-for-media-stream` auto-accepts the permission.
- **User-Agent = Google Chrome**: the `navigator.userAgent` string, Client Hints headers (`Sec-CH-UA`,
  `Sec-CH-UA-Full-Version-List`) and `navigator.userAgentData` all present Chrome — with the **real** version
  of the bundled Chromium (consistent with the JS engine) — without the "Electron" brand. No
  `navigator.webdriver`. Customizable via `userAgent` in `config.json`.
- **Fullscreen without occupying the screen**: by default the window stays *normal/movable* but the mock
  makes the site believe it's fullscreen both via the APIs (`fullscreenElement`, `display-mode: fullscreen`)
  and via **dimensions** (`innerWidth/innerHeight`, `outerWidth/outerHeight`, `screenX/Y`, `screen.avail*`
  aligned to the screen). With `realFullscreen: true` the window goes truly fullscreen (pixel-perfect) and
  the dimension spoof turns off because it's no longer needed.

### Verify

```bash
npm run check     # validates the syntax of the injected source (no GUI)
npm start         # opens the detector: every card should be green
```

In the detector: switch tabs or minimize the window → the `visibilitychange`/`blur` counters must stay
**0**. Connect a second monitor → `screens.length` must stay **1**.

---

## Residual detectable signals (honesty)

No JS override can fully hide these vectors — your webapp *can still* use them to unmask the environment:

- **`requestAnimationFrame`/timer throttling** when the process is truly in the background: enforced by
  Chromium/the OS regardless of the overrides.
- **Webcam track label**: with the flags it reads as a fake device name; with the `captureStream()` fallback
  the label is empty.
- **Timing side-channels** (`performance.now()`, media pipeline behavior).
- **Out-of-process cross-origin iframes**: may not be covered by the CDP injection.
- **`window.visualViewport`** (only in the windowed mode that "looks" fullscreen): reflects the real, smaller
  viewport and is not spoofed. If your webapp checks it, use `realFullscreen: true`.
- **Server-side bot detection** (e.g. reCAPTCHA / Google's "unusual traffic"): the Chrome UA removes the
  "Electron" signal, but services like Google use many other factors (behavior, IP reputation, TLS/JA3
  fingerprint, reCAPTCHA telemetry). Spoofing the UA does **not** guarantee getting past them.

## Fallbacks

- **Webcam without Y4M conversion / arbitrary format**: set `"webcamFallbackCaptureStream": true`.
  `getUserMedia` is overridden to return `captureStream()` from a `<video loop>` with your file (even `.mp4`).
  More flexible but less stealthy (non-native function, empty label).
- **CDP unavailable**: set `"injection": "preload"` → the mocks are injected from a preload with
  `contextIsolation:false`. Doesn't cover cross-process iframes but is simpler.

## Structure

```
src/main.js                  main process: BaseWindow + 2 views, flags, permissions, injection, menu, IPC
src/settings.js              effective config layer (defaults <- config.json <- userData settings.json)
src/webcam.js                fake-webcam path resolution + ffmpeg (ffmpeg-static) conversion to Y4M
src/toolbar.html             address bar (separate WebContentsView, outside the site)
src/preload-detector.js      gated control bridge exposed to the detector page (window.stealthInterview)
src/inject/stealth.js        masking helpers (native toString, defineNative)
src/inject/mocks.template.js the four mocks (MAIN world)
src/inject/build.js          assembles the injected source
src/preload-fallback.js      alternative injection (contextIsolation:false) + control bridge
scripts/convert.js           cross-platform video → Y4M CLI (ffmpeg-static)
media/convert.sh             macOS/Linux video → Y4M helper (system ffmpeg)
test/detector.html           the four-signal probe + in-app control panel (bundled start page)
scripts/check-inject.js      static syntax validation
```
