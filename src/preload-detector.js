// preload-detector.js — exposes a small, gated control bridge to the content view.
//
// This preload runs for EVERY page loaded in the content view (including arbitrary
// websites under test), so it only exposes an IPC surface — every privileged action is
// verified in the main process against the sender's URL, and refused unless the caller
// is our own bundled detector page. A site under test therefore cannot use this bridge
// to switch the mocks off and unmask itself.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const api = {
  // --- state / mock toggles ---
  getState: () => ipcRenderer.invoke('fb:getState'),
  onState: (cb) => {
    const handler = (_e, state) => { try { cb(state); } catch (e) {} };
    ipcRenderer.on('fb:state-changed', handler);
    return () => ipcRenderer.removeListener('fb:state-changed', handler);
  },
  setMock: (key, enabled) => ipcRenderer.invoke('fb:setMock', { key, enabled }),
  setRealFullscreen: (on) => ipcRenderer.invoke('fb:setRealFullscreen', !!on),

  // --- webcam: upload a file ---
  // Resolve a File chosen via <input type=file> to an absolute path (structured-clone
  // safe), then hand the path to the main process to convert.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  },
  setWebcamFromPath: (filePath) => ipcRenderer.invoke('fb:setWebcamFromPath', filePath),

  // --- webcam: apply a recording (base64 of a MediaRecorder blob) ---
  setWebcamFromRecording: (base64, ext) =>
    ipcRenderer.invoke('fb:setWebcamFromRecording', { base64, ext }),

  // --- capture mode (relaunch without fake-video flags so the REAL camera is reachable) ---
  enterCaptureMode: () => ipcRenderer.invoke('fb:enterCaptureMode'),
  exitCaptureMode: () => ipcRenderer.invoke('fb:exitCaptureMode'),

  relaunch: () => ipcRenderer.invoke('fb:relaunch')
};

try {
  contextBridge.exposeInMainWorld('stealthInterview', api);
} catch (e) {
  // contextIsolation disabled (shouldn't happen for this preload) — expose directly.
  try { window.stealthInterview = api; } catch (e2) {}
}
