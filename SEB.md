# Safe Exam Browser (SEB) impersonation

This sandbox can open `.seb` configuration files and present itself to an LMS/exam webapp as a
genuine **Safe Exam Browser** session. It is a security-testing feature: it lets you check how well
an exam platform can tell a real SEB apart from a spoofed one.

When SEB mode is active the app:

1. **Opens the exam** carried by a `.seb` file (its `startURL`).
2. **Advertises the SEB user-agent** — the exact token sequence SEB appends:
   `… Chrome/<real> Safari/537.36 SEB/<version> SEB/3.5.4 SEB/3.6 SEB/3.6.1`.
   The Chromium base is kept (SEB on Windows is Chromium-based too) so the JS engine stays
   consistent with the advertised UA.
3. **Sends the SEB integrity headers** on every request:
   `X-SafeExamBrowser-ConfigKeyHash` and `X-SafeExamBrowser-RequestHash`
   (each = `SHA256(requestURL-without-fragment + keyHex)`).
4. **Exposes the SEB JavaScript API** — `window.SafeExamBrowser` with
   `.version` and `.security.{ browserExamKey, configKey, appVersion, updateKeys(cb) }`.
   `updateKeys()` fills in the per-URL hashes exactly as the headers do.

## Opening a `.seb` file

- **Double-click** a `.seb` (after packaging, the file association is registered), or
- **SEB → Open SEB Config…** in the menu (⌘O), or
- **Dev / scripted:** `npm start -- /path/to/exam.seb`, or `STEALTH_INTERVIEW_SEB=/path/to/exam.seb npm start`, or
- **`seb://` / `sebs://` links** (downloaded over http / https).

Opening a `.seb` parses it, derives the keys, persists the SEB state, and relaunches so everything
applies from process start. Use **SEB → Exit SEB mode** to go back to normal.

### Supported `.seb` encryption
- Unencrypted XML plist (`<?xml…`) and plain gzipped (`plnd`).
- Password-encrypted (`pswd`) — prompts for the exam password.
- Configuring-client (`pwcc`) — tries the empty admin password, else prompts.
- **Not** supported: certificate/identity-encrypted (`pkhs`) — needs a private key in the keychain.

## The Config Key and Browser Exam Key

Both hashes are reproducible from the `.seb` alone (they do **not** depend on the real SEB binary):

- **Config Key** = `SHA256(canonicalJSON(effectiveSettings))`
- **Browser Exam Key** = `HMAC-SHA256(key = examKeySalt, msg = appleXmlPlist(effectiveSettings))`

where `effectiveSettings` = SEB's built-in defaults (`src/seb-defaults.json`, 337 keys) merged with
the keys in the `.seb`. This mirrors seb-mac's `SEBCryptor.m` and the macOS XML-plist byte format.

**Verify before you trust auto-derivation.** Upload the same `.seb` to your LMS (Moodle's SEB quiz
settings shows the expected Config Key) or run the real SEB, and compare:

```bash
node scripts/seb-keycheck.js /path/to/exam.seb                 # prints both keys
node scripts/seb-keycheck.js /path/to/exam.seb --json --plist  # also dumps the hashed input
```

If a value doesn't match, set the ground-truth key directly (this overrides derivation) in
`userData/settings.json`:

```json
{ "sebConfigKey": "<64-hex>", "sebBrowserExamKey": "<64-hex>" }
```

The app never sends a key it doesn't have — if neither an override nor a derived value is available,
the corresponding header is simply omitted (never a wrong guess).

## Settings keys

`sebMode` (bool), `sebVersion` (string, default `"3.7"`), `sebStartUrl`, `sebFile`,
`sebConfigKey`, `sebBrowserExamKey` (64-hex overrides). Layered as
`DEFAULTS ← config.json ← userData/settings.json`, same as the rest of the app.

## Test fixtures

```bash
node scripts/make-seb-fixtures.js   # writes test/fixtures/{plain,pw}.seb (pw password: test1234)
```

## Honesty — residual detectable signals

Perfect undetectability is **not** achievable, and this list is deliberately explicit:

- **Mac hardware/OS leaks.** We present as a Chromium-based SEB, but on a Mac the WebGL renderer
  (`WEBGL_debug_renderer_info` → Apple GPU), `navigator.platform` (`MacIntel`), fonts and timezone
  still read macOS. A detector correlating "SEB" with Windows-class hardware could notice. A future
  "present as Windows SEB" mode (spoofing platform + WebGL) is out of scope here.
- **Key byte-exactness.** The Config Key / Browser Exam Key are reproduced from a 337-key defaults
  table and an exact serialization; if the target `.seb` uses settings whose default we got wrong,
  or an integer-vs-real edge case, the hash differs and a key-checking LMS rejects the session. This
  is why cross-checking (above) and the manual override exist.
- **`window.webkit` absence.** macOS SEB routes `updateKeys` through `window.webkit.messageHandlers`,
  which does not exist in Chromium; ours computes locally (consistent with Windows SEB, which also
  lacks `window.webkit`). `SafeExamBrowser.security.updateKeys.toString()` therefore differs from any
  specific SEB build's source.
- **No OS lockdown.** Real SEB locks down the operating system (kiosk, process blocking, clipboard,
  screen capture). This tool only spoofs the browser-visible signals.
- **Everything the base sandbox already can't hide** (see the project's other limitations): timer
  throttling when truly backgrounded, media-pipeline timing, out-of-process cross-origin iframes,
  and server-side bot signals (TLS/JA3, IP reputation).
