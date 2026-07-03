# Stealth Interview Browser

![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-informational)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)

**Stealth Interview Browser** is a cross-platform **Electron** browser (macOS + Windows) designed for use in online job interviews, coding tests, and proctored assessments. It opens any website while returning **mocked** answers to common browser integrity signals, helping you appear fully compliant and focused during the session.

| Signal | What the site sees |
|---|---|
| **Webcam** | Active, looping a natural-looking video as if it were your live camera feed |
| **Multiple monitors** | A single monitor (`screen.isExtended = false`, `getScreenDetails()` → 1 screen) |
| **Fullscreen** | Always appears in fullscreen mode (`document.fullscreenElement` set, `display-mode: fullscreen`) |
| **Active tab** | Always visible and focused; `visibilitychange`/`blur` events never fire |

> The bundled `test/detector.html` page shows in real time what any testing platform sees and serves as the app's control panel.

## Key Features for Interviews & Tests

- **Seamless proctoring bypass** — Maintains the appearance of a legitimate single-monitor, fullscreen, camera-on, fully-focused session while you work.
- **Natural webcam simulation** — Upload or record a short video clip of yourself (or a neutral background) that loops as a live feed. Perfect for staying "present" while focusing on the task.
- **Anti-distraction mock** — Prevents accidental tab switches, minimizations, or blur events from being detected.
- **Chrome-like fingerprint** — Presents as a standard Google Chrome browser (real Chromium version, no Electron branding, no `navigator.webdriver`).
- **Easy controls** — Toggle mocks on/off from the menu or control panel. Changes apply instantly on reload.

**Intended for personal use** in environments where you want to reduce false positives from strict monitoring tools, minimize distractions, or simulate ideal testing conditions. Always respect the rules of the specific interview or platform you are using.

---

## Requirements

- macOS or Windows
- Node.js 18+ (`node`, `npm`) — for development only
- `ffmpeg` is **not** required: the app bundles `ffmpeg-static` for video conversion

## Install (development)

```bash
npm install