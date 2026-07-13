// seb-config.js — parse a Safe Exam Browser `.seb` configuration file.
//
// Faithful port of the decode pipeline in seb-mac's SEBConfigFileManager.m:
//   1. The whole file is gzip-compressed (spec >= v14). Gunzip it (tolerate non-gzip input).
//   2. Read a 4-byte prefix that selects the encryption mode:
//        <?xm  -> the bytes are already an unencrypted XML property list
//        plnd  -> "plain data": strip prefix, gunzip the inner payload
//        pswd  -> "password" (starting an exam): RNCryptor-decrypt with the typed password
//        pwcc  -> "password configuring client": RNCryptor-decrypt with the (hashed) admin password
//        pkhs  -> "public key hash": certificate/identity encrypted — NOT supported here
//   3. For every encrypted/plnd case the decrypted payload is gzip-compressed again -> gunzip it.
//   4. Parse the resulting XML plist into a plain settings object (keys are stored WITHOUT the
//      `org_safeexambrowser_SEB_` prefix).
//
// SEB uses RNCryptor v3 (kRNCryptorAES256Settings): AES-256-CBC, PKCS7, PBKDF2-HMAC-SHA1 with
// 10000 rounds and 8-byte salts, HMAC-SHA256 integrity. See seb-mac RNCryptor.h / RNEncryptor.m.
'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const plist = require('plist');

const PREFIX_LEN = 4;
const WRONG_PASSWORD = 'SEB_WRONG_PASSWORD';

// Gunzip if the buffer carries the gzip magic bytes; otherwise return it unchanged.
function gunzipMaybe(buf) {
  if (buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf); } catch (e) { /* fall through */ }
  }
  return buf;
}

function prefixOf(buf) {
  return buf.slice(0, PREFIX_LEN).toString('latin1');
}

function sha256hex(str) {
  return crypto.createHash('sha256').update(Buffer.from(str, 'utf8')).digest('hex');
}

