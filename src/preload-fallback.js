// preload-fallback.js — used ONLY if config.injection === 'preload'.
//
// Requires webPreferences.contextIsolation:false (set in main.js): in this mode the preload
// shares `window` with the page, so it can run the same MAIN-world mock source before the
// site's scripts. It does not expose any Node global to the page (nodeIntegration stays false).
//
// It also installs the same control bridge as preload-detector.js (as a plain window global,
// since context isolation is off), so the detector page keeps working in this mode.
'use strict';

const fs = require('fs');
const path = require('path');
const { ipcRenderer, webUtils } = require('electron');
const { buildInjectedSource } = require('./inject/build');

// --- mock injection ---
try {
  const configPath = process.env.STEALTH_INTERVIEW_CONFIG
    ? path.resolve(process.env.STEALTH_INTERVIEW_CONFIG)
    : path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const source = buildInjectedSource(config);
  // Run in the page context as early as possible (the preload runs before the document scripts).
  // eslint-disable-next-line no-eval
  window.eval(source);
} catch (e) {
  console.error('[stealth-interview] preload-fallback: injection failed:', e && e.message);
}

// --- control bridge (same surface as preload-detector.js) ---
try {
  window.stealthInterview = {
    getState: () => ipcRenderer.invoke('fb:getState'),
    onState: (cb) => {
      const handler = (_e, state) => { try { cb(state); } catch (e) {} };
      ipcRenderer.on('fb:state-changed', handler);
      return () => ipcRenderer.removeListener('fb:state-changed', handler);
    },
    setMock: (key, enabled) => ipcRenderer.invoke('fb:setMock', { key, enabled }),
    setRealFullscreen: (on) => ipcRenderer.invoke('fb:setRealFullscreen', !!on),
    pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
    setWebcamFromPath: (filePath) => ipcRenderer.invoke('fb:setWebcamFromPath', filePath),
    setWebcamFromRecording: (base64, ext) => ipcRenderer.invoke('fb:setWebcamFromRecording', { base64, ext }),
    enterCaptureMode: () => ipcRenderer.invoke('fb:enterCaptureMode'),
    exitCaptureMode: () => ipcRenderer.invoke('fb:exitCaptureMode'),
    relaunch: () => ipcRenderer.invoke('fb:relaunch')
  };
} catch (e) {
  console.error('[stealth-interview] preload-fallback: bridge setup failed:', e && e.message);
}
