// build.js — assembles the MAIN-world source to inject.
// Concatenates stealth.js + mocks.template.js into a single IIFE ("use strict") and
// interpolates the config into it as an __CFG__ object. Used both by main.js (via CDP)
// and by the fallback preload.
//
// This module stays free of any electron dependency so it can also run under plain Node
// (see scripts/check-inject.js).
'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Absolute path of the video used for the fake webcam.
function webcamAbsPath(config) {
  const rel = (config && config.webcamVideo) || 'media/webcam.y4m';
  return path.isAbsolute(rel) ? rel : path.join(PROJECT_ROOT, rel);
}

// Complete source ready for Page.addScriptToEvaluateOnNewDocument / window.eval.
function buildInjectedSource(config) {
  const stealthSrc = fs.readFileSync(path.join(__dirname, 'stealth.js'), 'utf8');
  const mocksSrc = fs.readFileSync(path.join(__dirname, 'mocks.template.js'), 'utf8');

  const mocks = (config && config.mocks) || {};
  const cfg = {
    mocks: mocks,
    webcamFallbackCaptureStream: !!(config && config.webcamFallbackCaptureStream),
    webcamVideoUrl: url.pathToFileURL(webcamAbsPath(config)).href,
    // Spoof the dimensions whenever the fullscreen mock is on: the address bar (and/or a
    // windowed frame) makes the site's viewport smaller than the screen, so it must always
    // be aligned to screen.* for the site to see itself as fullscreen.
    spoofFullscreenDims: !!mocks.fullscreen,
    // Client Hints on the JS side: replace the "Electron" brand with Google Chrome in
    // navigator.userAgentData. The version is the real one of the bundled Chromium.
    ua: {
      major: (process.versions.chrome || '130').split('.')[0],
      full: process.versions.chrome || '130.0.0.0'
    },
    // SEB (Safe Exam Browser) JavaScript API — exposes window.SafeExamBrowser to the page so LMS
    // integrations that probe it recognize a SEB session. The raw keys are the 64-char hex Config
    // Key / Browser Exam Key; the in-page updateKeys() derives the per-URL hash from them.
    seb: {
      enabled: !!(config && config.sebMode),
      version: (config && config.sebVersion) || '3.7',
      configKey: (config && config.sebConfigKey) || '',
      browserExamKey: (config && config.sebBrowserExamKey) || ''
    }
  };

  return [
    '(function(){"use strict";',
    'var __CFG__ = ' + JSON.stringify(cfg) + ';',
    stealthSrc,
    mocksSrc,
    '})();'
  ].join('\n');
}

module.exports = { buildInjectedSource, webcamAbsPath, PROJECT_ROOT };
