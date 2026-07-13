// main.js — Stealth Interview main process.
//
// Architecture: a BaseWindow with TWO WebContentsViews:
//   - toolbarView  -> address bar (app chrome, trusted local page)
//   - contentView  -> the site under test, with the mocks injected
// The toolbar lives OUTSIDE the site's web contents, so it does not alter the dimensions
// the site measures: the fullscreen the site "sees" is guaranteed by the dimension spoof.
//
// Responsibilities:
//  1. Chromium flags for the fake webcam (before app.whenReady()).
//  2. Auto-granting permissions (camera, mic, window-management, fullscreen…).
//  3. Injecting mocks into the MAIN world BEFORE load (CDP), with a preload fallback.
//  4. A navigable address bar + runtime mock toggles (outside the site's contents).
//  5. A gated control bridge for the bundled detector page (mock toggles, webcam
//     upload/record, capture mode) — see src/preload-detector.js.
'use strict';

// Silence Electron's dev security warning (CSP/unsafe-eval): expected for a testing tool,
// and it would otherwise pollute stdout where we forward the page console.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const { app, BaseWindow, BrowserWindow, WebContentsView, session, screen, Menu, ipcMain, dialog, net } = require('electron');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { buildInjectedSource, PROJECT_ROOT } = require('./inject/build');
const { loadSettings, saveSettings } = require('./settings');
const webcam = require('./webcam');
const sebConfig = require('./seb-config');
const sebKeys = require('./seb-keys');

const TOOLBAR_H = 46; // address-bar height in px
const IS_MAC = process.platform === 'darwin';

// ---------------------------------------------------------------------------
// Capture mode: relaunch WITHOUT the fake-video flags so the REAL camera is reachable
// (used to record a new fake-webcam clip). Signalled by a flag file in userData, or by
// the env var, so it survives the relaunch.
// ---------------------------------------------------------------------------
function captureFlagPath() {
  try {
    return path.join(app.getPath('userData'), '.capture-mode');
  } catch (e) {
    return path.join(PROJECT_ROOT, '.capture-mode');
  }
}
const CAPTURE_MODE = process.env.STEALTH_INTERVIEW_CAPTURE === '1' || fs.existsSync(captureFlagPath());

// ---------------------------------------------------------------------------
// Config (effective settings: DEFAULTS <- config.json <- userData/settings.json)
// ---------------------------------------------------------------------------
let config = loadSettings();
// Resolve the fake-webcam file to an absolute path for both flags and injection.
config.webcamVideo = webcam.resolveWebcamFile(config);

// URL of our trusted bundled control page. Only this origin may drive the control bridge.
const DETECTOR_URL = url.pathToFileURL(path.join(PROJECT_ROOT, 'test', 'detector.html')).href;

function resolveStartUrl() {
  // In capture mode always show the detector so the user can record.
  if (CAPTURE_MODE) return DETECTOR_URL;
  // SEB mode: open the exam start URL carried by the loaded .seb config.
  if (config.sebMode && config.sebStartUrl) {
    const s = String(config.sebStartUrl).trim();
    if (s) return /^(https?|file):\/\//i.test(s) ? s : 'https://' + s;
  }
  const raw = (config.startUrl || '').trim();
  if (raw) {
    if (/^(https?|file):\/\//i.test(raw)) return raw;
    const p = path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
    return url.pathToFileURL(p).href;
  }
  return DETECTOR_URL;
}

// Normalize what the user types in the bar: URL with a scheme -> as-is;
// host/localhost -> https://; free text -> Google search.
function normalizeInput(value) {
  let t = (value || '').trim();
  if (!t) return null;
  if (/^(https?|file|about):/i.test(t)) return t;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(t) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) {
    return 'https://' + t;
  }
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}

