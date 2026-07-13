// check-inject.js — static check of the injected source.
// Builds the MAIN-world script with the real config and validates its syntax with
// vm.Script (without executing it). Useful in CI / before launching the app.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { buildInjectedSource } = require('../src/inject/build');

const PROJECT_ROOT = path.join(__dirname, '..');

function main() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config.json'), 'utf8'));
  } catch (e) {
    console.error('config.json not readable:', e.message);
    process.exit(1);
  }

  // Test every relevant combination (webcam flag vs. captureStream fallback, SEB JS API on).
  const variants = [
    { name: 'default (webcam flag)', override: { webcamFallbackCaptureStream: false } },
    { name: 'captureStream fallback', override: { webcamFallbackCaptureStream: true } },
    { name: 'SEB mode (SafeExamBrowser API)', override: {
      sebMode: true, sebVersion: '3.7',
      sebConfigKey: 'a'.repeat(64), sebBrowserExamKey: 'b'.repeat(64)
    } }
  ];

  let ok = true;
  for (const v of variants) {
    const cfg = Object.assign({}, config, v.override);
    const source = buildInjectedSource(cfg);
    try {
      // Parsing/compilation only: does NOT execute (no window/document here).
      new vm.Script(source, { filename: 'injected.js' });
      console.log('OK syntax —', v.name, '(' + source.length + ' bytes)');
    } catch (e) {
      ok = false;
      console.error('SYNTAX ERROR —', v.name + ':', e.message);
    }
  }

  process.exit(ok ? 0 : 1);
}

main();
