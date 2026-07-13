#!/usr/bin/env node
/*
 * extract-seb-defaults.js
 *
 * Extracts Safe Exam Browser's default settings (the `rootSettings` dictionary)
 * from Classes/ConfigFiles/SEBSettings.m and writes them as a flat JSON object
 * to src/seb-defaults.json.
 *
 * Build configuration assumed:
 *   - macOS build   -> TARGET_OS_OSX = 1, TARGET_OS_IPHONE = 0
 *   - RELEASE build -> DEBUG undefined  (#ifdef DEBUG takes #else)
 *
 * Objective-C literal -> JSON rules:
 *   @YES/@NO -> true/false, @123/@0 -> number, @"text" -> string,
 *   [NSNumber numberWithLong/Int/Integer:X] -> number(X),
 *   [NSNumber numberWithDouble/Float:X] -> number(X),
 *   [NSArray array]/[NSMutableArray array]/@[] -> [],
 *   [NSDictionary dictionary]/[NSMutableDictionary new]/@{} -> {},
 *   [NSData data] -> {"__data__": ""},
 *   named constants -> resolved to their integer/string value from the headers.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SEB = path.join(REPO, 'seb-mac-main');
const CLASSES = path.join(SEB, 'Classes');
const SETTINGS_M = path.join(CLASSES, 'ConfigFiles', 'SEBSettings.m');
const OUT = path.join(REPO, 'src', 'seb-defaults.json');

// ---------------------------------------------------------------------------
// Preprocessor defines for a macOS RELEASE build.
// ---------------------------------------------------------------------------
const PP_DEFINES = {
    TARGET_OS_OSX: 1,
    TARGET_OS_OSX_INCLUDED: 1,
    TARGET_OS_MAC: 1,
    TARGET_OS_IPHONE: 0,
    TARGET_OS_IOS: 0,
    TARGET_OS_MACCATALYST: 0,
    TARGET_OS_SIMULATOR: 0,
    TARGET_OS_WATCH: 0,
    TARGET_OS_TV: 0,
    // DEBUG intentionally NOT defined (release build).
};

const unresolved = [];

// ---------------------------------------------------------------------------
// Comment stripping (string-aware).
// ---------------------------------------------------------------------------
function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];
        // Objective-C string literal @"..." or plain "..."
        if (c === '"') {
            out += c;
            i++;
            while (i < n) {
                out += src[i];
                if (src[i] === '\\') { out += src[i + 1] || ''; i += 2; continue; }
                if (src[i] === '"') { i++; break; }
                i++;
            }
            continue;
        }
        // line comment
        if (c === '/' && c2 === '/') {
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        // block comment (preserve newlines to keep line structure)
        if (c === '/' && c2 === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') out += '\n';
                i++;
            }
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Preprocessor conditional resolution (line based).
// Handles #if / #ifdef / #ifndef / #elif / #else / #endif.
// ---------------------------------------------------------------------------
function evalPPExpr(expr) {
    // replace defined(X) and defined X
    expr = expr.replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g,
        (_, name) => (Object.prototype.hasOwnProperty.call(PP_DEFINES, name) ? '1' : '0'));
    expr = expr.replace(/defined\s+([A-Za-z_]\w*)/g,
        (_, name) => (Object.prototype.hasOwnProperty.call(PP_DEFINES, name) ? '1' : '0'));
    // replace identifiers with their numeric define value (undefined -> 0)
    expr = expr.replace(/[A-Za-z_]\w*/g, (name) => {
        if (Object.prototype.hasOwnProperty.call(PP_DEFINES, name)) return String(PP_DEFINES[name]);
        return '0';
    });
    // now expr should be a numeric/boolean C expression
    // translate C operators that differ from JS: none really; && || ! == etc are fine.
    // strip any stray characters that are not part of a numeric expression
    if (!/^[\d\s()!<>=&|+\-*/%^~.]*$/.test(expr)) {
        return false; // be conservative
    }
    try {
        // eslint-disable-next-line no-new-func
        const v = Function('"use strict"; return (' + (expr.trim() || '0') + ');')();
        return !!v;
    } catch (e) {
        return false;
    }
}