// ---------------------------------------------------------------------------
// Chromium flags (MUST be set before app.whenReady()).
// ---------------------------------------------------------------------------
if (config.mocks.webcam && !config.webcamFallbackCaptureStream && !CAPTURE_MODE) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  const wc = config.webcamVideo;
  if (wc && fs.existsSync(wc)) {
    app.commandLine.appendSwitch('use-file-for-fake-video-capture', wc);
  } else {
    console.warn('[stealth-interview] Webcam video not found:', wc,
      '\n  -> the default test pattern will be used. Create a clip from the detector page, or: npm run convert -- /path/to/video.mp4');
  }
}
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// ---------------------------------------------------------------------------
// User-Agent: present as Google Chrome, hiding "Electron"/"Stealth Interview".
// The version used is the REAL one of the Chromium bundled in Electron -> consistent with
// the JS engine (avoids the UA-vs-feature mismatch advanced detectors check).
// ---------------------------------------------------------------------------
function baseUserAgent() {
  if (config.userAgent) return config.userAgent;
  const chrome = process.versions.chrome || '130.0.0.0';
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/' + chrome + ' Safari/537.36';
}

// In SEB mode, append the exact identification tokens Safe Exam Browser adds to its user agent
// (seb-mac SEBBrowserController.m:406) so LMS SEB plugins recognize us. We keep the real Chromium
// base (SEB on Windows is Chromium-based too) so the JS engine stays consistent with the UA.
function sebUserAgentSuffix() {
  const v = String(config.sebVersion || '3.7').trim() || '3.7';
  return ' SEB/' + v + ' SEB/3.5.4 SEB/3.6 SEB/3.6.1';
}
function effectiveUserAgent() {
  return baseUserAgent() + (config.sebMode ? sebUserAgentSuffix() : '');
}
app.userAgentFallback = effectiveUserAgent();

// ---------------------------------------------------------------------------
// SEB (.seb) launch plumbing — must be registered synchronously (before whenReady) so a
// cold-start file/URL open is captured. Opening a .seb parses it, derives the keys, persists
// the SEB state and relaunches so the SEB user-agent/headers/injection apply from startup.
// ---------------------------------------------------------------------------
let pendingSeb = null; // { type:'file', path } | { type:'url', url }

// Register the app as the handler for seb:// / sebs:// links (no-op harm if it fails in dev).
try { app.setAsDefaultProtocolClient('seb'); } catch (e) {}
try { app.setAsDefaultProtocolClient('sebs'); } catch (e) {}

function sebFromArgv(argv) {
  for (let i = 1; i < (argv || []).length; i++) {
    const a = argv[i];
    if (typeof a !== 'string' || a.startsWith('-')) continue;
    if (/^sebs?:\/\//i.test(a)) return { type: 'url', url: a };
    if (/\.seb$/i.test(a)) { try { if (fs.existsSync(a)) return { type: 'file', path: a }; } catch (e) {} }
  }
  return null;
}

// Cold-start sources: an explicit env var, then any .seb path / seb:// URL on the command line.
if (process.env.STEALTH_INTERVIEW_SEB) {
  pendingSeb = { type: 'file', path: process.env.STEALTH_INTERVIEW_SEB };
} else {
  pendingSeb = sebFromArgv(process.argv);
}

// macOS delivers file/URL opens through these events (also fire while running).
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) openSebPath(filePath);
  else pendingSeb = { type: 'file', path: filePath };
});
app.on('open-url', (event, openedUrl) => {
  event.preventDefault();
  if (app.isReady()) openSebUrl(openedUrl);
  else pendingSeb = { type: 'url', url: openedUrl };
});

// Single-instance: on Windows/Linux a second `open .seb` launch arrives here as argv.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', (event, argv) => {
    const s = sebFromArgv(argv);
    if (s) { if (s.type === 'file') openSebPath(s.path); else openSebUrl(s.url); }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized && mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
const ALLOWED_PERMISSIONS = [
  'media', 'camera', 'microphone', 'audioCapture', 'videoCapture',
  'fullscreen', 'pointerLock', 'keyboardLock',
  'window-management', 'window-placement', 'display-capture'
];

function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.indexOf(permission) !== -1);
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    return ALLOWED_PERMISSIONS.indexOf(permission) !== -1;
  });
}

