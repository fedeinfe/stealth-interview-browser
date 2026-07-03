#!/usr/bin/env node
// start.js — launch Electron with a clean NODE_OPTIONS.
//
// Electron rejects several flags in NODE_OPTIONS (e.g. --openssl-legacy-provider, which
// many shells export globally as a webpack workaround) and exits immediately. This wrapper
// strips NODE_OPTIONS before spawning Electron. It replaces the old `NODE_OPTIONS= electron .`
// start script, which only works in POSIX shells — this runs the same on macOS and Windows.
'use strict';

const { spawn } = require('child_process');
const electron = require('electron'); // resolves to the Electron executable path

const env = Object.assign({}, process.env);
delete env.NODE_OPTIONS;

const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('error', (e) => { console.error('Failed to launch Electron:', e.message); process.exit(1); });
child.on('close', (code) => process.exit(code == null ? 0 : code));
