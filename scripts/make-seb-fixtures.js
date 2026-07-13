// make-seb-fixtures.js — generate sample .seb files for local testing.
//   test/fixtures/plain.seb  — unencrypted (gzipped XML plist)
//   test/fixtures/pw.seb     — password-encrypted ("pswd", RNCryptor v3), password below
// Run: node scripts/make-seb-fixtures.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const plist = require('plist');

const PW = 'test1234';
const OUT_DIR = path.join(__dirname, '..', 'test', 'fixtures');

// A small but realistic SEB settings dictionary (values keyed WITHOUT the org_ prefix, as inside a .seb).
const settings = {
  startURL: 'https://exam.example.com/quiz/attempt.php',
  sebConfigPurpose: 0,
  originatorVersion: 'SEB_OSX_3.7_1',
  examKeySalt: { __data__: crypto.randomBytes(32).toString('base64') }, // placeholder marker, replaced below
  allowQuit: true,
  quitURL: 'https://exam.example.com/quiz/done.php',
  browserViewMode: 0,
  allowBrowsingBackForward: false,
  allowReload: true,
  showReloadButton: true,
  browserWindowAllowReload: true,
  URLFilterEnable: false,
  sendBrowserExamKey: true
};

// plist.build needs a real Buffer for <data>; swap the salt marker back to a Buffer.
const saltBuf = crypto.randomBytes(32);
settings.examKeySalt = saltBuf;

function toSeb(prefixMode) {
  const xml = Buffer.from(plist.build(settings), 'utf8');
  if (prefixMode === 'plain') {
    // Unencrypted: the XML plist itself, whole file gzipped (SEB spec >= v14).
    return zlib.gzipSync(xml);
  }
  if (prefixMode === 'pswd') {
    const inner = zlib.gzipSync(xml);
    const enc = rncryptorEncrypt(inner, PW);
    return zlib.gzipSync(Buffer.concat([Buffer.from('pswd', 'latin1'), enc]));
  }
  throw new Error('unknown mode');
}

// RNCryptor v3 password encrypt (mirror of the decrypt in src/seb-config.js).
function rncryptorEncrypt(data, password) {
  const pw = Buffer.from(password, 'utf8');
  const encSalt = crypto.randomBytes(8);
  const hmacSalt = crypto.randomBytes(8);
  const iv = crypto.randomBytes(16);
  const encKey = crypto.pbkdf2Sync(pw, encSalt, 10000, 32, 'sha1');
  const hmacKey = crypto.pbkdf2Sync(pw, hmacSalt, 10000, 32, 'sha1');
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const body = Buffer.concat([Buffer.from([3, 1]), encSalt, hmacSalt, iv, ct]);
  const mac = crypto.createHmac('sha256', hmacKey).update(body).digest();
  return Buffer.concat([body, mac]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'plain.seb'), toSeb('plain'));
fs.writeFileSync(path.join(OUT_DIR, 'pw.seb'), toSeb('pswd'));

console.log('Wrote test/fixtures/plain.seb and test/fixtures/pw.seb');
console.log('Password for pw.seb:', PW);

// Show the keys these fixtures would produce (for reference / regression).
try {
  const sebKeys = require('../src/seb-keys');
  const k = sebKeys.computeKeys(settings);
  console.log('Derived Config Key:      ', k.configKey);
  console.log('Derived Browser Exam Key:', k.browserExamKey);
  console.log('Used bundled defaults:   ', k.usedDefaults);
} catch (e) {
  console.log('(key preview skipped:', e.message + ')');
}