// Rewrite the Sec-CH-UA Client Hints headers to remove the "Electron" brand and present
// Google Chrome's. Replaces ONLY headers the browser already sends (adds none -> no anomaly).
function setupHeaders() {
  const major = (process.versions.chrome || '130').split('.')[0];
  const full = process.versions.chrome || '130.0.0.0';
  const brand = '"Chromium";v="' + major + '", "Google Chrome";v="' + major + '", "Not?A_Brand";v="99"';
  const brandFull = '"Chromium";v="' + full + '", "Google Chrome";v="' + full + '", "Not?A_Brand";v="99.0.0.0"';
  const sebConfigKey = config.sebMode ? String(config.sebConfigKey || '').trim() : '';
  const sebBEK = config.sebMode ? String(config.sebBrowserExamKey || '').trim() : '';
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = details.requestHeaders;
    Object.keys(h).forEach((k) => {
      const kl = k.toLowerCase();
      if (kl === 'sec-ch-ua') h[k] = brand;
      else if (kl === 'sec-ch-ua-full-version-list') h[k] = brandFull;
    });
    // SEB integrity headers: SHA256(urlWithoutFragment + keyHex), per request URL. Only sent when
    // we actually have a key (a verified override or a config-derived value) — never a wrong guess.
    if (details.url && /^https?:/i.test(details.url)) {
      if (sebBEK) h['X-SafeExamBrowser-RequestHash'] = sebKeys.perUrlHash(details.url, sebBEK);
      if (sebConfigKey) h['X-SafeExamBrowser-ConfigKeyHash'] = sebKeys.perUrlHash(details.url, sebConfigKey);
    }
    callback({ requestHeaders: h });
  });
}

// ---------------------------------------------------------------------------
// Window + views + injection
// ---------------------------------------------------------------------------
let mainWindow = null;
let toolbarView = null;
let contentView = null;

function pipeConsole(wc) {
  wc.on('console-message', (event, level, message) => { console.log('[page]', message); });
}

// Context menu (right click) with Cut/Copy/Paste — in both the bar and the pages.
function attachContextMenu(wc) {
  wc.on('context-menu', (event, params) => {
    const ef = params.editFlags || {};
    const items = [];
    if (params.isEditable) {
      items.push({ role: 'cut', label: 'Cut', enabled: ef.canCut });
      items.push({ role: 'copy', label: 'Copy', enabled: ef.canCopy });
      items.push({ role: 'paste', label: 'Paste', enabled: ef.canPaste });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll', label: 'Select All' });
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push({ role: 'copy', label: 'Copy' });
      items.push({ role: 'selectAll', label: 'Select All' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
}

// Navigation-history compat (recent Electron uses webContents.navigationHistory).
function navCanGoBack(wc) { try { return wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(); } catch (e) { return false; } }
function navCanGoForward(wc) { try { return wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(); } catch (e) { return false; } }
function navGoBack(wc) { try { wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack(); } catch (e) {} }
function navGoForward(wc) { try { wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward(); } catch (e) {} }

function layout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getContentBounds();
  if (toolbarView) toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_H });
  if (contentView) contentView.setBounds({ x: 0, y: TOOLBAR_H, width, height: Math.max(0, height - TOOLBAR_H) });
}

function sendNavState() {
  if (!toolbarView || toolbarView.webContents.isDestroyed() || !contentView) return;
  const wc = contentView.webContents;
  const u = wc.getURL();
  toolbarView.webContents.send('fb:state', {
    url: (u && u !== 'about:blank') ? u : '',
    canGoBack: navCanGoBack(wc),
    canGoForward: navCanGoForward(wc)
  });
}

async function injectViaCDP(wc) {
  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (e) {
    console.error('[stealth-interview] debugger.attach failed:', e.message);
    return false;
  }
  try {
    await dbg.sendCommand('Page.enable');
    const res = await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: buildInjectedSource(config)
    });
    wc.__injectedScriptId = res.identifier;
    return true;
  } catch (e) {
    console.error('[stealth-interview] addScriptToEvaluateOnNewDocument failed:', e.message);
    return false;
  }
}

async function reapplyMocksAndReload() {
  const wc = contentView && contentView.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (config.injection === 'cdp') {
    const dbg = wc.debugger;
    try {
      if (wc.__injectedScriptId) {
        await dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: wc.__injectedScriptId });
      }
      const res = await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectedSource(config) });
      wc.__injectedScriptId = res.identifier;
    } catch (e) {
      console.error('[stealth-interview] re-injection failed:', e.message);
    }
  }
  wc.reload();
}