function resolvePreprocessor(src) {
    const lines = src.split('\n');
    const out = [];
    // stack entries: { parentActive, taken (some branch taken), active (current branch active) }
    const stack = [];
    const currentlyActive = () => stack.every((s) => s.active);

    for (const line of lines) {
        const m = line.match(/^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b(.*)$/);
        if (!m) {
            if (currentlyActive()) out.push(line);
            continue;
        }
        const directive = m[1];
        const rest = m[2].trim();
        if (directive === 'ifdef' || directive === 'ifndef' || directive === 'if') {
            const parentActive = currentlyActive();
            let cond;
            if (directive === 'ifdef') {
                cond = Object.prototype.hasOwnProperty.call(PP_DEFINES, rest);
            } else if (directive === 'ifndef') {
                cond = !Object.prototype.hasOwnProperty.call(PP_DEFINES, rest);
            } else {
                cond = evalPPExpr(rest);
            }
            const active = parentActive && cond;
            stack.push({ parentActive, taken: active, active });
        } else if (directive === 'elif') {
            const top = stack[stack.length - 1];
            if (!top) continue;
            if (top.taken || !top.parentActive) {
                top.active = false;
            } else {
                const cond = evalPPExpr(rest);
                top.active = cond;
                if (cond) top.taken = true;
            }
        } else if (directive === 'else') {
            const top = stack[stack.length - 1];
            if (!top) continue;
            if (top.taken || !top.parentActive) {
                top.active = false;
            } else {
                top.active = true;
                top.taken = true;
            }
        } else if (directive === 'endif') {
            stack.pop();
        }
        // directive lines themselves are never emitted
    }
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Constant resolution table built from the SEB headers.
// ---------------------------------------------------------------------------
function collectHeaderFiles(dir, acc) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) collectHeaderFiles(p, acc);
        else if (entry.isFile() && entry.name.endsWith('.h')) acc.push(p);
    }
    return acc;
}

// raw definitions: name -> { kind: 'num'|'str'|'expr', value }
const rawDefs = new Map();

function addRaw(name, def) {
    if (!rawDefs.has(name)) rawDefs.set(name, def);
}

function buildConstantTable() {
    const headers = collectHeaderFiles(CLASSES, []);
    for (const file of headers) {
        let src = fs.readFileSync(file, 'utf8');
        src = stripComments(src);

        // #define NAME VALUE  (single-line, value = rest of line)
        const defineRe = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+(.+?)[ \t]*$/gm;
        let m;
        while ((m = defineRe.exec(src)) !== null) {
            const name = m[1];
            let val = m[2].trim();
            // function-like macros: skip (name followed by '(') handled by regex requiring space
            const strM = val.match(/^@?"((?:[^"\\]|\\.)*)"$/);
            if (strM) { addRaw(name, { kind: 'str', value: unescapeC(strM[1]) }); continue; }
            addRaw(name, { kind: 'expr', value: val });
        }

        // static ... *NAME = @"...";  (string constants)
        const staticStrRe = /static[^\n;]*?\*\s*([A-Za-z_]\w*)\s*=\s*@?"((?:[^"\\]|\\.)*)"\s*;/g;
        while ((m = staticStrRe.exec(src)) !== null) {
            addRaw(m[1], { kind: 'str', value: unescapeC(m[2]) });
        }

        // static NSInteger/NSUInteger/etc NAME = EXPR;  (numeric constants, no pointer)
        const staticNumRe = /static\s+(?:const\s+)?(?:NS(?:U?Integer)|int|long|NSUInteger|CGFloat|double|float)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
        while ((m = staticNumRe.exec(src)) !== null) {
            if (rawDefs.has(m[1])) continue;
            addRaw(m[1], { kind: 'expr', value: m[2].trim() });
        }

        // enum blocks (enum {...} and NS_ENUM/NS_OPTIONS(type, Name) {...})
        parseEnums(src);
    }
}