// RNCryptor v3 password-based decrypt. Throws WRONG_PASSWORD on an HMAC mismatch (which is how
// RNCryptor signals a wrong password), or a descriptive Error on a malformed container.
function rncryptorDecrypt(data, password) {
  const MIN = 2 + 8 + 8 + 16 + 32; // preamble + salts + IV + HMAC
  if (!data || data.length < MIN) throw new Error('RNCryptor container too short');
  const version = data[0];
  const options = data[1];
  if (version !== 3) throw new Error('Unsupported RNCryptor format version ' + version);
  if (!(options & 0x01)) throw new Error('Key-based (non-password) RNCryptor data is not supported');

  let off = 2;
  const encSalt = data.slice(off, off + 8); off += 8;
  const hmacSalt = data.slice(off, off + 8); off += 8;
  const iv = data.slice(off, off + 16); off += 16;
  const hmac = data.slice(data.length - 32);
  const ciphertext = data.slice(off, data.length - 32);

  const pw = Buffer.from(password, 'utf8');
  const encKey = crypto.pbkdf2Sync(pw, encSalt, 10000, 32, 'sha1');
  const hmacKey = crypto.pbkdf2Sync(pw, hmacSalt, 10000, 32, 'sha1');

  // HMAC covers everything from the version byte through the end of the ciphertext.
  const mac = crypto.createHmac('sha256', hmacKey).update(data.slice(0, data.length - 32)).digest();
  if (mac.length !== hmac.length || !crypto.timingSafeEqual(mac, hmac)) {
    const err = new Error(WRONG_PASSWORD);
    err.code = WRONG_PASSWORD;
    throw err;
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function isWrongPassword(e) {
  return e && e.code === WRONG_PASSWORD;
}

// pswd — "starting exam": the password is used verbatim (UTF-8). Up to 5 attempts.
async function decryptStartingExam(enc, promptPassword, presetPassword) {
  const tryOnce = (pw) => gunzipMaybe(rncryptorDecrypt(enc, pw));
  if (presetPassword != null) {
    try { return tryOnce(presetPassword); } catch (e) { if (!isWrongPassword(e)) throw e; }
  }
  for (let i = 0; i < 5; i++) {
    const pw = await promptPassword(i === 0
      ? 'Enter the exam password to open these SEB settings:'
      : 'Wrong password. Enter the exam password:');
    if (pw == null) throw new Error('Opening the .seb file was canceled.');
    try { return tryOnce(pw); } catch (e) { if (!isWrongPassword(e)) throw e; }
  }
  throw new Error('Could not decrypt the .seb file: wrong exam password.');
}

// pwcc — "configuring client": SEB first tries the stored admin-password hash and an empty
// password, then falls back to prompting and hashing the entered password with SHA-256.
async function decryptConfiguringClient(enc, promptPassword) {
  const tryOnce = (pw) => gunzipMaybe(rncryptorDecrypt(enc, pw));
  // Default distribution case: settings encrypted with the empty admin password.
  for (const candidate of ['']) {
    try { return tryOnce(candidate); } catch (e) { if (!isWrongPassword(e)) throw e; }
  }
  for (let i = 0; i < 5; i++) {
    const pw = await promptPassword(i === 0
      ? 'Enter the password used to encrypt these SEB settings:'
      : 'Wrong password. Enter the settings password:');
    if (pw == null) throw new Error('Opening the .seb file was canceled.');
    const h = sha256hex(pw);
    let ok = null;
    for (const candidate of [h, h.toUpperCase()]) {
      try { ok = tryOnce(candidate); break; } catch (e) { if (!isWrongPassword(e)) throw e; }
    }
    if (ok) return ok;
  }
  throw new Error('Could not decrypt the .seb file: wrong settings password.');
}

// Parse a `.seb` buffer into { settings, startURL, configPurpose, encryption }.
// `opts.promptPassword(message) -> Promise<string|null>` is called for encrypted files.
// `opts.password` (optional) is tried first for `pswd` files before prompting.
async function parseSebFile(buffer, opts) {
  opts = opts || {};
  const promptPassword = opts.promptPassword || (async () => {
    throw new Error('This .seb file is password-protected but no password prompt is available.');
  });

  const data = gunzipMaybe(buffer);              // outer gzip
  const prefix = prefixOf(data);
  let xmlBuf;

  if (prefix === 'pkhs') {
    throw new Error('This .seb file is certificate-encrypted (prefix "pkhs"), which is not supported.');
  } else if (prefix === 'pswd') {
    xmlBuf = await decryptStartingExam(data.slice(PREFIX_LEN), promptPassword, opts.password);
  } else if (prefix === 'pwcc') {
    xmlBuf = await decryptConfiguringClient(data.slice(PREFIX_LEN), promptPassword);
  } else if (prefix === 'plnd') {
    xmlBuf = gunzipMaybe(data.slice(PREFIX_LEN)); // inner gzip
  } else if (prefix === '<?xm') {
    xmlBuf = data;                                // already an unencrypted XML plist
  } else {
    throw new Error('Unrecognized .seb format (prefix "' + prefix + '").');
  }

  let settings;
  try {
    settings = plist.parse(xmlBuf.toString('utf8'));
  } catch (e) {
    throw new Error('The .seb file did not contain a valid settings plist: ' + e.message);
  }
  if (!settings || typeof settings !== 'object') {
    throw new Error('The .seb file did not contain a settings dictionary.');
  }

  return {
    settings: settings,
    startURL: typeof settings.startURL === 'string' ? settings.startURL : '',
    configPurpose: typeof settings.sebConfigPurpose === 'number' ? settings.sebConfigPurpose : 0,
    encryption: prefix
  };
}

// Convenience wrapper for a file path.
async function parseSebFilePath(filePath, opts) {
  const fs = require('fs');
  const buf = fs.readFileSync(filePath);
  return parseSebFile(buf, opts);
}

module.exports = { parseSebFile, parseSebFilePath, rncryptorDecrypt, sha256hex, WRONG_PASSWORD };
