#!/usr/bin/env node
// convert.js — cross-platform CLI to convert a video into the Y4M 4:2:0 format that
// Chromium's --use-file-for-fake-video-capture expects. Uses the bundled ffmpeg-static
// binary, so it works on macOS and Windows without a system ffmpeg.
//
// Usage:  node scripts/convert.js <src> [out.y4m] [width] [fps]
//   e.g.  npm run convert -- ~/Desktop/clip.mov
//
// WARNING: Y4M is uncompressed -> large files. Use a short clip (a few seconds).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

const src = process.argv[2];
const out = process.argv[3] || path.join(PROJECT_ROOT, 'media', 'webcam.y4m');
const width = process.argv[4] || '1280';
const fps = process.argv[5] || '30';

if (!src) {
  console.error('Error: specify the source video.');
  console.error('Usage: node scripts/convert.js <src> [out.y4m] [width] [fps]');
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error('Error: source file not found: ' + src);
  process.exit(1);
}

let ffmpeg;
try {
  ffmpeg = require('ffmpeg-static');
} catch (e) {
  console.error('Error: ffmpeg-static not installed. Run: npm install');
  process.exit(1);
}
if (!ffmpeg || !fs.existsSync(ffmpeg)) {
  console.error('Error: bundled ffmpeg binary not found at: ' + ffmpeg);
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });

console.log('Converting: ' + src + ' -> ' + out + '  (width=' + width + ', fps=' + fps + ', pix_fmt=yuv420p)');

// -an: no audio. scale keeps aspect ratio with an even height (-2).
const args = [
  '-y', '-i', src,
  '-pix_fmt', 'yuv420p',
  '-vf', 'scale=' + width + ':-2',
  '-r', String(fps),
  '-an',
  out
];

const child = spawn(ffmpeg, args, { stdio: 'inherit' });
child.on('error', (e) => { console.error('ffmpeg failed to start:', e.message); process.exit(1); });
child.on('close', (code) => {
  if (code === 0) {
    const size = (fs.statSync(out).size / (1024 * 1024)).toFixed(1);
    console.log('Done. Created ' + out + ' (' + size + ' MB). Set "webcamVideo" in config.json if you used a different name.');
  } else {
    console.error('ffmpeg exited with code ' + code);
    process.exit(code || 1);
  }
});