function parseEnums(src) {
    const enumRe = /(?:typedef\s+)?(?:enum|NS_ENUM|NS_OPTIONS|NS_CLOSED_ENUM)\b[^{]*\{/g;
    let m;
    while ((m = enumRe.exec(src)) !== null) {
        const open = enumRe.lastIndex - 1; // position of '{'
        // find matching '}'
        let depth = 0, i = open, end = -1;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) continue;
        const body = src.slice(open + 1, end);
        assignEnumMembers(body);
        enumRe.lastIndex = end + 1;
    }
}

function assignEnumMembers(body) {
    // split members by top-level commas (no nested braces expected inside enum members)
    const members = splitTopLevel(body, ',');
    let counter = 0;
    for (let raw of members) {
        raw = raw.trim();
        if (!raw) continue;
        const eq = raw.indexOf('=');
        if (eq >= 0) {
            const name = raw.slice(0, eq).trim();
            const expr = raw.slice(eq + 1).trim();
            if (!/^[A-Za-z_]\w*$/.test(name)) continue;
            addRaw(name, { kind: 'expr', value: expr });
            const val = tryResolveNumber(expr);
            counter = (val === null || Number.isNaN(val)) ? counter + 1 : val + 1;
        } else {
            const name = raw.trim();
            if (!/^[A-Za-z_]\w*$/.test(name)) continue;
            addRaw(name, { kind: 'num', value: counter });
            counter += 1;
        }
    }
}

function splitTopLevel(str, sep) {
    const parts = [];
    let depth = 0, cur = '';
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        if (c === sep && depth === 0) { parts.push(cur); cur = ''; }
        else cur += c;
    }
    if (cur.trim() !== '' || parts.length) parts.push(cur);
    return parts;
}

function unescapeC(s) {
    return s.replace(/\\(.)/g, (_, ch) => {
        switch (ch) {
            case 'n': return '\n';
            case 't': return '\t';
            case 'r': return '\r';
            case '"': return '"';
            case '\\': return '\\';
            default: return ch;
        }
    });
}

// resolve a constant NAME to {type,value}; memoized with cycle guard.
const resolvedCache = new Map();
function resolveConstant(name, seen) {
    if (resolvedCache.has(name)) return resolvedCache.get(name);
    seen = seen || new Set();
    if (seen.has(name)) return null;
    seen.add(name);
    const def = rawDefs.get(name);
    if (!def) return null;
    let result;
    if (def.kind === 'str') result = { type: 'string', value: def.value };
    else if (def.kind === 'num') result = { type: 'number', value: def.value };
    else {
        const v = evalConstExpr(def.value, seen);
        result = v;
    }
    if (result) resolvedCache.set(name, result);
    return result;
}

// evaluate a numeric/const expression -> {type,value} or null
function evalConstExpr(expr, seen) {
    expr = expr.trim();
    // pure integer
    if (/^[-+]?\d+$/.test(expr)) return { type: 'number', value: parseInt(expr, 10) };
    // pure float
    if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?[fFlL]?$/.test(expr)) {
        return { type: 'number', value: parseFloat(expr) };
    }
    // hex
    if (/^0[xX][0-9a-fA-F]+$/.test(expr)) return { type: 'number', value: parseInt(expr, 16) };
    // single identifier
    if (/^[A-Za-z_]\w*$/.test(expr)) {
        const r = resolveConstant(expr, seen);
        return r;
    }
    // arithmetic / bit expression: resolve identifiers then eval
    if (/^[\w\s()+\-*/%<>|&^~.]+$/.test(expr)) {
        let replaced = expr.replace(/[A-Za-z_]\w*/g, (id) => {
            const r = resolveConstant(id, new Set(seen));
            if (r && r.type === 'number') return '(' + r.value + ')';
            return 'NaN';
        });
        // strip C numeric suffixes
        replaced = replaced.replace(/(\d)[fFlLuU]+/g, '$1');
        if (/NaN/.test(replaced)) return null;
        try {
            // eslint-disable-next-line no-new-func
            const v = Function('"use strict"; return (' + replaced + ');')();
            if (typeof v === 'number' && !Number.isNaN(v)) return { type: 'number', value: v };
        } catch (e) { /* ignore */ }
    }
    return null;
}

