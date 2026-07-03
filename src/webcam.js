// webcam.js — resolve the fake-webcam file and convert user media into the working
// format (Y4M 4:2:0), the format Chromium's --use-file-for-fake-video-capture expects.
//
// Conversion runs in-process using the ffmpeg-static binary that ships with the app, so
// end users don't need ffmpeg installed. Converted output goes to a writable location
// (userData when packaged) because the app bundle itself is read-only.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

const { PROJECT_ROOT } = require('./inject/build');

function isPackaged() {
  try { return app.isPackaged; } catch (e) { return false; }
}

// Directory we may write converted media / temp files into.
function storeDir() {
  if (isPackaged()) {
    try { return app.getPath('userData'); } catch (e) { /* fall through */ }
  }
  return path.join(PROJECT_ROOT, 'media');
}

// Absolute path of the converted fake-webcam file we produce and later feed to Chromium.
function webcamStorePath() {
  return path.join(storeDir(), 'webcam.y4m');
}

// Resolve the fake-webcam file to actually use, given the effective settings.
//   - an absolute settings.webcamVideo that exists wins
//   - otherwise the converted file in the store, if present
//   - otherwise the (possibly non-existent) project default
function resolveWebcamFile(settings) {
  const raw = (settings && settings.webcamVideo) || 'media/webcam.y4m';
  const abs = path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
  if (fs.existsSync(abs)) return abs;
  const store = webcamStorePath();
  if (fs.existsSync(store)) return store;
  return abs;
}

// Path to the bundled ffmpeg binary, rewritten out of the asar archive when packaged
// (binaries can't be executed from inside app.asar, so electron-builder unpacks them).
function ffmpegPath() {
  let p = null;
  try { p = require('ffmpeg-static'); } catch (e) { return null; }
  if (!p) return null;
  if (p.indexOf('app.asar' + path.sep) !== -1 || p.indexOf('app.asar/') !== -1) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  return p;
}

function hasFfmpeg() {
  const p = ffmpegPath();
  return !!(p && fs.existsSync(p));
}

// Convert an arbitrary source video into the fake-webcam Y4M and return its path.
// Writes to a temp file first, then atomically renames, so a concurrently-read file is
// never half-written.
function convertToY4M(srcPath, opts) {
  opts = opts || {};
  const width = opts.width || 1280;
  const fps = opts.fps || 30;
  return new Promise((resolve, reject) => {
    const ff = ffmpegPath();
    if (!ff || !fs.existsSync(ff)) {
      return reject(new Error('ffmpeg binary not available (ffmpeg-static missing)'));
    }
    if (!fs.existsSync(srcPath)) {
      return reject(new Error('source video not found: ' + srcPath));
    }
    const out = webcamStorePath();
    const tmp = out + '.tmp.y4m';
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch (e) {}

    // -an: drop audio (the fake video flag ignores it). scale keeps aspect ratio with an
    // even height (-2). yuv420p is the pixel format the Y4M fake capture requires.
    const args = [
      '-y', '-i', srcPath,
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=' + width + ':-2',
      '-r', String(fps),
      '-an',
      tmp
    ];
    let stderr = '';
    let child;
    try {
      child = spawn(ff, args);
    } catch (e) {
      return reject(e);
    }
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        try {
          fs.renameSync(tmp, out);
        } catch (e) { return reject(e); }
        resolve(out);
      } else {
        try { fs.unlinkSync(tmp); } catch (e) {}
        reject(new Error('ffmpeg exited with code ' + code + ': ' + stderr.slice(-600)));
      }
    });
  });
}

// Convert a base64-encoded recording (e.g. a webm blob from MediaRecorder) into Y4M.
function convertBase64ToY4M(base64, ext, opts) {
  return new Promise((resolve, reject) => {
    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch (e) { return reject(e); }
    const tmpIn = path.join(storeDir(), 'recording-in.' + (ext || 'webm'));
    try {
      fs.mkdirSync(path.dirname(tmpIn), { recursive: true });
      fs.writeFileSync(tmpIn, buf);
    } catch (e) { return reject(e); }
    convertToY4M(tmpIn, opts).then((out) => {
      try { fs.unlinkSync(tmpIn); } catch (e) {}
      resolve(out);
    }, (err) => {
      try { fs.unlinkSync(tmpIn); } catch (e) {}
      reject(err);
    });
  });
}

module.exports = {
  webcamStorePath, resolveWebcamFile, ffmpegPath, hasFfmpeg,
  convertToY4M, convertBase64ToY4M, storeDir
};
