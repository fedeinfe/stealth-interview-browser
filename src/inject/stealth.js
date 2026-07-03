// stealth.js — masking helpers.
//
// This is NOT a Node module: it is CONCATENATED by src/inject/build.js into a single IIFE
// that runs in the page's MAIN world (see Page.addScriptToEvaluateOnNewDocument in main.js).
// Available in the IIFE scope: __CFG__ (config), and — after this file — the functions
// defineNative() and maskFunction() used by mocks.template.js.
//
// Goal: make the overrides indistinguishable from the browser's native code
// (Function.prototype.toString must return "[native code]") without leaving global
// artifacts on window.

// Weak registry: override function -> name to expose as native.
var __nativeNames = new WeakMap();

// Save the original toString BEFORE replacing it.
var __origToString = Function.prototype.toString;

// Patched toString: if the function is "masked" it returns the native signature,
// otherwise it delegates to the original (so real functions stay unchanged).
function __patchedToString() {
  if (__nativeNames.has(this)) {
    return 'function ' + __nativeNames.get(this) + '() { [native code] }';
  }
  return __origToString.call(this);
}

// The patched toString must look native too (defense against toString.toString()).
__nativeNames.set(__patchedToString, 'toString');

try {
  Object.defineProperty(Function.prototype, 'toString', {
    value: __patchedToString,
    writable: true,
    configurable: true,
    enumerable: false
  });
} catch (e) { /* ignore: environment that blocks the redefinition */ }

// Mark a function as "native" for toString and align its name/length.
function maskFunction(fn, name, length) {
  __nativeNames.set(fn, name || fn.name || '');
  try {
    Object.defineProperty(fn, 'name', { value: name || fn.name || '', configurable: true });
  } catch (e) {}
  if (typeof length === 'number') {
    try { Object.defineProperty(fn, 'length', { value: length, configurable: true }); } catch (e) {}
  }
  return fn;
}

// Redefine a property as a getter, preserving the original's enumerable/configurable so
// the descriptor stays consistent with the native one. `target` must be the prototype on
// which the property is actually defined (e.g. Document.prototype, Screen.prototype).
function defineNative(target, prop, getterFnOrValue) {
  var existing = Object.getOwnPropertyDescriptor(target, prop);
  var enumerable = existing ? existing.enumerable : true;
  var getter = typeof getterFnOrValue === 'function'
    ? getterFnOrValue
    : function () { return getterFnOrValue; };
  maskFunction(getter, 'get ' + prop, 0);
  try {
    Object.defineProperty(target, prop, {
      get: getter,
      configurable: true,
      enumerable: enumerable
    });
    return true;
  } catch (e) {
    return false;
  }
}

// Redefine a property on the `window` global, handling the case where it is defined on
// the window instance or on Window.prototype (this varies across Chromium versions).
function defineWindowNative(prop, getter) {
  if (typeof window === 'undefined') return false;
  var onInstance = !!Object.getOwnPropertyDescriptor(window, prop);
  var target = onInstance ? window : (Object.getPrototypeOf(window) || window);
  if (defineNative(target, prop, getter)) return true;
  // Fallback: try the other target.
  var other = onInstance ? (Object.getPrototypeOf(window) || window) : window;
  return defineNative(other, prop, getter);
}

// Replace a method on a prototype while keeping the native appearance.
function replaceMethod(target, prop, fn, name) {
  maskFunction(fn, name || prop, fn.length);
  try {
    Object.defineProperty(target, prop, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: target && Object.getOwnPropertyDescriptor(target, prop)
        ? Object.getOwnPropertyDescriptor(target, prop).enumerable
        : true
    });
    return true;
  } catch (e) {
    try { target[prop] = fn; return true; } catch (e2) { return false; }
  }
}