function tryResolveNumber(expr) {
    const r = evalConstExpr(expr, new Set());
    return r && r.type === 'number' ? r.value : null;
}

// ---------------------------------------------------------------------------
// Objective-C literal tokenizer + parser.
// ---------------------------------------------------------------------------
function tokenize(src) {
    const tokens = [];
    let i = 0;
    const n = src.length;
    const isIdentStart = (c) => /[A-Za-z_]/.test(c);
    const isIdent = (c) => /[A-Za-z0-9_]/.test(c);
    const isDigit = (c) => /[0-9]/.test(c);

    while (i < n) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }

        if (c === '@') {
            const c2 = src[i + 1];
            if (c2 === '"') {
                // @"..." string
                i += 2;
                let s = '';
                while (i < n && src[i] !== '"') {
                    if (src[i] === '\\') { s += src[i] + (src[i + 1] || ''); i += 2; continue; }
                    s += src[i]; i++;
                }
                i++; // closing quote
                tokens.push({ t: 'string', v: unescapeC(s) });
                continue;
            }
            if (c2 === '[') { tokens.push({ t: '@[' }); i += 2; continue; }
            if (c2 === '{') { tokens.push({ t: '@{' }); i += 2; continue; }
            // @YES / @NO / @<number>
            if (isIdentStart(c2)) {
                let j = i + 1; let id = '';
                while (j < n && isIdent(src[j])) { id += src[j]; j++; }
                i = j;
                if (id === 'YES') tokens.push({ t: 'bool', v: true });
                else if (id === 'NO') tokens.push({ t: 'bool', v: false });
                else if (id === 'true') tokens.push({ t: 'bool', v: true });
                else if (id === 'false') tokens.push({ t: 'bool', v: false });
                else tokens.push({ t: 'ident', v: id }); // e.g. @SomeConst (rare)
                continue;
            }
            if (isDigit(c2) || c2 === '.' || c2 === '-') {
                let j = i + 1; let num = '';
                while (j < n && /[0-9.\-+eExXa-fA-F]/.test(src[j])) { num += src[j]; j++; }
                i = j;
                tokens.push({ t: 'number', v: parseNumberLiteral(num) });
                continue;
            }
            // lone @
            i++;
            continue;
        }

        if (c === '"') {
            // plain C string literal
            i++;
            let s = '';
            while (i < n && src[i] !== '"') {
                if (src[i] === '\\') { s += src[i] + (src[i + 1] || ''); i += 2; continue; }
                s += src[i]; i++;
            }
            i++;
            tokens.push({ t: 'string', v: unescapeC(s) });
            continue;
        }

        if (c === '[') { tokens.push({ t: '[' }); i++; continue; }
        if (c === ']') { tokens.push({ t: ']' }); i++; continue; }
        if (c === '{') { tokens.push({ t: '{' }); i++; continue; }
        if (c === '}') { tokens.push({ t: '}' }); i++; continue; }
        if (c === '(') { tokens.push({ t: '(' }); i++; continue; }
        if (c === ')') { tokens.push({ t: ')' }); i++; continue; }
        if (c === ',') { tokens.push({ t: ',' }); i++; continue; }
        if (c === ':') { tokens.push({ t: ':' }); i++; continue; }
        if (c === ';') { tokens.push({ t: ';' }); i++; continue; }

        if (isDigit(c) || (c === '.' && isDigit(src[i + 1])) ||
            (c === '-' && isDigit(src[i + 1]))) {
            let j = i; let num = '';
            while (j < n && /[0-9.\-+eExXa-fA-F]/.test(src[j])) { num += src[j]; j++; }
            i = j;
            tokens.push({ t: 'number', v: parseNumberLiteral(num) });
            continue;
        }

        if (isIdentStart(c)) {
            let j = i; let id = '';
            while (j < n && isIdent(src[j])) { id += src[j]; j++; }
            i = j;
            tokens.push({ t: 'ident', v: id });
            continue;
        }

        // unknown char, skip
        i++;
    }
    return tokens;
}

