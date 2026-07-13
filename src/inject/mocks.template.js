// mocks.template.js — the four mocks, executed in the MAIN world BEFORE the site's scripts.
//
// This is NOT a Node module: it is concatenated by src/inject/build.js after stealth.js
// into a single IIFE. Available in scope: __CFG__, defineNative(), maskFunction(),
// replaceMethod().
//
// Stealth note: injected via Page.addScriptToEvaluateOnNewDocument, it runs in EVERY frame
// (including same-process iframes) before their scripts, closing the classic "read the raw
// values from an iframe" bypass. Only out-of-process cross-origin iframes and timing
// side-channels remain out of reach (see README).

var M = __CFG__.mocks || {};

/* ============================================================================
 * (a) WEBCAM — captureStream fallback (only if webcamFallbackCaptureStream=true).
 *     With the Chromium flags (--use-file-for-fake-video-capture) getUserMedia stays
 *     NATIVE and already returns the looping video: no override -> maximum stealth.
 * ========================================================================== */
if (M.webcam && __CFG__.webcamFallbackCaptureStream &&
    typeof navigator !== 'undefined' && navigator.mediaDevices) {

  var __realGUM = navigator.mediaDevices.getUserMedia
    ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    : null;
  var __sharedVideo = null;

  var __ensureVideo = function () {
    if (__sharedVideo) return __sharedVideo;
    var v = document.createElement('video');
    v.src = __CFG__.webcamVideoUrl;
    v.loop = true;
    v.muted = true;
    v.defaultMuted = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    v.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;';
    var mount = function () { (document.body || document.documentElement).appendChild(v); };
    if (document.body || document.documentElement) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
    __sharedVideo = v;
    return v;
  };

  var __fakeGUM = function getUserMedia(constraints) {
    constraints = constraints || {};
    if (constraints.video) {
      var v = __ensureVideo();
      return v.play().catch(function () {}).then(function () {
        var stream = v.captureStream ? v.captureStream() : (v.mozCaptureStream ? v.mozCaptureStream() : null);
        if (!stream) throw new DOMException('captureStream not available', 'NotReadableError');
        if (!constraints.audio) {
          stream.getAudioTracks().forEach(function (t) { stream.removeTrack(t); });
        }
        return stream;
      });
    }
    return __realGUM ? __realGUM(constraints)
      : Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
  };

  if (navigator.mediaDevices.getUserMedia) {
    replaceMethod(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', __fakeGUM, 'getUserMedia');
  }

  // enumerateDevices: guarantee at least one visible videoinput.
  if (navigator.mediaDevices.enumerateDevices) {
    var __realEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    var __fakeEnum = function enumerateDevices() {
      return __realEnum().then(function (list) {
        var hasCam = list.some(function (d) { return d.kind === 'videoinput'; });
        if (hasCam) return list;
        return list.concat([{
          deviceId: 'default', kind: 'videoinput',
          label: 'FaceTime HD Camera', groupId: 'fake-group',
          toJSON: function () { return this; }
        }]);
      });
    };
    replaceMethod(Object.getPrototypeOf(navigator.mediaDevices), 'enumerateDevices', __fakeEnum, 'enumerateDevices');
  }
}

/* ============================================================================
 * (b) SINGLE MONITOR — hide the additional displays.
 * ========================================================================== */
if (M.singleMonitor && typeof screen !== 'undefined') {

  if (typeof Screen !== 'undefined' && 'isExtended' in Screen.prototype) {
    defineNative(Screen.prototype, 'isExtended', function () { return false; });
  }

  if (typeof window !== 'undefined' && typeof window.getScreenDetails === 'function') {
    var __realGSD = window.getScreenDetails.bind(window);

    var __buildPlainDetails = function () {
      var s = window.screen;
      var only = {
        availWidth: s.availWidth, availHeight: s.availHeight,
        width: s.width, height: s.height,
        colorDepth: s.colorDepth, pixelDepth: s.pixelDepth,
        availLeft: 0, availTop: 0, left: 0, top: 0,
        orientation: s.orientation || null,
        isExtended: false, isPrimary: true, isInternal: true,
        devicePixelRatio: window.devicePixelRatio, label: ''
      };
      var noop = function () {};
      return {
        screens: [only],
        currentScreen: only,
        oncurrentscreenchange: null,
        onscreenschange: null,
        addEventListener: maskFunction(function addEventListener() {}, 'addEventListener'),
        removeEventListener: maskFunction(function removeEventListener() {}, 'removeEventListener'),
        dispatchEvent: maskFunction(function dispatchEvent() { return false; }, 'dispatchEvent')
      };
    };

    var __fakeGSD = function getScreenDetails() {
      // Prefer the real object (genuine ScreenDetails/ScreenDetailed instances -> instanceof ok)
      // while exposing only the current screen. Fall back to the synthetic object if the
      // real one is unavailable (e.g. it requires a not-yet-occurred user gesture).
      try {
        return __realGSD().then(function (real) {
          try {
            var only = real.currentScreen;
            return new Proxy(real, {
              get: function (t, p) {
                if (p === 'screens') return [only];
                if (p === 'isExtended') return false;
                var val = t[p];
                return typeof val === 'function' ? val.bind(t) : val;
              }
            });
          } catch (e) {
            return __buildPlainDetails();
          }
        }, function () {
          return __buildPlainDetails();
        });
      } catch (e) {
        return Promise.resolve(__buildPlainDetails());
      }
    };
    replaceMethod(window, 'getScreenDetails', __fakeGSD, 'getScreenDetails');
  }
}

/* ============================================================================
 * (c) FULLSCREEN — the site believes it is fullscreen.
 *     When the window is truly fullscreen (see main.js) innerWidth/innerHeight match
 *     screen.* naturally; here we force the STATE of the Fullscreen API.
 * ========================================================================== */
if (M.fullscreen && typeof document !== 'undefined') {
  var DP = (typeof Document !== 'undefined') ? Document.prototype : Object.getPrototypeOf(document);

  defineNative(DP, 'fullscreenElement', function () { return document.documentElement; });
  defineNative(DP, 'fullscreenEnabled', function () { return true; });
  if ('webkitFullscreenElement' in DP) {
    defineNative(DP, 'webkitFullscreenElement', function () { return document.documentElement; });
  }
  if ('webkitFullscreenEnabled' in DP) {
    defineNative(DP, 'webkitFullscreenEnabled', function () { return true; });
  }
  if ('webkitIsFullScreen' in DP) {
    defineNative(DP, 'webkitIsFullScreen', function () { return true; });
  }

  // matchMedia: force display-mode fullscreen/standalone to matches:true.
  if (typeof window !== 'undefined' && window.matchMedia) {
    var __realMM = window.matchMedia.bind(window);
    var __fakeMM = function matchMedia(query) {
      var mql = __realMM(query);
      if (/display-mode\s*:\s*fullscreen/i.test(query) || /display-mode\s*:\s*standalone/i.test(query)) {
        try {
          Object.defineProperty(mql, 'matches', {
            get: maskFunction(function () { return true; }, 'get matches', 0),
            configurable: true, enumerable: true
          });
        } catch (e) {}
      }
      return mql;
    };
    replaceMethod(window, 'matchMedia', __fakeMM, 'matchMedia');
  }

  // Windowed but "looks" fullscreen: align the reported dimensions to those of the screen,
  // so heuristic checks (innerHeight === screen.height, absence of chrome, position at 0,0)
  // are also consistent with fullscreen. Active only if the window is NOT really fullscreen
  // (see realFullscreen).
  if (__CFG__.spoofFullscreenDims && typeof window !== 'undefined') {
    var __scrW = function () { return window.screen.width; };
    var __scrH = function () { return window.screen.height; };
    defineWindowNative('innerWidth', __scrW);
    defineWindowNative('innerHeight', __scrH);
    defineWindowNative('outerWidth', __scrW);
    defineWindowNative('outerHeight', __scrH);
    defineWindowNative('screenX', function () { return 0; });
    defineWindowNative('screenY', function () { return 0; });
    defineWindowNative('screenLeft', function () { return 0; });
    defineWindowNative('screenTop', function () { return 0; });
    if (typeof Screen !== 'undefined') {
      // In fullscreen the available area matches the whole screen (no dock/menu).
      defineNative(Screen.prototype, 'availWidth', function () { return window.screen.width; });
      defineNative(Screen.prototype, 'availHeight', function () { return window.screen.height; });
      if ('availLeft' in Screen.prototype) defineNative(Screen.prototype, 'availLeft', function () { return 0; });
      if ('availTop' in Screen.prototype) defineNative(Screen.prototype, 'availTop', function () { return 0; });
    }
  }
}

/* ============================================================================
 * (d) ALWAYS-ACTIVE TAB — never hidden, never defocused.
 * ========================================================================== */
if (M.alwaysActive && typeof document !== 'undefined') {
  var DP2 = (typeof Document !== 'undefined') ? Document.prototype : Object.getPrototypeOf(document);

  defineNative(DP2, 'visibilityState', function () { return 'visible'; });
  defineNative(DP2, 'hidden', function () { return false; });
  if ('webkitVisibilityState' in DP2) {
    defineNative(DP2, 'webkitVisibilityState', function () { return 'visible'; });
  }
  if ('webkitHidden' in DP2) {
    defineNative(DP2, 'webkitHidden', function () { return false; });
  }

  replaceMethod(DP2, 'hasFocus', function hasFocus() { return true; }, 'hasFocus');

  // Suppression in the CAPTURE phase: registered first (before the site's scripts), these
  // stop the event before it reaches the page's listeners and onX handlers.
  var __swallow = function (e) {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };
  ['visibilitychange', 'webkitvisibilitychange', 'blur', 'focusout', 'pagehide', 'freeze']
    .forEach(function (type) {
      try { document.addEventListener(type, __swallow, true); } catch (e) {}
      try { window.addEventListener(type, __swallow, true); } catch (e) {}
    });
}

/* ============================================================================
 * (e) USER-AGENT CLIENT HINTS — hide the "Electron" brand on the JS side.
 *     The navigator.userAgent string and headers are already handled in the main process;
 *     here we fix up navigator.userAgentData (brands + getHighEntropyValues).
 * ========================================================================== */
if (__CFG__.ua && typeof navigator !== 'undefined' && navigator.userAgentData) {
  var __uaMajor = __CFG__.ua.major;
  var __uaFull = __CFG__.ua.full;
  var __mkBrands = function () {
    return [
      { brand: 'Chromium', version: __uaMajor },
      { brand: 'Google Chrome', version: __uaMajor },
      { brand: 'Not?A_Brand', version: '99' }
    ];
  };
  var __mkFullBrands = function () {
    return [
      { brand: 'Chromium', version: __uaFull },
      { brand: 'Google Chrome', version: __uaFull },
      { brand: 'Not?A_Brand', version: '99.0.0.0' }
    ];
  };
  try {
    var __uadProto = Object.getPrototypeOf(navigator.userAgentData);
    defineNative(__uadProto, 'brands', function () { return __mkBrands(); });

    var __realGHEV = navigator.userAgentData.getHighEntropyValues.bind(navigator.userAgentData);
    var __fakeGHEV = function getHighEntropyValues(hints) {
      return __realGHEV(hints).then(function (res) {
        if (res && typeof res === 'object') {
          if ('brands' in res) res.brands = __mkBrands();
          if ('fullVersionList' in res) res.fullVersionList = __mkFullBrands();
          if ('uaFullVersion' in res) res.uaFullVersion = __uaFull;
        }
        return res;
      });
    };
    replaceMethod(__uadProto, 'getHighEntropyValues', __fakeGHEV, 'getHighEntropyValues');
  } catch (e) {}
}

/* ============================================================================
 * (f) SAFE EXAM BROWSER JS API — expose window.SafeExamBrowser for LMS probes.
 *     Mirrors seb-mac's injected object (SEBAbstractModernWebView.swift:73-89). Keys start
 *     empty and are filled per-URL when the page calls security.updateKeys(cb), matching SEB.
 *     Each hash is SHA256(location-without-fragment + rawKeyHex), identical to the request
 *     headers set in the main process.
 * ========================================================================== */
if (__CFG__.seb && __CFG__.seb.enabled && typeof window !== 'undefined') {
  (function () {
    var SEB = __CFG__.seb;
    var appVersion = SEB.version || '3.7';

    var __stripFrag = function (u) { var i = u.indexOf('#'); return i === -1 ? u : u.slice(0, i); };
    var __sha256hex = function (str) {
      // Requires SubtleCrypto (present on https / localhost — where exams run).
      if (!(window.crypto && window.crypto.subtle && window.TextEncoder)) return Promise.resolve('');
      var bytes = new TextEncoder().encode(str);
      return window.crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
        var arr = new Uint8Array(buf), hex = '';
        for (var i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
        return hex;
      });
    };

    var api = {
      version: appVersion,
      security: {
        browserExamKey: '',
        configKey: '',
        appVersion: appVersion,
        updateKeys: function updateKeys(callback) {
          var target = __stripFrag(location.href);
          var jobs = [];
          if (SEB.browserExamKey) {
            jobs.push(__sha256hex(target + SEB.browserExamKey).then(function (h) { api.security.browserExamKey = h; }));
          }
          if (SEB.configKey) {
            jobs.push(__sha256hex(target + SEB.configKey).then(function (h) { api.security.configKey = h; }));
          }
          var invoke = function () {
            if (typeof callback === 'function') { try { callback(); } catch (e) {} }
            else if (typeof callback === 'string' && typeof window[callback] === 'function') { try { window[callback](); } catch (e) {} }
          };
          Promise.all(jobs).then(invoke, invoke);
          return true;
        }
      }
    };

    try {
      Object.defineProperty(window, 'SafeExamBrowser', {
        value: api, writable: true, configurable: true, enumerable: true
      });
    } catch (e) {
      try { window.SafeExamBrowser = api; } catch (e2) {}
    }
  })();
}
