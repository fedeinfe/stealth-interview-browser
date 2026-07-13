// seb-keys.js — reproduce Safe Exam Browser's integrity hashes from a `.seb` settings object.
//
// Faithful port of seb-mac's SEBCryptor.m. Two hashes are derived purely from the config
// (no dependency on the SEB binary), so given the same `.seb` the exam admin uploaded to the
// LMS, we compute the identical values the LMS expects:
//
//   Config Key       = SHA256( canonicalJSON(effectiveSettings) )
//   Browser Exam Key = HMAC-SHA256( key = examKeySalt, msg = appleXmlPlist(prefixedSettings) )
//   header/JS value  = SHA256( urlWithoutFragment + lowercaseHex(key) )
//
// "effectiveSettings" = SEB's built-in defaults (src/seb-defaults.json) shallow-merged with the
// keys present in the `.seb`, because SEB hashes the full effective settings, not just the file.
//
// IMPORTANT (documented in README): byte-exact reproduction depends on (a) a complete, correct
// defaults table and (b) matching Apple's serialization exactly. The algorithms and the plist
// format are verified; the defaults table is best-effort. Cross-check with scripts/seb-keycheck.js
// against a real SEB / Moodle, and prefer the manual `sebConfigKey`/`sebBrowserExamKey` overrides
// when you have a ground-truth key.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEB_PREFIX = 'org_safeexambrowser_SEB_';

// -- defaults ---------------------------------------------------------------
let _defaults = null;
function loadDefaults() {
  if (_defaults) return _defaults;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'seb-defaults.json'), 'utf8');
    _defaults = reviveBuffers(JSON.parse(raw));
  } catch (e) {
    _defaults = null; // absent -> derive over the .seb keys alone (flagged by callers)
  }
  return _defaults;
}
function haveDefaults() { return !!loadDefaults(); }

// seb-defaults.json encodes NSData as {"__data__":"<base64>"}. Revive to Buffer.
function reviveBuffers(obj) {
  if (Array.isArray(obj)) return obj.map(reviveBuffers);
  if (obj && typeof obj === 'object') {
    if (typeof obj.__data__ === 'string') return Buffer.from(obj.__data__, 'base64');
    const out = {};
    for (const k of Object.keys(obj)) out[k] = reviveBuffers(obj[k]);
    return out;
  }
  return obj;
}

// -- helpers ----------------------------------------------------------------
function isPlainDict(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date);
}