function parseNumberLiteral(s) {
    s = s.replace(/[fFlLuU]+$/, '');
    if (/^0[xX]/.test(s)) return parseInt(s, 16);
    if (/[.eE]/.test(s)) return parseFloat(s);
    return parseInt(s, 10);
}

// Parser -------------------------------------------------------------------
class Parser {
    constructor(tokens) { this.toks = tokens; this.pos = 0; }
    peek() { return this.toks[this.pos]; }
    next() { return this.toks[this.pos++]; }
    expect(t) {
        const tok = this.next();
        if (!tok || tok.t !== t) throw new Error('Expected ' + t + ' but got ' + JSON.stringify(tok));
        return tok;
    }

    parseValue() {
        const tok = this.peek();
        if (!tok) throw new Error('Unexpected end of tokens');
        switch (tok.t) {
            case 'bool': this.next(); return { kind: 'value', value: tok.v };
            case 'number': this.next(); return { kind: 'value', value: tok.v };
            case 'string': this.next(); return { kind: 'value', value: tok.v };
            case '@[': return this.parseArray();
            case '@{': return this.parseDict();
            case '[': return this.parseMessage();
            case 'ident': return this.parseIdent();
            default:
                throw new Error('Unexpected token in value: ' + JSON.stringify(tok));
        }
    }

    parseIdent() {
        const tok = this.next();
        if (tok.v === 'nil' || tok.v === 'NULL' || tok.v === 'Nil') {
            return { kind: 'nil' };
        }
        const r = resolveConstant(tok.v);
        if (r) return { kind: 'value', value: r.value };
        if (!unresolved.includes(tok.v)) unresolved.push(tok.v);
        // best guess: 0
        return { kind: 'value', value: 0, unresolved: true };
    }

    parseArray() {
        this.expect('@[');
        const arr = [];
        while (this.peek() && this.peek().t !== ']') {
            if (this.peek().t === ',') { this.next(); continue; }
            const v = this.parseValue();
            if (v.kind !== 'nil') arr.push(v.value);
        }
        this.expect(']');
        return { kind: 'value', value: arr };
    }

    parseDict() {
        this.expect('@{');
        const obj = {};
        while (this.peek() && this.peek().t !== '}') {
            if (this.peek().t === ',') { this.next(); continue; }
            const key = this.parseValue();
            this.expect(':');
            const val = this.parseValue();
            obj[key.value] = val.kind === 'nil' ? null : val.value;
        }
        this.expect('}');
        return { kind: 'value', value: obj };
    }

