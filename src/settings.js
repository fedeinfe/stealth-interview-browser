// settings.js — effective configuration layer.
//
// Three sources, merged in order of increasing precedence:
//   1. hard-coded DEFAULTS below
//   2. the bundled config.json (read-only when packaged — ships the app defaults)
//   3. userData/settings.json (writable — runtime state: mock toggles, webcam path, …)
//
// The bundled config.json cannot be written to once the app is packaged (it lives
// inside the read-only app bundle / asar), so every runtime change is persisted to the
// user-writable settings.json instead.
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const { PROJECT_ROOT } = require('./inject/build');

const DEFAULTS = {
  startUrl: '',
  webcamVideo: 'media/webcam.y4m',
  webcamFallbackCaptureStream: false,
  userAgent: '',
  realFullscreen: false,
  fullscreenMode: 'kiosk',
  injection: 'cdp',
  // SEB (Safe Exam Browser) impersonation. sebMode is toggled by opening a .seb file; the derived
  // values are persisted so the SEB user-agent/headers/injection apply from startup. sebConfigKey /
  // sebBrowserExamKey are 64-char hex; set them explicitly to override the (best-effort) derivation
  // with a value verified against the target LMS.
  sebMode: false,
  sebVersion: '3.7',
  sebFile: '',
  sebStartUrl: '',
  sebConfigKey: '',
  sebBrowserExamKey: '',
  mocks: { webcam: true, singleMonitor: true, fullscreen: true, alwaysActive: true }
};

function bundledConfigPath() {
  return process.env.STEALTH_INTERVIEW_CONFIG
    ? path.resolve(process.env.STEALTH_INTERVIEW_CONFIG)
    : path.join(PROJECT_ROOT, 'config.json');
}

// Writable per-user settings file. Falls back to the project root in dev if userData
// is unavailable for some reason.
function userSettingsPath() {
  try {
    return path.join(app.getPath('userData'), 'settings.json');
  } catch (e) {
    return path.join(PROJECT_ROOT, '.settings.json');
  }
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function normalize(cfg) {
  cfg.mocks = Object.assign(
    { webcam: true, singleMonitor: true, fullscreen: true, alwaysActive: true },
    cfg.mocks || {}
  );
  cfg.injection = cfg.injection || 'cdp'; // 'cdp' | 'preload'
  cfg.fullscreenMode = cfg.fullscreenMode || 'kiosk'; // only used with realFullscreen
  cfg.webcamFallbackCaptureStream = !!cfg.webcamFallbackCaptureStream;
  cfg.realFullscreen = !!cfg.realFullscreen;
  cfg.userAgent = (cfg.userAgent || '').trim();
  cfg.sebMode = !!cfg.sebMode;
  cfg.sebVersion = (cfg.sebVersion || '3.7').toString().trim() || '3.7';
  cfg.sebFile = (cfg.sebFile || '').toString();
  cfg.sebStartUrl = (cfg.sebStartUrl || '').toString().trim();
  cfg.sebConfigKey = (cfg.sebConfigKey || '').toString().trim();
  cfg.sebBrowserExamKey = (cfg.sebBrowserExamKey || '').toString().trim();
  return cfg;
}

// Effective config = DEFAULTS <- config.json <- settings.json (mocks deep-merged).
function loadSettings() {
  const bundled = readJsonSafe(bundledConfigPath()) || {};
  const user = readJsonSafe(userSettingsPath()) || {};
  const merged = Object.assign({}, DEFAULTS, bundled, user);
  merged.mocks = Object.assign({}, DEFAULTS.mocks, bundled.mocks || {}, user.mocks || {});
  return normalize(merged);
}

// Persist a shallow patch (mocks are deep-merged) into the writable settings.json.
function saveSettings(patch) {
  const p = userSettingsPath();
  const current = readJsonSafe(p) || {};
  const next = Object.assign({}, current, patch);
  if (patch && patch.mocks) {
    next.mocks = Object.assign({}, current.mocks || {}, patch.mocks);
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.error('[stealth-interview] could not write settings.json:', e.message);
  }
  return next;
}

module.exports = { loadSettings, saveSettings, userSettingsPath, DEFAULTS };