async function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const forceWindowed = process.env.STEALTH_INTERVIEW_WINDOWED === '1';
  const wantFullscreen = !!config.realFullscreen && !forceWindowed && !CAPTURE_MODE;
  const usePreload = config.injection === 'preload';

  mainWindow = new BaseWindow({
    x: primary.bounds.x,
    y: primary.bounds.y,
    width: primary.workAreaSize.width,
    height: primary.workAreaSize.height,
    fullscreen: wantFullscreen,
    kiosk: wantFullscreen && config.fullscreenMode === 'kiosk',
    // macOS: inset traffic lights over the toolbar. Windows/Linux: keep the native frame.
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    backgroundColor: '#0b0f14',
    show: false,
    title: 'Stealth Interview'
  });
  mainWindow.on('closed', () => { mainWindow = null; toolbarView = null; contentView = null; });
  mainWindow.on('resize', layout);
  mainWindow.on('enter-full-screen', layout);
  mainWindow.on('leave-full-screen', layout);

  // --- Content view (the site under test, with the mocks) ---
  contentView = new WebContentsView({
    webPreferences: usePreload
      ? { contextIsolation: false, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, 'preload-fallback.js') }
      : { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload-detector.js') }
  });
  mainWindow.contentView.addChildView(contentView);

  // --- Toolbar view (trusted local page) — added after -> on top ---
  toolbarView = new WebContentsView({
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.contentView.addChildView(toolbarView);
  toolbarView.webContents.loadFile(path.join(__dirname, 'toolbar.html'));
  attachContextMenu(toolbarView.webContents);

  const wc = contentView.webContents;
  pipeConsole(wc);
  attachContextMenu(wc);
  wc.on('did-navigate', sendNavState);
  wc.on('did-navigate-in-page', sendNavState);
  wc.on('did-finish-load', () => { sendNavState(); broadcastState(); });
  wc.setWindowOpenHandler(({ url: u }) => {
    // Keep popups/target=_blank in the mocked view instead of opening external windows.
    if (u) wc.loadURL(u);
    return { action: 'deny' };
  });

  layout();

  if (!usePreload) {
    // about:blank creates the renderer (the "Page" CDP domain has a live target), then the
    // script is registered BEFORE loading the site. addScript persists across navigations.
    try {
      await wc.loadURL('about:blank');
      const ok = await injectViaCDP(wc);
      if (!ok) console.warn('[stealth-interview] CDP injection failed. Set "injection":"preload" in config.json.');
    } catch (e) {
      console.error('[stealth-interview] Error during injection:', e.message);
    }
  }

  await wc.loadURL(resolveStartUrl());
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
}

// ---------------------------------------------------------------------------
// Control bridge state (shared with the detector page)
// ---------------------------------------------------------------------------
function buildState() {
  const webcamPath = webcam.resolveWebcamFile(config);
  return {
    platform: process.platform,
    injection: config.injection,
    canToggleMocks: config.injection === 'cdp',
    captureMode: CAPTURE_MODE,
    mocks: Object.assign({}, config.mocks),
    realFullscreen: !!config.realFullscreen,
    webcamFallbackCaptureStream: !!config.webcamFallbackCaptureStream,
    webcamConfigured: !!(webcamPath && fs.existsSync(webcamPath)),
    webcamPath: webcamPath,
    hasFfmpeg: webcam.hasFfmpeg()
  };
}

function broadcastState() {
  if (!contentView || contentView.webContents.isDestroyed()) return;
  try { contentView.webContents.send('fb:state-changed', buildState()); } catch (e) {}
}

// Only our bundled detector page may drive the privileged bridge.
function isTrusted(event) {
  try {
    const fu = (event.senderFrame && event.senderFrame.url) || '';
    return fu.split('#')[0].split('?')[0] === DETECTOR_URL;
  } catch (e) {
    return false;
  }
}

function relaunchApp() {
  app.relaunch();
  app.exit(0);
}

// Apply a mock toggle. The monitor/fullscreen/always-active mocks live in the injected
// script, so re-injecting + reloading is enough. The webcam mock (in the default,
// non-fallback mode) is driven by a Chromium startup flag, so it only takes effect after
// a relaunch. Shared by the IPC bridge and the native menu.
function applyMockChange(key, enabled) {
  config.mocks[key] = !!enabled;
  saveSettings({ mocks: { [key]: !!enabled } });
  if (key === 'webcam' && !config.webcamFallbackCaptureStream) {
    setTimeout(relaunchApp, 150);
    return { relaunching: true };
  }
  reapplyMocksAndReload();
  broadcastState();
  return { relaunching: false };
}

// ---------------------------------------------------------------------------
// IPC — toolbar (untrusted-ok navigation)
// ---------------------------------------------------------------------------
ipcMain.on('fb:go', (e, value) => {
  const t = normalizeInput(value);
  if (t && contentView && !contentView.webContents.isDestroyed()) contentView.webContents.loadURL(t);
});
ipcMain.on('fb:back', () => { if (contentView) navGoBack(contentView.webContents); });
ipcMain.on('fb:forward', () => { if (contentView) navGoForward(contentView.webContents); });
ipcMain.on('fb:reload', () => { if (contentView) contentView.webContents.reload(); });

// ---------------------------------------------------------------------------
// IPC — control bridge (gated to the detector page)
// ---------------------------------------------------------------------------
ipcMain.handle('fb:getState', (event) => buildState());

ipcMain.handle('fb:setMock', (event, { key, enabled }) => {
  if (!isTrusted(event)) return { ok: false, error: 'forbidden' };
  if (['webcam', 'singleMonitor', 'fullscreen', 'alwaysActive'].indexOf(key) === -1) {
    return { ok: false, error: 'unknown mock' };
  }
  const r = applyMockChange(key, enabled);
  return { ok: true, relaunching: r.relaunching, state: buildState() };
});

ipcMain.handle('fb:setRealFullscreen', (event, on) => {
  if (!isTrusted(event)) return { ok: false, error: 'forbidden' };
  config.realFullscreen = !!on;
  saveSettings({ realFullscreen: !!on });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(!!on);
  layout();
  broadcastState();
  return { ok: true, state: buildState() };
});

ipcMain.handle('fb:setWebcamFromPath', async (event, filePath) => {
  if (!isTrusted(event)) return { ok: false, error: 'forbidden' };
  if (!filePath) return { ok: false, error: 'no file' };
  try {
    const out = await webcam.convertToY4M(filePath);
    saveSettings({ webcamVideo: out, mocks: { webcam: true } });
    config.webcamVideo = out;
    config.mocks.webcam = true;
    return { ok: true, path: out, needsRelaunch: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fb:setWebcamFromRecording', async (event, { base64, ext }) => {
  if (!isTrusted(event)) return { ok: false, error: 'forbidden' };
  if (!base64) return { ok: false, error: 'no data' };
  try {
    const out = await webcam.convertBase64ToY4M(base64, ext || 'webm');
    saveSettings({ webcamVideo: out, mocks: { webcam: true } });
    config.webcamVideo = out;
    config.mocks.webcam = true;
    // Applying a recording means leaving capture mode on next launch.
    try { fs.unlinkSync(captureFlagPath()); } catch (e) {}
    return { ok: true, path: out, needsRelaunch: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fb:enterCaptureMode', (event) => {
  if (!isTrusted(event)) return { ok: false, error: 'forbidden' };
  try {
    fs.mkdirSync(path.dirname(captureFlagPath()), { recursive: true });
    fs.writeFileSync(captureFlagPath(), String(Date.now()), 'utf8');
  } catch (e) { return { ok: false, error: e.message }; }
  setTimeout(relaunchApp, 100);
  return { ok: true };
});

ipcMain.handle('fb:exitCaptureMode', (event) => {
  if (!isTrusted(event)) return { ok: false, error: 'forbidden' };
  try { fs.unlinkSync(captureFlagPath()); } catch (e) {}
  setTimeout(relaunchApp, 100);
  return { ok: true };
});

ipcMain.handle('fb:relaunch', (event) => {
  if (!isTrusted(event)) return { ok: false, error: 'forbidden' };
  setTimeout(relaunchApp, 100);
  return { ok: true };
});

function focusAddressBar() {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.focus();
    toolbarView.webContents.send('fb:focus-url');
  }
}

// ---------------------------------------------------------------------------
// SEB (.seb) open / parse / apply
// ---------------------------------------------------------------------------

// Modal password prompt for encrypted .seb files. Resolves to the entered string, or null if
// the user cancels / closes the window.
function promptSebPassword(message) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('seb:password-result', onResult);
      try { if (win && !win.isDestroyed()) win.close(); } catch (e) {}
      resolve(val);
    };
    const onResult = (event, val) => done(val);
    ipcMain.on('seb:password-result', onResult);

    const win = new BrowserWindow({
      width: 380, height: 200, resizable: false, minimizable: false, maximizable: false,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!(mainWindow && !mainWindow.isDestroyed()),
      title: 'SEB Password', backgroundColor: '#1b2029', show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.on('closed', () => done(null));
    win.loadFile(path.join(__dirname, 'seb-password.html'),
      { search: 'm=' + encodeURIComponent(message || 'Enter the password:') });
    win.once('ready-to-show', () => win.show());
  });
}

// Parse a .seb buffer, derive the SEB keys, persist the SEB state, then relaunch so the SEB
// user-agent / headers / injection take effect from process start.
async function applySebConfig(buffer, extra) {
  extra = extra || {};
  let parsed;
  try {
    parsed = await sebConfig.parseSebFile(buffer, { promptPassword: promptSebPassword });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (!/cancel/i.test(msg)) dialog.showErrorBox('Could not open SEB configuration', msg);
    return;
  }
  if (!parsed.startURL) {
    dialog.showErrorBox('Invalid SEB configuration', 'The .seb file does not contain a start URL.');
    return;
  }

  // Prefer a verified manual key override; otherwise derive from the config (best-effort).
  let configKey = String(config.sebConfigKey || '').trim();
  let browserExamKey = String(config.sebBrowserExamKey || '').trim();
  if (!configKey || !browserExamKey) {
    try {
      const k = sebKeys.computeKeys(parsed.settings);
      if (!configKey) configKey = k.configKey || '';
      if (!browserExamKey) browserExamKey = k.browserExamKey || '';
      if (!k.usedDefaults) {
        console.warn('[stealth-interview] SEB key derivation ran WITHOUT the bundled defaults table ' +
          '(src/seb-defaults.json) — the Config/Browser-Exam keys are only correct if the .seb already ' +
          'contains all settings. Verify with scripts/seb-keycheck.js or set sebConfigKey/sebBrowserExamKey.');
      }
    } catch (e) {
      console.error('[stealth-interview] SEB key derivation failed:', e.message);
    }
  }

  const patch = {
    sebMode: true,
    sebStartUrl: parsed.startURL,
    sebConfigKey: configKey,
    sebBrowserExamKey: browserExamKey,
    sebVersion: String(config.sebVersion || '3.7')
  };
  if (extra.sebFile) patch.sebFile = extra.sebFile;
  saveSettings(patch);
  setTimeout(relaunchApp, 120);
}

async function openSebPath(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); }
  catch (e) { dialog.showErrorBox('Could not read the .seb file', e.message); return; }
  await applySebConfig(buf, { sebFile: filePath });
}