// caseInsensitiveOrdinalCompare: NSCaseInsensitiveSearch | NSForcedOrderingSearch.
// Case-insensitive first; case-sensitive ordinal as the tie-break.
function ciOrdinal(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
// Apple XML plist key order: default CFStringCompare == case-sensitive UTF-16 ordinal.
function ordinal(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

// Merge SEB defaults with the keys present in the .seb (top-level shallow: the file supplies
// each top-level value wholesale, including complete arrays/dicts).
function effectiveSettings(sebSettings) {
  const defaults = loadDefaults();
  const base = defaults ? Object.assign({}, defaults) : {};
  return Object.assign(base, sebSettings || {});
}

// ===========================================================================
// Config Key — canonical JSON then SHA-256 (SEBCryptor.m:405,538,690).
// ===========================================================================
function jsonScalar(v) {
  if (Buffer.isBuffer(v)) return v.length === 0 ? '""' : '"' + v.toString('base64') + '"';
  if (typeof v === 'string') return '"' + v + '"';           // no escaping/trim (matches SEB)
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return '"' + v.toISOString() + '"';
  return String(v);
}

// Returns { json, count } where count is the number of emitted keys (0 -> prune when nested).
function configKeyDict(src) {
  const keys = Object.keys(src)
    .filter((k) => k !== 'originatorVersion')
    .sort(ciOrdinal);
  const parts = [];
  for (const key of keys) {
    const v = src[key];
    if (isPlainDict(v)) {
      const sub = configKeyDict(v);
      if (sub.count === 0) continue;            // empty sub-dicts are pruned
      parts.push('"' + key + '":' + sub.json);
    } else if (Array.isArray(v)) {
      parts.push('"' + key + '":' + configKeyArray(v)); // arrays always emitted (even [])
    } else {
      parts.push('"' + key + '":' + jsonScalar(v));
    }
  }
  return { json: '{' + parts.join(',') + '}', count: parts.length };
}

function configKeyArray(arr) {
  const parts = [];
  for (const obj of arr) {
    if (isPlainDict(obj)) parts.push(configKeyDict(obj).json);
    else if (Array.isArray(obj)) parts.push(configKeyArray(obj));
    else parts.push(jsonScalar(obj));
  }
  return '[' + parts.join(',') + ']';
}

function configKeyJson(sebSettings) {
  return configKeyDict(effectiveSettings(sebSettings)).json;
}

function computeConfigKey(sebSettings) {
  const json = configKeyJson(sebSettings);
  return crypto.createHash('sha256').update(Buffer.from(json, 'utf8')).digest('hex');
}

// ===========================================================================
// Browser Exam Key — Apple XML plist then HMAC-SHA256 (SEBCryptor.m:339,428,437).
// ===========================================================================
const PLIST_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function tabs(n) { return '\t'.repeat(n); }

// Base64 wrapped at 68 chars/line, each line prefixed with the value's indent (verified against
// Foundation's PropertyListSerialization .xml output).
function dataElement(buf, indent) {
  const b64 = buf.toString('base64');
  if (b64.length === 0) return '<data>\n' + tabs(indent) + '</data>';
  let lines = '';
  for (let i = 0; i < b64.length; i += 68) lines += tabs(indent) + b64.slice(i, i + 68) + '\n';
  return '<data>\n' + lines + tabs(indent) + '</data>';
}

function plistNumber(n) {
  return Number.isInteger(n) ? '<integer>' + n + '</integer>' : '<real>' + n + '</real>';
}

// Serialize one value at nesting `indent` (the indent of this value's own tag).
function plistValue(v, indent) {
  if (Buffer.isBuffer(v)) return dataElement(v, indent);
  if (typeof v === 'string') return '<string>' + xmlEscape(v) + '</string>';
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (typeof v === 'number') return plistNumber(v);
  if (v instanceof Date) return '<date>' + v.toISOString().replace(/\.\d{3}Z$/, 'Z') + '</date>';
  if (Array.isArray(v)) {
    if (v.length === 0) return '<array/>';
    let out = '<array>\n';
    for (const el of v) out += tabs(indent + 1) + plistValue(el, indent + 1) + '\n';
    return out + tabs(indent) + '</array>';
  }
  if (isPlainDict(v)) {
    const keys = Object.keys(v).sort(ordinal);
    if (keys.length === 0) return '<dict/>';
    let out = '<dict>\n';
    for (const k of keys) {
      out += tabs(indent + 1) + '<key>' + xmlEscape(k) + '</key>\n';
      out += tabs(indent + 1) + plistValue(v[k], indent + 1) + '\n';
    }
    return out + tabs(indent) + '</dict>';
  }
  return '<string>' + xmlEscape(v) + '</string>';
}

function appleXmlPlist(dict) {
  return PLIST_HEADER + plistValue(dict, 0) + '\n</plist>\n';
}

// Prefix every top-level key with org_safeexambrowser_SEB_ (nested keys keep their names).
function prefixedSettings(sebSettings) {
  const eff = effectiveSettings(sebSettings);
  const out = {};
  for (const k of Object.keys(eff)) out[SEB_PREFIX + k] = eff[k];
  return out;
}

function computeBrowserExamKey(sebSettings) {
  const eff = effectiveSettings(sebSettings);
  const salt = Buffer.isBuffer(eff.examKeySalt) ? eff.examKeySalt : Buffer.alloc(0);
  const xml = appleXmlPlist(prefixedSettings(sebSettings));
  return crypto.createHmac('sha256', salt).update(Buffer.from(xml, 'utf8')).digest('hex');
}

// ===========================================================================
// Per-URL request hash (SEBBrowserController.m:615,642).
//   SHA256( urlWithoutFragment + lowercaseHex(rawKey) )
// keyHex is the 64-char hex Config Key / Browser Exam Key.
// ===========================================================================
function stripFragment(u) {
  const i = u.indexOf('#');
  return i === -1 ? u : u.slice(0, i);
}
function perUrlHash(url, keyHex) {
  const s = stripFragment(url) + keyHex;
  return crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

// Compute both keys for a parsed .seb settings object.
// Returns { configKey, browserExamKey, usedDefaults } (hex strings).
function computeKeys(sebSettings) {
  return {
    configKey: computeConfigKey(sebSettings),
    browserExamKey: computeBrowserExamKey(sebSettings),
    usedDefaults: haveDefaults()
  };
}

module.exports = {
  computeConfigKey,
  computeBrowserExamKey,
  computeKeys,
  perUrlHash,
  configKeyJson,
  appleXmlPlist,
  effectiveSettings,
  haveDefaults,
  SEB_PREFIX
};
