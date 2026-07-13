// seb-keycheck.js — parse a .seb file and print the SEB integrity keys it yields.
//
// Use this to VERIFY the derived Config Key / Browser Exam Key against a ground truth: upload the
// same .seb to your LMS (Moodle's SEB quiz settings shows the expected Config Key) or run the real
// Safe Exam Browser. If they match, auto-derivation works; if not, set sebConfigKey /
// sebBrowserExamKey in userData/settings.json to the LMS's expected value.
//
// Usage:
//   node scripts/seb-keycheck.js path/to/file.seb [--json] [--plist]
//   node scripts/seb-keycheck.js path/to/file.seb --password 'secret'
'use strict';

const readline = require('readline');
const sebConfig = require('../src/seb-config');
const sebKeys = require('../src/seb-keys');

function promptStdin(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message + ' ', (answer) => { rl.close(); resolve(answer); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node scripts/seb-keycheck.js path/to/file.seb [--json] [--plist] [--password PW]');
    process.exit(1);
  }
  const showJson = args.includes('--json');
  const showPlist = args.includes('--plist');
  const pwIdx = args.indexOf('--password');
  const presetPw = pwIdx !== -1 ? args[pwIdx + 1] : undefined;

  let parsed;
  try {
    parsed = await sebConfig.parseSebFilePath(file, {
      password: presetPw,
      promptPassword: (m) => promptStdin(m)
    });
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }

  console.log('Encryption prefix: ', parsed.encryption);
  console.log('Start URL:         ', parsed.startURL || '(none)');
  console.log('Config purpose:    ', parsed.configPurpose);
  console.log('Settings keys:     ', Object.keys(parsed.settings).length);

  const keys = sebKeys.computeKeys(parsed.settings);
  console.log('Used bundled defaults:', keys.usedDefaults);
  console.log('Config Key:           ', keys.configKey);
  console.log('Browser Exam Key:     ', keys.browserExamKey);

  if (showJson) {
    console.log('\n--- Config Key canonical JSON ---');
    console.log(sebKeys.configKeyJson(parsed.settings));
  }
  if (showPlist) {
    console.log('\n--- Browser Exam Key plist (excerpt) ---');
    const xml = sebKeys.appleXmlPlist(require('../src/seb-keys').effectiveSettings(parsed.settings));
    console.log(xml.slice(0, 1200) + (xml.length > 1200 ? '\n... (truncated)' : ''));
  }
}

main();