// seb://host/x.seb downloads over http, sebs:// over https (SEB's convention).
async function openSebUrl(sebUrl) {
  const httpUrl = sebUrl.replace(/^seb:\/\//i, 'http://').replace(/^sebs:\/\//i, 'https://');
  try {
    const buf = await fetchToBuffer(httpUrl);
    await applySebConfig(buf, {});
  } catch (e) {
    dialog.showErrorBox('Could not download the SEB configuration', (e && e.message) || String(e));
  }
}

// Minimal GET into a Buffer via Electron net (follows redirects by default).
function fetchToBuffer(target) {
  return new Promise((resolve, reject) => {
    let request;
    try { request = net.request(target); }
    catch (e) { reject(e); return; }
    const chunks = [];
    const timer = setTimeout(() => { try { request.abort(); } catch (e) {} reject(new Error('Download timed out')); }, 15000);
    request.on('response', (response) => {
      if (response.statusCode >= 400) { clearTimeout(timer); reject(new Error('HTTP ' + response.statusCode)); return; }
      response.on('data', (d) => chunks.push(Buffer.from(d)));
      response.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      response.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    request.on('error', (err) => { clearTimeout(timer); reject(err); });
    request.end();
  });
}

function promptOpenSeb() {
  dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Open SEB Configuration',
    properties: ['openFile'],
    filters: [{ name: 'SEB Configuration', extensions: ['seb'] }]
  }).then((res) => {
    if (!res.canceled && res.filePaths && res.filePaths[0]) openSebPath(res.filePaths[0]);
  }).catch(() => {});
}

function exitSebMode() {
  saveSettings({ sebMode: false, sebStartUrl: '', sebConfigKey: '', sebBrowserExamKey: '', sebFile: '' });
  setTimeout(relaunchApp, 120);
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function buildMenu() {
  const mockItem = (label, key) => ({
    label,
    type: 'checkbox',
    checked: !!config.mocks[key],
    enabled: config.injection === 'cdp', // runtime toggle only in CDP mode
    click: (menuItem) => { applyMockChange(key, menuItem.checked); }
  });

  const template = [
    {
      label: 'Stealth Interview',
      submenu: [
        { role: 'about', label: 'About Stealth Interview' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'pasteAndMatchStyle', label: 'Paste and Match Style' },
        { role: 'delete', label: 'Delete' },
        { type: 'separator' },
        { role: 'selectAll', label: 'Select All' }
      ]
    },
    {
      label: 'SEB',
      submenu: [
        { label: 'Open SEB Config…', accelerator: 'CmdOrCtrl+O', click: promptOpenSeb },
        { type: 'separator' },
        {
          label: config.sebMode
            ? ('SEB mode: ON' + (config.sebStartUrl ? '  —  ' + config.sebStartUrl : ''))
            : 'SEB mode: off',
          enabled: false
        },
        { label: 'Exit SEB mode', enabled: !!config.sebMode, click: exitSebMode }
      ]
    },
    {
      label: 'Navigation',
      submenu: [
        { label: 'Address Bar', accelerator: 'CmdOrCtrl+L', click: focusAddressBar },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => contentView && contentView.webContents.reload() },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => contentView && navGoBack(contentView.webContents) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => contentView && navGoForward(contentView.webContents) },
        { type: 'separator' },
        {
          label: 'Site DevTools (detached window)',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => contentView && contentView.webContents.openDevTools({ mode: 'detach' })
        }
      ]
    },
    {
      label: 'Mocks',
      submenu: [
        mockItem('Single monitor', 'singleMonitor'),
        mockItem('Fullscreen (the site believes it)', 'fullscreen'),
        mockItem('Always-active tab', 'alwaysActive'),
        mockItem('Webcam', 'webcam'),
        { type: 'separator' },
        {
          label: 'Real fullscreen window',
          type: 'checkbox',
          checked: !!config.realFullscreen,
          click: (menuItem) => {
            config.realFullscreen = menuItem.checked;
            saveSettings({ realFullscreen: menuItem.checked });
            if (mainWindow) mainWindow.setFullScreen(menuItem.checked);
            layout();
          }
        },
        { type: 'separator' },
        { label: 'Configure webcam from the detector page (upload / record)', enabled: false }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  setupPermissions();
  setupHeaders();
  buildMenu();
  createWindow();

  // A .seb was opened at cold start (file association, command line, env var, or seb:// link):
  // parse it now (may prompt for a password) and relaunch into SEB mode.
  if (pendingSeb) {
    const p = pendingSeb;
    pendingSeb = null;
    setTimeout(() => {
      if (p.type === 'file') openSebPath(p.path);
      else if (p.type === 'url') openSebUrl(p.url);
    }, 150);
  }

  const exitAfter = parseInt(process.env.STEALTH_INTERVIEW_EXIT_AFTER_MS || '0', 10);
  if (exitAfter > 0) {
    setTimeout(() => { console.log('[stealth-interview] auto-quit after ' + exitAfter + 'ms'); app.quit(); }, exitAfter);
  }

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
});

// Detach the debugger before quitting (avoids a SIGTRAP crash with in-flight commands).
app.on('before-quit', () => {
  try {
    const wc = contentView && contentView.webContents;
    if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
  } catch (e) { /* already detached/closed */ }
});

app.on('window-all-closed', () => { app.quit(); });