    parseMessage() {
        this.expect('[');
        const receiver = this.next(); // ident
        if (!receiver || receiver.t !== 'ident') {
            throw new Error('Expected receiver ident, got ' + JSON.stringify(receiver));
        }
        const selectorTok = this.next();
        if (!selectorTok || selectorTok.t !== 'ident') {
            throw new Error('Expected selector, got ' + JSON.stringify(selectorTok));
        }
        const selector = selectorTok.v;

        // selector with colon (has argument(s))
        if (this.peek() && this.peek().t === ':') {
            this.next(); // consume ':'
            if (/^numberWith/.test(selector) || /^initWith/.test(selector)) {
                // single numeric/bool argument
                const arg = this.parseValue();
                this.expect(']');
                if (/Bool/i.test(selector)) return { kind: 'value', value: !!arg.value };
                return { kind: 'value', value: arg.value };
            }
            if (/^dictionaryWithObjectsAndKeys/.test(selector) ||
                /^initWithObjectsAndKeys/.test(selector)) {
                // variadic: value, key, value, key, ..., nil
                const items = [];
                while (this.peek() && this.peek().t !== ']') {
                    if (this.peek().t === ',') { this.next(); continue; }
                    const v = this.parseValue();
                    items.push(v);
                }
                this.expect(']');
                // drop trailing nil
                while (items.length && items[items.length - 1].kind === 'nil') items.pop();
                const obj = {};
                for (let k = 0; k + 1 < items.length; k += 2) {
                    const value = items[k];
                    const key = items[k + 1];
                    obj[key.value] = value.kind === 'nil' ? null : value.value;
                }
                return { kind: 'value', value: obj };
            }
            if (/^arrayWithObjects/.test(selector)) {
                const items = [];
                while (this.peek() && this.peek().t !== ']') {
                    if (this.peek().t === ',') { this.next(); continue; }
                    const v = this.parseValue();
                    items.push(v);
                }
                this.expect(']');
                while (items.length && items[items.length - 1].kind === 'nil') items.pop();
                return { kind: 'value', value: items.map((x) => x.value) };
            }
            // generic: consume until matching ]
            const items = [];
            while (this.peek() && this.peek().t !== ']') {
                if (this.peek().t === ',' || this.peek().t === ':') { this.next(); continue; }
                items.push(this.parseValue());
            }
            this.expect(']');
            return { kind: 'value', value: null };
        }

        // no-argument selector
        this.expect(']');
        const recv = receiver.v;
        if (recv === 'NSData' && (selector === 'data' || selector === 'new')) {
            return { kind: 'value', value: { __data__: '' } };
        }
        if ((recv === 'NSArray' || recv === 'NSMutableArray') &&
            (selector === 'array' || selector === 'new')) {
            return { kind: 'value', value: [] };
        }
        if ((recv === 'NSDictionary' || recv === 'NSMutableDictionary') &&
            (selector === 'dictionary' || selector === 'new')) {
            return { kind: 'value', value: {} };
        }
        if ((recv === 'NSString' || recv === 'NSMutableString') &&
            (selector === 'string' || selector === 'new')) {
            return { kind: 'value', value: '' };
        }
        // fallback
        return { kind: 'value', value: null };
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
    buildConstantTable();

    let src = fs.readFileSync(SETTINGS_M, 'utf8');
    src = stripComments(src);
    src = resolvePreprocessor(src);

    // isolate the rootSettings message send:
    // find @"rootSettings", then the following '[' ... balanced ']'
    const idx = src.indexOf('@"rootSettings"');
    if (idx < 0) throw new Error('Could not find rootSettings key');
    const brStart = src.indexOf('[', idx);
    if (brStart < 0) throw new Error('Could not find rootSettings dictionary bracket');
    // balance brackets, skipping strings
    let depth = 0, i = brStart, end = -1;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '"') { // skip string
            i++;
            while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; }
            continue;
        }
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error('Unbalanced rootSettings brackets');
    const exprText = src.slice(brStart, end + 1);

    const tokens = tokenize(exprText);
    const parser = new Parser(tokens);
    const parsed = parser.parseValue();
    const result = parsed.value;

    if (typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('rootSettings did not parse to an object');
    }

    if (unresolved.length) {
        result.__unresolved__ = unresolved.slice().sort();
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');

    const keyCount = Object.keys(result).filter((k) => k !== '__unresolved__').length;
    console.log('Wrote', OUT);
    console.log('Key count:', keyCount);
    console.log('Unresolved constants:', unresolved.length ? unresolved.join(', ') : '(none)');
}

main();
