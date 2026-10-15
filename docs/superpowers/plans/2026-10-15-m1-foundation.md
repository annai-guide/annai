# Milestone 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable, offline-capable annai shell where a trip can be created, edited as files with history, exported to an archive, wiped, and imported back intact, on iOS and Android.

**Architecture:** A small core of plain ES modules (`src/core/`) holds storage, the write path with history, scopes, the plugin registry and host, zip and archive code. It never touches the DOM, so it runs under `node:test` against an in-memory store and in browsers against IndexedDB. A thin UI (`src/ui/`) built with a tiny DOM helper renders hash-routed screens. A classic service worker caches the app shell, serves installed plugin files from IndexedDB, and receives Android shares.

**Tech Stack:** Native ES modules, no build step, zero runtime dependencies. JSDoc types checked by TypeScript 6.0.3 (`tsc --checkJs`). Tests: `node:test` (Node 26) plus Playwright 1.63.0 (Chromium as Pixel 7, WebKit as iPhone 15).

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`. Milestone 1 is §20 row 1, which covers §4 (storage), §5 (plugin system), §12.1–12.3 (archives) and §17 (error handling), plus the shell parts of §16.

## Global Constraints

- Zero runtime dependencies. Dev dependencies: TypeScript (type-checking only), Playwright, and `@types/node`.
- Native ES modules with no build step; JSDoc types checked by `tsc --checkJs`.
- iOS (Safari) and Android (Chrome) are both required. Modern browsers only.
- Content Security Policy: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; img-src 'self' blob: data: https:; media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
- No `innerHTML` anywhere in app code. Never set a `style` attribute (CSP blocks it): use classes or `el.style.setProperty`.
- Every write is one transaction. Fingerprints are computed *before* the transaction opens. Nothing else is awaited inside a transaction.
- Times are stored as ISO 8601 strings with offset, plus an IANA time zone.
- Copy: plain words; system cards are never in Shiori's voice; every error says what happened and what to do next.
- Data format version `FORMAT = 1`; archive format `ARCHIVE_FORMAT = 1`; app version `0.1.0`, which is the same in `package.json`, `src/app/version.js` and `sw.js`.
- License: AGPL-3.0-only.

## Review Focus

These failure modes are implied by the spec but not covered by a feature test. Each line names the task whose tests pin it.

1. **Safari's IndexedDB connection drops after backgrounding.** The next operation should transparently reopen and succeed (Task 12: "reopens after the connection is closed").
2. **Storage fills up mid-write.** The user should get "Storage is full" with a next step, and nothing half-written (Task 6: "storage full maps to StorageFullError and writes nothing").
3. **A damaged, tampered or newer-format archive is opened.** The user should get a clear refusal and nothing imported (Task 10: "a tampered entry is refused, and nothing is imported", "an archive from a newer annai is refused").
4. **Non-ASCII names** (a trip called 京都, a file called `/notes/案内.md`). They should survive paths, zip and archive round trips byte-for-byte (Task 8: "round-trips text, binary, empty files and UTF-8 names"; Task 10: "Japanese names round-trip and file names stay readable").
5. **Saving an export on iOS after a slow encryption.** Share-sheet calls need a fresh tap, so saving must be a separate tap, not part of the export click (Task 16 e2e: the buildAndSave helper waits for a separate "Save file" tap after building).

---

## File structure

```
package.json, package-lock.json, tsconfig.json, tsconfig.sw.json, playwright.config.js
index.html, manifest.webmanifest, sw.js, _headers
assets/fonts/*.woff2 + OFL.txt, assets/icons/*.png, assets/shiori.svg
src/app/version.js        app version constant
src/app/main.js           bootstrap: lock, store, workspace, plugins, shell, service worker
src/core/bytes.js         UTF-8, hex, concat, ownBuffer
src/core/hash.js          sha256Hex
src/core/crc32.js         crc32
src/core/patch.js         JSON Merge Patch (+ "+" append extension)
src/core/paths.js         normPath, normPrefix, matchPath, typeForPath, isTextType, isCompressedType
src/core/schema.js        validate (JSON Schema subset), makeSchemaFor
src/core/types.js         JSDoc typedefs: Store, Tx, records
src/core/store-memory.js  in-memory Store
src/core/store-idb.js     IndexedDB Store, eraseDatabase
src/core/workspace.js     files with history: write, patch, delete, restore, history, list, read
src/core/scopes.js        scope ids/kinds, ensureBaseScopes, createTrip, archive/unarchive, title sync
src/core/events.js        logEvent
src/core/zip.js           ZipWriter, readZip
src/core/archive-crypto.js encrypt, decrypt, isEncrypted
src/core/archive.js       exportArchive, openArchive, describeArchive, importArchive, archiveName
src/core/registry.js      Registry
src/core/plugins.js       PluginHost, manifest schema
src/core/lock.js          single running instance (Web Locks)
src/core/settings.js      app settings in sys:settings
src/plugins/core-schemas/schemas.js, index.js   trip/plan/booking schemas as a built-in plugin
src/ui/dom.js, router.js, platform.js, notices.js, install.js, save.js, format.js, shell.js
src/ui/import-state.js, export-panel.js
src/ui/screens/trips.js, trip.js, file.js, settings.js, import.js, trace.js, plugins.js
src/ui/tokens.css, base.css
scripts/serve.mjs, scripts/headers.mjs, scripts/render-icons.mjs, scripts/size.mjs
test/unit/*.test.js       node:test
test/contract/store-contract.js   shared Store behaviour (node + browser)
test/browser/index.html, run.js, mini-test.js, suites/*.js     in-browser suites
test/e2e/*.spec.js        Playwright
test/fixtures/            infozip.zip, plugins/hello/*
.github/workflows/ci.yml
docs/testing/device-checklist-m1.md
```

---

### Task 1: Tooling, bytes, SHA-256 and CRC-32

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/core/bytes.js`, `src/core/hash.js`, `src/core/crc32.js`, `test/unit/bytes-hash-crc.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces:
  - `utf8(s: string): Uint8Array`
  - `text(b: Uint8Array|ArrayBuffer): string`
  - `toBytes(x: Uint8Array|ArrayBuffer|string): Uint8Array`
  - `hex(b: Uint8Array): string`
  - `ownBuffer(b: Uint8Array): ArrayBuffer`
  - `concat(parts: Uint8Array[]): Uint8Array`
  - `sha256Hex(data: Uint8Array|ArrayBuffer|string): Promise<string>`
  - `crc32(bytes: Uint8Array, crc?: number): number`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "annai",
  "version": "0.1.0",
  "private": true,
  "description": "annai.guide: an AI guide for your trips. Local-first, runs in the browser.",
  "license": "AGPL-3.0-only",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test \"test/unit/**/*.test.js\"",
    "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.sw.json",
    "serve": "node scripts/serve.mjs",
    "e2e": "playwright test",
    "size": "node scripts/size.mjs",
    "check": "npm run typecheck && npm test && npm run size"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@types/node": "24.x",
    "typescript": "6.0.3"
  }
}
```

Run `npm view @types/node versions --json` and replace `24.x` with the newest exact `24.*` version published at least two weeks ago. Then run `npm install`. Expected: `package-lock.json` is created and there are no errors.

- [ ] **Step 2: Create `tsconfig.json` and the service-worker variant**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": true,
    "noImplicitAny": false,
    "target": "es2023",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["es2023", "dom", "dom.iterable"],
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.js", "scripts/**/*.mjs", "test/**/*.js", "playwright.config.js"]
}
```

`tsconfig.sw.json` (the service worker runs in a different global scope):
```json
{
  "compilerOptions": {
    "allowJs": true, "checkJs": true, "noEmit": true, "strict": true, "noImplicitAny": false,
    "target": "es2023", "lib": ["es2023", "webworker"], "types": [], "skipLibCheck": true
  },
  "files": ["sw.js"]
}
```

Append to `.gitignore`:
```
test-results/
playwright-report/
.superpowers/
```

- [ ] **Step 3: Write the failing test** `test/unit/bytes-hash-crc.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../../src/core/hash.js';
import { crc32 } from '../../src/core/crc32.js';
import { utf8, text, concat, hex, toBytes, ownBuffer } from '../../src/core/bytes.js';

test('sha256 of "abc"', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256 of empty bytes', async () => {
  assert.equal(await sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256 of a subarray hashes only the view', async () => {
  const big = utf8('xxabcxx');
  assert.equal(await sha256Hex(big.subarray(2, 5)), await sha256Hex('abc'));
});

test('crc32 check value', () => {
  assert.equal(crc32(utf8('123456789')), 0xcbf43926);
});

test('crc32 running value equals one-shot', () => {
  assert.equal(crc32(utf8('56789'), crc32(utf8('1234'))), 0xcbf43926);
});

test('utf8, text and concat round-trip non-ASCII', () => {
  assert.equal(text(concat([utf8('案内'), utf8('.guide')])), '案内.guide');
});

test('hex, toBytes and ownBuffer', () => {
  assert.equal(hex(new Uint8Array([0, 15, 255])), '000fff');
  assert.deepEqual([...toBytes(new Uint8Array([1, 2]).buffer)], [1, 2]);
  const view = new Uint8Array([9, 8, 7, 6]).subarray(1, 3);
  assert.deepEqual([...new Uint8Array(ownBuffer(view))], [8, 7]);
});
```

- [ ] **Step 4: Run it and verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '.../src/core/hash.js'`.

- [ ] **Step 5: Implement `src/core/bytes.js`**

```js
// Byte helpers shared by the core. No dependencies.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @param {string} s @returns {Uint8Array} */
export function utf8(s) {
  return encoder.encode(s);
}

/** @param {Uint8Array | ArrayBuffer} b @returns {string} */
export function text(b) {
  return decoder.decode(b instanceof Uint8Array ? b : new Uint8Array(b));
}

/**
 * Normalizes byte-like input to a Uint8Array view (no copy when possible).
 * @param {Uint8Array | ArrayBuffer | string} x
 * @returns {Uint8Array}
 */
export function toBytes(x) {
  if (typeof x === 'string') return utf8(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  throw new TypeError('expected bytes or a string');
}

/** @param {Uint8Array} b @returns {string} lowercase hex */
export function hex(b) {
  let s = '';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

/**
 * Returns an ArrayBuffer holding exactly these bytes, safe to store or hand to WebCrypto.
 * @param {Uint8Array} b
 * @returns {ArrayBuffer}
 */
export function ownBuffer(b) {
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer) return b.buffer;
  return b.slice().buffer;
}

/** @param {Uint8Array[]} parts @returns {Uint8Array} */
export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
```

- [ ] **Step 6: Implement `src/core/hash.js` and `src/core/crc32.js`**

`src/core/hash.js`:
```js
import { toBytes, hex, ownBuffer } from './bytes.js';

/**
 * SHA-256 of the bytes (strings are UTF-8 encoded), as lowercase hex.
 * @param {Uint8Array | ArrayBuffer | string} data
 * @returns {Promise<string>}
 */
export async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', ownBuffer(toBytes(data)));
  return hex(new Uint8Array(digest));
}
```

`src/core/crc32.js`:
```js
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * CRC-32 (IEEE 802.3), as used by zip.
 * @param {Uint8Array} bytes
 * @param {number} [crc] running value from a previous call
 * @returns {number} unsigned 32-bit value
 */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npm test && npx tsc -p tsconfig.json`
Expected: 7 tests pass; tsc prints nothing. If tsc complains about `Uint8Array<ArrayBufferLike>` in `ownBuffer`, cast with `/** @type {ArrayBuffer} */ (...)`; don't change the behaviour.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.sw.json .gitignore src/core/bytes.js src/core/hash.js src/core/crc32.js test/unit/bytes-hash-crc.test.js
git commit -m "Add tooling and byte, SHA-256 and CRC-32 helpers"
```

---

### Task 2: JSON Merge Patch

**Files:**
- Create: `src/core/patch.js`, `test/unit/patch.test.js`

**Interfaces:**
- Produces: `mergePatch(target: any, patch: any, opts?: { append?: boolean }): any`. Returns a new value and never mutates its inputs. Unchanged nested objects may be shared with `target`. With `append: true`, a key `"k+"` appends to the array at `k` (spec §9.4).

- [ ] **Step 1: Write the failing test** `test/unit/patch.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePatch } from '../../src/core/patch.js';

// RFC 7396, Appendix A.
const RFC = [
  [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
  [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
  [{ a: 'b' }, { a: null }, {}],
  [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
  [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
  [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
  [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
  [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
  [['a', 'b'], ['c', 'd'], ['c', 'd']],
  [{ a: 'b' }, ['c'], ['c']],
  [{ a: 'foo' }, null, null],
  [{ a: 'foo' }, 'bar', 'bar'],
  [{ e: null }, { a: 1 }, { e: null, a: 1 }],
  [[1, 2], { a: 'b', c: null }, { a: 'b' }],
  [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
];

for (const [i, [target, patch, expected]] of RFC.entries()) {
  test(`RFC 7396 example ${i + 1}`, () => {
    assert.deepEqual(mergePatch(target, patch), expected);
  });
}

test('does not mutate the target or the patch', () => {
  const target = { a: { b: 1 }, list: [1] };
  const patch = { a: { c: 2 }, list: [2] };
  const out = mergePatch(target, patch);
  assert.deepEqual(target, { a: { b: 1 }, list: [1] });
  assert.deepEqual(patch, { a: { c: 2 }, list: [2] });
  out.list.push(3);
  assert.deepEqual(patch.list, [2]);
});

test('append: "k+" appends to an existing array', () => {
  assert.deepEqual(mergePatch({ tools: [1] }, { 'tools+': [2, 3] }, { append: true }), { tools: [1, 2, 3] });
});

test('append: "k+" creates the array when missing and works when nested', () => {
  assert.deepEqual(mergePatch({}, { 'tools+': [{ type: 'web_search' }] }, { append: true }), { tools: [{ type: 'web_search' }] });
  assert.deepEqual(mergePatch({ a: { x: [1] } }, { a: { 'x+': [2] } }, { append: true }), { a: { x: [1, 2] } });
});

test('without the append option, "k+" is an ordinary key', () => {
  assert.deepEqual(mergePatch({ tools: [1] }, { 'tools+': [2] }), { tools: [1], 'tools+': [2] });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test test/unit/patch.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/core/patch.js`**

```js
/**
 * JSON Merge Patch (RFC 7396). Returns a new value; inputs are never mutated
 * (unchanged nested objects may be shared with the target).
 *
 * With { append: true }, a key ending in "+" appends its value (an array, or a
 * single item) to the target's array under the key without the "+". This is the
 * extension used for provider request patches (spec §9.4). Record patches use
 * the default, strict RFC behaviour.
 * @param {any} target
 * @param {any} patch
 * @param {{ append?: boolean }} [opts]
 * @returns {any}
 */
export function mergePatch(target, patch, opts = {}) {
  if (!isObject(patch)) return clone(patch);
  /** @type {Record<string, any>} */
  const out = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (opts.append && key.length > 1 && key.endsWith('+')) {
      const base = key.slice(0, -1);
      const add = Array.isArray(value) ? value : [value];
      out[base] = [...(Array.isArray(out[base]) ? out[base] : []), ...add.map(clone)];
    } else if (value === null) {
      delete out[key];
    } else {
      out[key] = mergePatch(out[key], value, opts);
    }
  }
  return out;
}

/** @param {unknown} x @returns {x is Record<string, any>} */
function isObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** @param {any} x */
function clone(x) {
  return x === undefined ? undefined : structuredClone(x);
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/unit/patch.test.js`
Expected: 19 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/patch.js test/unit/patch.test.js
git commit -m "Add JSON Merge Patch with the append extension"
```

---

### Task 3: Paths and content types

**Files:**
- Create: `src/core/paths.js`, `test/unit/paths.test.js`

**Interfaces:**
- Produces:
  - `normPath(p: string): string`: throws `PathError`. Reserved first segment: `.annai`.
  - `normPrefix(p: string): string`
  - `matchPath(glob: string, path: string): boolean`. `*` matches within a segment; `**` matches any number of segments.
  - `typeForPath(path: string): string`
  - `isTextType(type: string): boolean`
  - `isCompressedType(type: string): boolean`
  - `class PathError extends Error`

- [ ] **Step 1: Write the failing test** `test/unit/paths.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normPath, normPrefix, matchPath, typeForPath, isTextType, isCompressedType, PathError } from '../../src/core/paths.js';

test('normPath adds the leading slash and keeps valid paths', () => {
  assert.equal(normPath('notes/day1.md'), '/notes/day1.md');
  assert.equal(normPath('/notes/案内.md'), '/notes/案内.md');
});

test('normPath rejects empty, dot and dot-dot segments, backslashes, control characters and long paths', () => {
  for (const bad of ['/', '/a//b', '/a/./b', '/a/../b', '/a\\b', '/a\u0000b', '/a/', '/' + 'x'.repeat(600)]) {
    assert.throws(() => normPath(bad), PathError, bad);
  }
});

test('normPath reserves the .annai folder used inside archives', () => {
  assert.throws(() => normPath('/.annai/events.jsonl'), PathError);
  assert.equal(normPath('/notes/.annai'), '/notes/.annai');
});

test('normPrefix accepts the root and folder prefixes', () => {
  assert.equal(normPrefix(''), '/');
  assert.equal(normPrefix('/'), '/');
  assert.equal(normPrefix('plan/'), '/plan/');
  assert.throws(() => normPrefix('/a/../b/'), PathError);
});

test('matchPath: * stays inside one segment, ** spans segments', () => {
  assert.equal(matchPath('/plan/*.json', '/plan/a.json'), true);
  assert.equal(matchPath('/plan/*.json', '/plan/x/a.json'), false);
  assert.equal(matchPath('/files/**', '/files/a/b.jpg'), true);
  assert.equal(matchPath('/**/*.md', '/a.md'), true);
  assert.equal(matchPath('/**/*.md', '/notes/day/a.md'), true);
  assert.equal(matchPath('/trip.json', '/trip.json'), true);
  assert.equal(matchPath('/trip.json', '/tripXjson'), false);
});

test('typeForPath and the type predicates', () => {
  assert.equal(typeForPath('/a.json'), 'application/json');
  assert.equal(typeForPath('/a.MD'), 'text/markdown');
  assert.equal(typeForPath('/photo.JPG'), 'image/jpeg');
  assert.equal(typeForPath('/plugin/index.js'), 'text/javascript');
  assert.equal(typeForPath('/noext'), 'application/octet-stream');
  assert.equal(isTextType('application/json'), true);
  assert.equal(isTextType('image/png'), false);
  assert.equal(isCompressedType('image/jpeg'), true);
  assert.equal(isCompressedType('image/svg+xml'), false);
  assert.equal(isCompressedType('text/markdown'), false);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test test/unit/paths.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/core/paths.js`**

```js
export class PathError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}

const MAX = 512;
const BAD_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Normalizes a file path inside a scope: starts with "/", has no empty, "." or
 * ".." segments, no backslashes or control characters, and is at most 512
 * characters. The first segment ".annai" is reserved for archive metadata.
 * @param {string} path
 * @returns {string}
 */
export function normPath(path) {
  if (typeof path !== 'string') throw new PathError('the path must be text');
  let p = path.trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > MAX) throw new PathError(`the path is longer than ${MAX} characters`);
  if (BAD_CHARS.test(p)) throw new PathError('the path contains a control character or a backslash');
  const segs = p.split('/').slice(1);
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new PathError(`"${p}" has an empty, "." or ".." part`);
  if (segs[0] === '.annai') throw new PathError('the folder ".annai" is reserved');
  return p;
}

/**
 * Normalizes a folder prefix for listing: "" or "/" is the root; otherwise it
 * must be a valid path that ends in "/".
 * @param {string} prefix
 * @returns {string}
 */
export function normPrefix(prefix) {
  if (!prefix || prefix === '/') return '/';
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return normPath(trimmed) + '/';
}

/** @type {Map<string, RegExp>} */
const globCache = new Map();

/**
 * Matches a path against a glob: "*" stays inside one segment, "**" spans
 * any number of segments (including none).
 * @param {string} glob
 * @param {string} path
 */
export function matchPath(glob, path) {
  let re = globCache.get(glob);
  if (!re) {
    let src = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*' && glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        src += slash ? '(?:[^/]*/)*' : '.*';
        i += slash ? 2 : 1;
      } else if (c === '*') {
        src += '[^/]*';
      } else {
        src += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      }
    }
    re = new RegExp('^' + src + '$');
    globCache.set(glob, re);
  }
  return re.test(path);
}

/** @type {Record<string, string>} */
const TYPES = {
  json: 'application/json', jsonl: 'application/x-ndjson', md: 'text/markdown', txt: 'text/plain',
  csv: 'text/csv', tsv: 'text/tab-separated-values', html: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', pdf: 'application/pdf',
  ics: 'text/calendar', pkpass: 'application/vnd.apple.pkpass', zip: 'application/zip',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg',
  woff2: 'font/woff2',
};

/** @param {string} path @returns {string} */
export function typeForPath(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && TYPES[m[1].toLowerCase()]) || 'application/octet-stream';
}

/** @param {string} type */
export function isTextType(type) {
  return type.startsWith('text/') || type === 'application/json' || type === 'application/x-ndjson' || type === 'image/svg+xml';
}

/** Types that are already compressed, so zip should store them as-is. @param {string} type */
export function isCompressedType(type) {
  if (type === 'image/svg+xml') return false;
  return type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/') || type.startsWith('font/') ||
    type === 'application/pdf' || type === 'application/zip' || type === 'application/vnd.apple.pkpass';
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/unit/paths.test.js`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/paths.js test/unit/paths.test.js
git commit -m "Add path normalization, globs and content types"
```

---

### Task 4: JSON Schema validator (subset)

**Files:**
- Create: `src/core/schema.js`, `test/unit/schema.test.js`

**Interfaces:**
- Consumes: `matchPath` (Task 3).
- Produces:
  - `validate(schema: object, value: any): string[]`: errors as `"$.a.b: message"`; empty when valid.
  - `makeSchemaFor(registry: { list(kind: string): any[] }, kindOf: (scope: string) => string): (scope: string, path: string) => object|null`. The last matching `schema` entry `{ scope, pattern, schema }` wins.

- [ ] **Step 1: Write the failing test** `test/unit/schema.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, makeSchemaFor } from '../../src/core/schema.js';

const S = {
  type: 'object',
  required: ['id', 'title'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', maxLength: 5 },
    kind: { enum: ['flight', 'lodging'] },
    n: { type: 'integer', minimum: 0, maximum: 3 },
    day: { type: 'string', format: 'date' },
    at: { type: 'string', format: 'date-time' },
    tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' }, maxItems: 2 },
  },
};

test('valid value has no errors', () => {
  assert.deepEqual(validate(S, { id: 'x', title: 'Hi', kind: 'flight', n: 2, day: '2026-11-26', at: '2026-11-26T14:05:00-08:00', tags: ['a'] }), []);
});

test('reports type, required, enum, range and unknown keys with paths', () => {
  const errors = validate(S, { id: 1, kind: 'boat', n: 1.5, extra: true });
  assert.deepEqual(errors, [
    '$.title: is required',
    '$.id: expected string, got integer',
    '$.kind: must be one of "flight", "lodging"',
    '$.n: expected integer, got number',
    '$.extra: is not allowed',
  ]);
});

test('string length counts characters, not UTF-16 units', () => {
  assert.deepEqual(validate(S, { id: 'x', title: '🦊🦊🦊🦊🦊' }), []);
  assert.equal(validate(S, { id: 'x', title: '🦊🦊🦊🦊🦊🦊' }).length, 1);
});

test('dates must exist and date-times need an offset', () => {
  assert.equal(validate(S, { id: 'x', title: 'a', day: '2026-02-30' })[0], '$.day: must be a date like 2026-11-26');
  assert.equal(validate(S, { id: 'x', title: 'a', at: '2026-11-26T14:05:00' })[0], '$.at: must be a date-time like 2026-11-26T14:05:00-08:00');
  assert.deepEqual(validate(S, { id: 'x', title: 'a', at: '2026-11-26T22:05:00Z' }), []);
});

test('array items and limits', () => {
  assert.deepEqual(validate(S, { id: 'x', title: 'a', tags: ['ok', 'Bad', 'c'] }), [
    '$.tags: must have at most 2 items',
    '$.tags[1]: does not match ^[a-z]+$',
  ]);
});

test('makeSchemaFor picks the last matching registration for the scope kind', () => {
  const first = { type: 'object' };
  const second = { type: 'object', required: ['x'] };
  const registry = { list: () => [
    { scope: 'trip', pattern: '/plan/*.json', schema: first },
    { scope: 'trip', pattern: '/plan/*.json', schema: second },
    { scope: 'me', pattern: '/plan/*.json', schema: first },
  ] };
  const schemaFor = makeSchemaFor(registry, (scope) => (scope.startsWith('trip-') ? 'trip' : 'me'));
  assert.equal(schemaFor('trip-1', '/plan/a.json'), second);
  assert.equal(schemaFor('trip-1', '/notes/a.json'), null);
  assert.equal(schemaFor('me', '/plan/a.json'), first);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test test/unit/schema.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/core/schema.js`**

```js
import { matchPath } from './paths.js';

/**
 * A small JSON Schema validator for the subset annai's record schemas use:
 * type, enum, const, properties, required, additionalProperties, items,
 * minItems, maxItems, minLength, maxLength, pattern, minimum, maximum and
 * format (date, date-time). Unknown keywords are ignored.
 * @param {any} schema
 * @param {any} value
 * @returns {string[]} errors, empty when the value is valid
 */
export function validate(schema, value) {
  /** @type {string[]} */
  const errors = [];
  check(schema, value, '$', errors);
  return errors;
}

/**
 * @param {any} s @param {any} v @param {string} at @param {string[]} errors
 */
function check(s, v, at, errors) {
  if (!s || typeof s !== 'object') return;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => is(t, v))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${kind(v)}`);
      return;
    }
  }
  if (s.const !== undefined && !same(s.const, v)) errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, v))) {
    errors.push(`${at}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof v === 'string') {
    const length = [...v].length;
    if (s.minLength !== undefined && length < s.minLength) errors.push(`${at}: must be at least ${s.minLength} characters`);
    if (s.maxLength !== undefined && length > s.maxLength) errors.push(`${at}: must be at most ${s.maxLength} characters`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${at}: does not match ${s.pattern}`);
    if (s.format === 'date' && !isDate(v)) errors.push(`${at}: must be a date like 2026-11-26`);
    if (s.format === 'date-time' && !isDateTime(v)) errors.push(`${at}: must be a date-time like 2026-11-26T14:05:00-08:00`);
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${at}: must be at least ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${at}: must be at most ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${at}: must have at least ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${at}: must have at most ${s.maxItems} items`);
    if (s.items) v.forEach((item, i) => check(s.items, item, `${at}[${i}]`, errors));
  }
  if (is('object', v)) {
    for (const r of s.required ?? []) if (!(r in v)) errors.push(`${at}.${r}: is required`);
    const props = s.properties ?? {};
    for (const [k, val] of Object.entries(v)) {
      if (k in props) check(props[k], val, `${at}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${at}.${k}: is not allowed`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, val, `${at}.${k}`, errors);
    }
  }
}

/** @param {string} t @param {any} v */
function is(t, v) {
  switch (t) {
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return true;
  }
}

/** @param {any} v */
function kind(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

/** @param {any} a @param {any} b */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** @param {string} s */
function isDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** @param {string} s */
function isDateTime(s) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && isDate(s.slice(0, 10)) && !Number.isNaN(Date.parse(s));
}

/**
 * Builds the workspace's schema lookup from "schema" registrations of the form
 * { scope: 'trip'|'me'|'sys', pattern: '/plan/*.json', schema }. Later
 * registrations override earlier ones.
 * @param {{ list: (kind: string) => any[] }} registry
 * @param {(scope: string) => string} kindOf
 * @returns {(scope: string, path: string) => object | null}
 */
export function makeSchemaFor(registry, kindOf) {
  return (scope, path) => {
    const k = kindOf(scope);
    let found = null;
    for (const entry of registry.list('schema')) {
      if (entry.scope === k && matchPath(entry.pattern, path)) found = entry.schema;
    }
    return found;
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/unit/schema.test.js`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.js test/unit/schema.test.js
git commit -m "Add a small JSON Schema validator and schema lookup"
```

---
### Task 5: The Store contract and the in-memory store

**Files:**
- Create: `src/core/types.js`, `src/core/store-memory.js`, `test/contract/store-contract.js`, `test/unit/store-memory.test.js`

**Interfaces:**
- Produces:
  - The `Store` and `Tx` typedefs (below), used by every later task.
  - `createMemoryStore(): Store`.
  - `storeContract(test, assert, makeStore)`: a shared suite that Task 12 reuses in the browser.

- [ ] **Step 1: Write `src/core/types.js`** (typedefs only)

```js
/**
 * @typedef {'blobs'|'files'|'events'|'secrets'|'scopes'} StoreName
 * @typedef {{ hash: string, type: string, size: number, data: ArrayBuffer }} BlobRecord
 * @typedef {{ scope: string, path: string, hash: string, size: number, type: string,
 *   author: string, source?: string, created: number, modified: number }} FileEntry
 * @typedef {{ scope: string, seq: number, ts: number, type: string, actor: string,
 *   data?: any, refs?: string[] }} EventRecord
 * @typedef {{ ts: number, type: string, actor: string, data?: any, refs?: string[] }} NewEvent
 * @typedef {{ id: string, kind: 'me'|'trip'|'sys', title: string, status: 'active'|'archived',
 *   created: number, updated: number, format: number, tripId?: string }} ScopeRecord
 * @typedef {{ after?: number, before?: number, limit?: number, reverse?: boolean, types?: string[] }} EventQuery
 *
 * @typedef {object} Tx
 * @property {(hash: string) => Promise<BlobRecord|undefined>} getBlob
 * @property {(hash: string) => Promise<boolean>} hasBlob
 * @property {(rec: BlobRecord) => Promise<void>} putBlob
 * @property {(hash: string) => Promise<void>} deleteBlob
 * @property {(scope: string, path: string) => Promise<FileEntry|undefined>} getFile
 * @property {(entry: FileEntry) => Promise<void>} putFile
 * @property {(scope: string, path: string) => Promise<void>} deleteFile
 * @property {(scope: string, prefix?: string) => Promise<FileEntry[]>} listFiles  sorted by path
 * @property {(scope: string) => Promise<number>} lastSeq  0 when the scope has no events
 * @property {(scope: string, ev: NewEvent) => Promise<EventRecord>} appendEvent  assigns seq = lastSeq + 1
 * @property {(rec: EventRecord) => Promise<void>} putEvent  keeps rec.seq (used by import)
 * @property {(scope: string, q?: EventQuery) => Promise<EventRecord[]>} listEvents
 * @property {(id: string) => Promise<ScopeRecord|undefined>} getScope
 * @property {(rec: ScopeRecord) => Promise<void>} putScope
 * @property {() => Promise<ScopeRecord[]>} listScopes
 * @property {(id: string) => Promise<void>} deleteScope  removes the record, its files and its events (not blobs)
 * @property {(id: string) => Promise<any>} getSecret
 * @property {(id: string, value: any) => Promise<void>} putSecret
 * @property {(id: string) => Promise<void>} deleteSecret
 * @property {() => Promise<string[]>} listSecretIds
 *
 * @typedef {object} Store
 * @property {<T>(stores: StoreName[], mode: 'readonly'|'readwrite', fn: (tx: Tx) => Promise<T>) => Promise<T>} tx
 *   Runs fn in one transaction. A read-write transaction commits only if fn resolves.
 *   Inside fn, await only Tx calls: awaiting anything else lets IndexedDB commit early.
 * @property {() => void} close
 */
export {};
```

- [ ] **Step 2: Write the shared contract** `test/contract/store-contract.js`

```js
/**
 * Behaviour every Store must have. Runs under node:test against the memory
 * store and in browsers against IndexedDB (test/browser/suites/store-idb.js).
 * Uses only assert.equal, assert.deepEqual, assert.ok and assert.rejects.
 * @param {(name: string, fn: () => Promise<void>) => void} test
 * @param {any} assert
 * @param {() => Promise<import('../../src/core/types.js').Store>} makeStore  returns a fresh, empty store
 */
export function storeContract(test, assert, makeStore) {
  const buf = (/** @type {string} */ s) => new TextEncoder().encode(s).buffer;
  const str = (/** @type {ArrayBuffer} */ b) => new TextDecoder().decode(b);
  const file = (/** @type {string} */ scope, /** @type {string} */ path, hash = 'h1') =>
    ({ scope, path, hash, size: 1, type: 'text/plain', author: 'user', created: 1, modified: 2 });
  const scopeRec = (/** @type {string} */ id) =>
    ({ id, kind: /** @type {const} */ ('trip'), title: id, status: /** @type {const} */ ('active'), created: 1, updated: 1, format: 1 });

  test('blobs: put, has, get and delete', async () => {
    const s = await makeStore();
    await s.tx(['blobs'], 'readwrite', (t) => t.putBlob({ hash: 'abc', type: 'text/plain', size: 2, data: buf('hi') }));
    const got = await s.tx(['blobs'], 'readonly', async (t) => ({
      has: await t.hasBlob('abc'), missing: await t.hasBlob('zzz'), rec: await t.getBlob('abc'),
    }));
    assert.equal(got.has, true);
    assert.equal(got.missing, false);
    assert.equal(str(got.rec.data), 'hi');
    assert.equal(got.rec.type, 'text/plain');
    await s.tx(['blobs'], 'readwrite', (t) => t.deleteBlob('abc'));
    assert.equal(await s.tx(['blobs'], 'readonly', (t) => t.getBlob('abc')), undefined);
  });

  test('files: list by prefix in path order, scoped, and delete', async () => {
    const s = await makeStore();
    await s.tx(['files'], 'readwrite', async (t) => {
      for (const p of ['/plan/b.json', '/notes/a.md', '/plan/a.json', '/trip.json']) await t.putFile(file('trip-1', p));
      await t.putFile(file('trip-2', '/plan/z.json'));
    });
    const all = await s.tx(['files'], 'readonly', (t) => t.listFiles('trip-1', '/'));
    assert.deepEqual(all.map((f) => f.path), ['/notes/a.md', '/plan/a.json', '/plan/b.json', '/trip.json']);
    const plan = await s.tx(['files'], 'readonly', (t) => t.listFiles('trip-1', '/plan/'));
    assert.deepEqual(plan.map((f) => f.path), ['/plan/a.json', '/plan/b.json']);
    const one = await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/trip.json'));
    assert.equal(one.hash, 'h1');
    await s.tx(['files'], 'readwrite', (t) => t.deleteFile('trip-1', '/trip.json'));
    assert.equal(await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/trip.json')), undefined);
  });

  test('events: appendEvent numbers each scope from 1', async () => {
    const s = await makeStore();
    const seqs = await s.tx(['events'], 'readwrite', async (t) => [
      (await t.appendEvent('a', { ts: 1, type: 'x', actor: 'user' })).seq,
      (await t.appendEvent('a', { ts: 2, type: 'y', actor: 'user' })).seq,
      (await t.appendEvent('b', { ts: 3, type: 'x', actor: 'user' })).seq,
    ]);
    assert.deepEqual(seqs, [1, 2, 1]);
    assert.equal(await s.tx(['events'], 'readonly', (t) => t.lastSeq('a')), 2);
    assert.equal(await s.tx(['events'], 'readonly', (t) => t.lastSeq('none')), 0);
  });

  test('events: listEvents with after, before, limit, reverse and types', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', async (t) => {
      for (let i = 1; i <= 6; i++) await t.appendEvent('a', { ts: i, type: i % 2 ? 'odd' : 'even', actor: 'user', data: { i } });
    });
    const q = (/** @type {any} */ query) => s.tx(['events'], 'readonly', (t) => t.listEvents('a', query));
    assert.deepEqual((await q({})).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual((await q({ after: 2, before: 6 })).map((e) => e.seq), [3, 4, 5]);
    assert.deepEqual((await q({ reverse: true, limit: 2 })).map((e) => e.seq), [6, 5]);
    assert.deepEqual((await q({ types: ['even'], reverse: true, limit: 2 })).map((e) => e.seq), [6, 4]);
    assert.deepEqual((await q({ after: 6 })).map((e) => e.seq), []);
    assert.deepEqual((await q({ after: 5, before: 3 })).map((e) => e.seq), []);
  });

  test('events: putEvent keeps its seq and appendEvent continues after it', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', (t) => t.putEvent({ scope: 'a', seq: 41, ts: 1, type: 'x', actor: 'user' }));
    const next = await s.tx(['events'], 'readwrite', (t) => t.appendEvent('a', { ts: 2, type: 'y', actor: 'user' }));
    assert.equal(next.seq, 42);
  });

  test('scopes: put, get, list; deleteScope removes only that scope', async () => {
    const s = await makeStore();
    await s.tx(['scopes', 'files', 'events'], 'readwrite', async (t) => {
      for (const id of ['trip-1', 'trip-2']) {
        await t.putScope(scopeRec(id));
        await t.putFile(file(id, '/a.md'));
        await t.appendEvent(id, { ts: 1, type: 'x', actor: 'user' });
      }
    });
    await s.tx(['scopes', 'files', 'events'], 'readwrite', (t) => t.deleteScope('trip-1'));
    const left = await s.tx(['scopes', 'files', 'events'], 'readonly', async (t) => ({
      scopes: (await t.listScopes()).map((x) => x.id),
      files1: await t.listFiles('trip-1'), files2: await t.listFiles('trip-2'),
      events1: await t.listEvents('trip-1'), events2: await t.listEvents('trip-2'),
      gone: await t.getScope('trip-1'),
    }));
    assert.deepEqual(left.scopes, ['trip-2']);
    assert.equal(left.files1.length, 0);
    assert.equal(left.files2.length, 1);
    assert.equal(left.events1.length, 0);
    assert.equal(left.events2.length, 1);
    assert.equal(left.gone, undefined);
  });

  test('secrets: put, get, list ids and delete', async () => {
    const s = await makeStore();
    await s.tx(['secrets'], 'readwrite', async (t) => {
      await t.putSecret('openrouter', { key: 'sk-1' });
      await t.putSecret('anthropic', 'sk-2');
    });
    assert.deepEqual(await s.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), ['anthropic', 'openrouter']);
    assert.deepEqual(await s.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), { key: 'sk-1' });
    await s.tx(['secrets'], 'readwrite', (t) => t.deleteSecret('openrouter'));
    assert.equal(await s.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), undefined);
  });

  test('tx: a transaction that throws writes nothing', async () => {
    const s = await makeStore();
    await assert.rejects(s.tx(['files', 'events'], 'readwrite', async (t) => {
      await t.putFile(file('trip-1', '/a.md'));
      await t.appendEvent('trip-1', { ts: 1, type: 'file.write', actor: 'user' });
      throw new Error('boom');
    }));
    const left = await s.tx(['files', 'events'], 'readonly', async (t) => [await t.listFiles('trip-1'), await t.listEvents('trip-1')]);
    assert.deepEqual(left, [[], []]);
  });

  test('tx: returns the value of fn; read-only and out-of-scope access fail', async () => {
    const s = await makeStore();
    assert.equal(await s.tx(['files'], 'readonly', async () => 42), 42);
    await assert.rejects(s.tx(['files'], 'readonly', (t) => t.putFile(file('trip-1', '/a.md'))));
    await assert.rejects(s.tx(['files'], 'readonly', (t) => t.getBlob('x')));
  });
}
```

- [ ] **Step 3: Write the failing test** `test/unit/store-memory.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeContract } from '../contract/store-contract.js';
import { createMemoryStore } from '../../src/core/store-memory.js';

storeContract(test, assert, async () => createMemoryStore());

test('memory store: a failed transaction does not block the next one', async () => {
  const s = createMemoryStore();
  await assert.rejects(s.tx(['files'], 'readwrite', async () => { throw new Error('x'); }));
  assert.equal(await s.tx(['files'], 'readonly', async () => 'ok'), 'ok');
});
```

- [ ] **Step 4: Run it and verify it fails**

Run: `node --test test/unit/store-memory.test.js`
Expected: FAIL with `Cannot find module '.../store-memory.js'`.

- [ ] **Step 5: Implement `src/core/store-memory.js`**

```js
/** @typedef {import('./types.js').Store} Store @typedef {import('./types.js').Tx} Tx */

/**
 * An in-memory Store with the same contract as the IndexedDB store, for unit
 * tests and for running the core outside a browser. Transactions run one at a
 * time; a read-write transaction works on a copy that replaces the data only
 * when it succeeds.
 * @returns {Store}
 */
export function createMemoryStore() {
  let data = emptyData();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  return {
    tx(stores, mode, fn) {
      const run = async () => {
        const work = mode === 'readwrite' ? copy(data) : data;
        const result = await fn(makeTx(work, mode, new Set(stores)));
        if (mode === 'readwrite') data = work;
        return result;
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    },
    close() {},
  };
}

function emptyData() {
  return { blobs: new Map(), files: new Map(), events: new Map(), secrets: new Map(), scopes: new Map() };
}

/** @param {ReturnType<typeof emptyData>} d */
function copy(d) {
  return { blobs: new Map(d.blobs), files: new Map(d.files), events: new Map(d.events), secrets: new Map(d.secrets), scopes: new Map(d.scopes) };
}

const fkey = (/** @type {string} */ scope, /** @type {string} */ path) => `${scope}\u0000${path}`;
const ekey = (/** @type {string} */ scope, /** @type {number} */ seq) => `${scope}\u0000${seq}`;

/**
 * @param {ReturnType<typeof emptyData>} d
 * @param {'readonly'|'readwrite'} mode
 * @param {Set<string>} allowed
 * @returns {Tx}
 */
function makeTx(d, mode, allowed) {
  /** @param {keyof ReturnType<typeof emptyData>} name @param {boolean} [write] */
  const use = (name, write = false) => {
    if (!allowed.has(name)) throw new DOMException(`store "${name}" is not part of this transaction`, 'NotFoundError');
    if (write && mode !== 'readwrite') throw new DOMException('the transaction is read-only', 'ReadOnlyError');
    return d[name];
  };
  const out = (/** @type {any} */ v) => (v === undefined ? undefined : structuredClone(v));
  const eventsOf = (/** @type {string} */ scope) =>
    [...use('events').values()].filter((e) => e.scope === scope).sort((a, b) => a.seq - b.seq);

  /** @type {Tx} */
  const t = {
    async getBlob(hash) { return out(use('blobs').get(hash)); },
    async hasBlob(hash) { return use('blobs').has(hash); },
    async putBlob(rec) { use('blobs', true).set(rec.hash, structuredClone(rec)); },
    async deleteBlob(hash) { use('blobs', true).delete(hash); },
    async getFile(scope, path) { return out(use('files').get(fkey(scope, path))); },
    async putFile(entry) { use('files', true).set(fkey(entry.scope, entry.path), structuredClone(entry)); },
    async deleteFile(scope, path) { use('files', true).delete(fkey(scope, path)); },
    async listFiles(scope, prefix = '/') {
      return [...use('files').values()]
        .filter((f) => f.scope === scope && f.path.startsWith(prefix))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map(out);
    },
    async lastSeq(scope) {
      const list = eventsOf(scope);
      return list.length ? list[list.length - 1].seq : 0;
    },
    async appendEvent(scope, ev) {
      use('events', true);
      const seq = (await t.lastSeq(scope)) + 1;
      const rec = { ...structuredClone(ev), scope, seq };
      d.events.set(ekey(scope, seq), rec);
      return structuredClone(rec);
    },
    async putEvent(rec) { use('events', true).set(ekey(rec.scope, rec.seq), structuredClone(rec)); },
    async listEvents(scope, q = {}) {
      let list = eventsOf(scope).filter((e) => e.seq > (q.after ?? 0) && (q.before === undefined || e.seq < q.before));
      if (q.types) list = list.filter((e) => q.types?.includes(e.type));
      if (q.reverse) list.reverse();
      return list.slice(0, q.limit ?? Infinity).map(out);
    },
    async getScope(id) { return out(use('scopes').get(id)); },
    async putScope(rec) { use('scopes', true).set(rec.id, structuredClone(rec)); },
    async listScopes() { return [...use('scopes').values()].map(out); },
    async deleteScope(id) {
      use('scopes', true).delete(id);
      for (const [k, f] of use('files', true)) if (f.scope === id) d.files.delete(k);
      for (const [k, e] of use('events', true)) if (e.scope === id) d.events.delete(k);
    },
    async getSecret(id) { return out(use('secrets').get(id)?.value); },
    async putSecret(id, value) { use('secrets', true).set(id, structuredClone({ id, value })); },
    async deleteSecret(id) { use('secrets', true).delete(id); },
    async listSecretIds() { return [...use('secrets').keys()].sort(); },
  };
  return t;
}
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `node --test test/unit/store-memory.test.js`
Expected: 10 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.js src/core/store-memory.js test/contract/store-contract.js test/unit/store-memory.test.js
git commit -m "Add the Store contract and an in-memory store"
```

---

### Task 6: Workspace, the write path with history

**Files:**
- Create: `src/core/workspace.js`, `test/unit/workspace.test.js`

**Interfaces:**
- Consumes: `Store` (Task 5), `sha256Hex` (Task 1), `normPath`, `normPrefix`, `typeForPath` (Task 3), `mergePatch` (Task 2), `validate` (Task 4).
- Produces:
  - `class Workspace(store, { schemaFor?, now? })`, with methods:
    - `read(scope, path) → Promise<{entry, bytes: Uint8Array}|undefined>`
    - `readText(scope, path) → Promise<string|undefined>`
    - `readJSON(scope, path) → Promise<any>`
    - `list(scope, prefix='/') → Promise<FileEntry[]>`
    - `write(scope, path, content, { author, type?, source? }) → Promise<FileEntry>`
    - `patch(scope, path, changes, { author }) → Promise<FileEntry>`
    - `delete(scope, path, { author }) → Promise<void>`
    - `restore(scope, path, hash, { author }) → Promise<FileEntry>`
    - `history(scope, path) → Promise<{seq, ts, actor, type, old, new}[]>`
    - `onChange(fn) → unsubscribe`
  - `ValidationError` (`.path`, `.errors`), `NotFoundError`, `StorageFullError`.

- [ ] **Step 1: Write the failing test** `test/unit/workspace.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError, NotFoundError, StorageFullError } from '../../src/core/workspace.js';
import { PathError } from '../../src/core/paths.js';
import { sha256Hex } from '../../src/core/hash.js';

const PLAN = { type: 'object', required: ['id', 'title', 'fixed'], properties: { id: { type: 'string' }, title: { type: 'string' }, fixed: { type: 'boolean' } } };

async function setup(store = createMemoryStore()) {
  await store.tx(['scopes'], 'readwrite', (t) => t.putScope({ id: 'trip-1', kind: 'trip', title: 'T', status: 'active', created: 0, updated: 0, format: 1 }));
  let clock = 1000;
  const ws = new Workspace(store, {
    now: () => ++clock,
    schemaFor: (scope, path) => (path.startsWith('/plan/') ? PLAN : null),
  });
  return { ws, store };
}

test('write then read text, with entry metadata and a file.write event', async () => {
  const { ws, store } = await setup();
  const entry = await ws.write('trip-1', 'notes/day1.md', '# Day 1', { author: 'user' });
  assert.equal(entry.path, '/notes/day1.md');
  assert.equal(entry.type, 'text/markdown');
  assert.equal(entry.size, 7);
  assert.equal(entry.author, 'user');
  assert.equal(entry.hash, await sha256Hex('# Day 1'));
  assert.equal(await ws.readText('trip-1', '/notes/day1.md'), '# Day 1');
  const events = await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1'));
  assert.deepEqual(events.map((e) => [e.type, e.data.path, e.data.old]), [['file.write', '/notes/day1.md', null]]);
});

test('objects are stored as pretty JSON with a trailing newline', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'Dinner', fixed: true }, { author: 'shiori' });
  assert.equal(await ws.readText('trip-1', '/plan/a.json'), '{\n  "id": "a",\n  "title": "Dinner",\n  "fixed": true\n}\n');
  assert.deepEqual(await ws.readJSON('trip-1', '/plan/a.json'), { id: 'a', title: 'Dinner', fixed: true });
});

test('writing identical content adds no event', async () => {
  const { ws, store } = await setup();
  await ws.write('trip-1', '/a.md', 'same', { author: 'user' });
  await ws.write('trip-1', '/a.md', 'same', { author: 'user' });
  assert.equal((await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1'))).length, 1);
});

test('history, restore and delete keep every version', async () => {
  const { ws } = await setup();
  const v1 = await ws.write('trip-1', '/a.md', 'one', { author: 'user' });
  await ws.write('trip-1', '/a.md', 'two', { author: 'shiori' });
  await ws.restore('trip-1', '/a.md', v1.hash, { author: 'user' });
  assert.equal(await ws.readText('trip-1', '/a.md'), 'one');
  await ws.delete('trip-1', '/a.md', { author: 'user' });
  assert.equal(await ws.read('trip-1', '/a.md'), undefined);
  const h = await ws.history('trip-1', '/a.md');
  assert.deepEqual(h.map((x) => [x.type, x.actor]), [['file.write', 'user'], ['file.write', 'shiori'], ['file.write', 'user'], ['file.delete', 'user']]);
  await ws.restore('trip-1', '/a.md', h[1].new, { author: 'user' });
  assert.equal(await ws.readText('trip-1', '/a.md'), 'two');
});

test('invalid JSON and schema violations are refused and write nothing', async () => {
  const { ws, store } = await setup();
  await assert.rejects(ws.write('trip-1', '/plan/a.json', '{oops', { author: 'user' }), (e) => e instanceof ValidationError && /not valid JSON/.test(e.errors[0]));
  await assert.rejects(ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'x' }, { author: 'user' }), (e) => e instanceof ValidationError && e.errors[0] === '$.fixed: is required');
  assert.equal((await ws.list('trip-1')).length, 0);
  assert.equal((await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1'))).length, 0);
});

test('patch merges into JSON; patching a missing file fails', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'Dinner', fixed: false }, { author: 'user' });
  await ws.patch('trip-1', '/plan/a.json', { fixed: true, notes: 'window table' }, { author: 'shiori' });
  assert.deepEqual(await ws.readJSON('trip-1', '/plan/a.json'), { id: 'a', title: 'Dinner', fixed: true, notes: 'window table' });
  await assert.rejects(ws.patch('trip-1', '/plan/missing.json', { a: 1 }, { author: 'user' }), NotFoundError);
});

test('concurrent patches to one file both apply', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'T', fixed: false }, { author: 'user' });
  await Promise.all([
    ws.patch('trip-1', '/plan/a.json', { x: 1 }, { author: 'user' }),
    ws.patch('trip-1', '/plan/a.json', { y: 2 }, { author: 'user' }),
  ]);
  const v = await ws.readJSON('trip-1', '/plan/a.json');
  assert.equal(v.x, 1);
  assert.equal(v.y, 2);
});

test('unknown scopes and bad paths are refused', async () => {
  const { ws } = await setup();
  await assert.rejects(ws.write('trip-404', '/a.md', 'x', { author: 'user' }), NotFoundError);
  await assert.rejects(ws.write('trip-1', '/a/../b.md', 'x', { author: 'user' }), PathError);
});

test('list returns files under a prefix', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/notes/a.md', 'a', { author: 'user' });
  await ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'T', fixed: true }, { author: 'user' });
  assert.deepEqual((await ws.list('trip-1', '/notes/')).map((f) => f.path), ['/notes/a.md']);
});

test('binary content keeps its bytes and declared type', async () => {
  const { ws } = await setup();
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]);
  const entry = await ws.write('trip-1', '/files/photo.jpg', bytes, { author: 'user' });
  assert.equal(entry.type, 'image/jpeg');
  assert.deepEqual([...(await ws.read('trip-1', '/files/photo.jpg')).bytes], [...bytes]);
});

test('onChange runs after commits, and listener errors do not fail the write', async () => {
  const { ws } = await setup();
  /** @type {string[]} */
  const seen = [];
  ws.onChange((c) => { seen.push(`${c.op} ${c.path}`); });
  ws.onChange(() => { throw new Error('listener broke'); });
  await ws.write('trip-1', '/a.md', 'x', { author: 'user' });
  await ws.delete('trip-1', '/a.md', { author: 'user' });
  assert.deepEqual(seen, ['write /a.md', 'delete /a.md']);
});

test('storage full maps to StorageFullError and writes nothing', async () => {
  const inner = createMemoryStore();
  /** @type {import('../../src/core/types.js').Store} */
  const full = {
    close() {},
    tx(stores, mode, fn) {
      return inner.tx(stores, mode, (t) => fn({ ...t, putBlob: async () => { throw new DOMException('no space', 'QuotaExceededError'); } }));
    },
  };
  const { ws } = await setup(full);
  await assert.rejects(ws.write('trip-1', '/a.md', 'x', { author: 'user' }), StorageFullError);
  assert.equal((await ws.list('trip-1')).length, 0);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test test/unit/workspace.test.js`
Expected: FAIL with `Cannot find module '.../workspace.js'`.

- [ ] **Step 3: Implement `src/core/workspace.js`**

```js
import { sha256Hex } from './hash.js';
import { utf8, text, ownBuffer } from './bytes.js';
import { normPath, normPrefix, typeForPath } from './paths.js';
import { mergePatch } from './patch.js';
import { validate } from './schema.js';

/**
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').Tx} Tx
 * @typedef {import('./types.js').FileEntry} FileEntry
 * @typedef {{ author: string, type?: string, source?: string }} WriteOptions
 * @typedef {{ op: 'write'|'delete', scope: string, path: string, entry?: FileEntry }} Change
 */

export class ValidationError extends Error {
  /** @param {string} path @param {string[]} errors */
  constructor(path, errors) {
    super(`${path} isn't valid: ${errors.join('; ')}`);
    this.name = 'ValidationError';
    this.path = path;
    this.errors = errors;
  }
}

export class NotFoundError extends Error {
  /** @param {string} what */
  constructor(what) {
    super(`${what} doesn't exist`);
    this.name = 'NotFoundError';
  }
}

export class StorageFullError extends Error {
  constructor() {
    super("annai's storage on this device is full. Export a backup, then delete photos or old trips to make room.");
    this.name = 'StorageFullError';
  }
}

/**
 * Files inside scopes, with full history. Every change is one transaction that
 * stores the content blob, points the path at it, and appends a file.write or
 * file.delete event (spec §4.2). Changes to one path run one at a time.
 */
export class Workspace {
  /** @type {Map<string, Promise<unknown>>} */
  #locks = new Map();
  /** @type {Set<(c: Change) => unknown>} */
  #listeners = new Set();

  /**
   * @param {Store} store
   * @param {{ schemaFor?: (scope: string, path: string) => any, now?: () => number }} [opts]
   */
  constructor(store, opts = {}) {
    this.store = store;
    this.schemaFor = opts.schemaFor ?? (() => null);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Calls fn after every committed write or delete. Listener errors are reported, never thrown. */
  onChange(/** @type {(c: Change) => unknown} */ fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** @param {string} scope @param {string} path */
  async read(scope, path) {
    const p = normPath(path);
    return this.store.tx(['files', 'blobs'], 'readonly', async (t) => {
      const entry = await t.getFile(scope, p);
      if (!entry) return undefined;
      const blob = await t.getBlob(entry.hash);
      if (!blob) throw new Error(`the content of ${p} is missing from storage`);
      return { entry, bytes: new Uint8Array(blob.data) };
    });
  }

  /** @param {string} scope @param {string} path */
  async readText(scope, path) {
    const r = await this.read(scope, path);
    return r && text(r.bytes);
  }

  /** @param {string} scope @param {string} path */
  async readJSON(scope, path) {
    const s = await this.readText(scope, path);
    return s === undefined ? undefined : JSON.parse(s);
  }

  /** @param {string} scope @param {string} [prefix] */
  async list(scope, prefix = '/') {
    const p = normPrefix(prefix);
    return this.store.tx(['files'], 'readonly', (t) => t.listFiles(scope, p));
  }

  /**
   * Strings and bytes are stored as they are; any other value is stored as pretty JSON.
   * @param {string} scope @param {string} path
   * @param {string | Uint8Array | ArrayBuffer | object} content
   * @param {WriteOptions} opts
   * @returns {Promise<FileEntry>}
   */
  write(scope, path, content, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, () => this.#write(scope, p, content, opts));
  }

  /**
   * Applies a JSON Merge Patch to a JSON file.
   * @param {string} scope @param {string} path @param {any} changes @param {WriteOptions} opts
   * @returns {Promise<FileEntry>}
   */
  patch(scope, path, changes, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      const current = await this.readJSON(scope, p);
      if (current === undefined) throw new NotFoundError(p);
      return this.#write(scope, p, mergePatch(current, changes), opts);
    });
  }

  /** @param {string} scope @param {string} path @param {WriteOptions} opts */
  delete(scope, path, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      const now = this.now();
      await guardStorage(this.store.tx(['files', 'events', 'scopes'], 'readwrite', async (t) => {
        await touchScope(t, scope, now);
        const old = await t.getFile(scope, p);
        if (!old) throw new NotFoundError(p);
        await t.deleteFile(scope, p);
        await t.appendEvent(scope, { ts: now, type: 'file.delete', actor: opts.author, data: { path: p, old: old.hash } });
      }));
      await this.#emit({ op: 'delete', scope, path: p });
    });
  }

  /**
   * Points the path back at an earlier version (its blob is kept forever in M1).
   * @param {string} scope @param {string} path @param {string} hash @param {WriteOptions} opts
   * @returns {Promise<FileEntry>}
   */
  restore(scope, path, hash, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      const blob = await this.store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
      if (!blob) throw new NotFoundError(`that version of ${p}`);
      return this.#commit(scope, p, { hash, type: blob.type, size: blob.size }, opts);
    });
  }

  /** @param {string} scope @param {string} path */
  async history(scope, path) {
    const p = normPath(path);
    const events = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['file.write', 'file.delete'] }));
    return events
      .filter((e) => e.data?.path === p)
      .map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type, old: e.data.old ?? null, new: e.data.new ?? null }));
  }

  /** @param {string} scope @param {string} path @param {any} content @param {WriteOptions} opts */
  async #write(scope, path, content, opts) {
    const type = opts.type ?? typeForPath(path);
    const bytes = contentBytes(content);
    if (type === 'application/json') this.#validateJSON(scope, path, bytes);
    const hash = await sha256Hex(bytes); // before the transaction: IndexedDB commits early if we await other work inside it
    return this.#commit(scope, path, { hash, type, size: bytes.byteLength, bytes }, opts);
  }

  /**
   * @param {string} scope @param {string} path
   * @param {{ hash: string, type: string, size: number, bytes?: Uint8Array }} blob
   * @param {WriteOptions} opts
   * @returns {Promise<FileEntry>}
   */
  async #commit(scope, path, blob, opts) {
    const now = this.now();
    const { entry, changed } = await guardStorage(this.store.tx(['blobs', 'files', 'events', 'scopes'], 'readwrite', async (t) => {
      await touchScope(t, scope, now);
      const old = await t.getFile(scope, path);
      if (old && old.hash === blob.hash && old.type === blob.type) return { entry: old, changed: false };
      if (blob.bytes && !(await t.hasBlob(blob.hash))) {
        await t.putBlob({ hash: blob.hash, type: blob.type, size: blob.size, data: ownBuffer(blob.bytes) });
      }
      /** @type {FileEntry} */
      const next = {
        scope, path, hash: blob.hash, size: blob.size, type: blob.type, author: opts.author,
        created: old?.created ?? now, modified: now, ...(opts.source ? { source: opts.source } : {}),
      };
      await t.putFile(next);
      await t.appendEvent(scope, { ts: now, type: 'file.write', actor: opts.author, data: { path, old: old?.hash ?? null, new: blob.hash, size: blob.size } });
      return { entry: next, changed: true };
    }));
    if (changed) await this.#emit({ op: 'write', scope, path, entry });
    return entry;
  }

  /** @param {string} scope @param {string} path @param {Uint8Array} bytes */
  #validateJSON(scope, path, bytes) {
    let value;
    try {
      value = JSON.parse(text(bytes));
    } catch (e) {
      throw new ValidationError(path, [`not valid JSON (${/** @type {Error} */ (e).message})`]);
    }
    const schema = this.schemaFor(scope, path);
    if (schema) {
      const errors = validate(schema, value);
      if (errors.length) throw new ValidationError(path, errors);
    }
  }

  /** @param {Change} change */
  async #emit(change) {
    for (const fn of this.#listeners) {
      try {
        await fn(change);
      } catch (e) {
        console.warn('a workspace change listener failed', e);
      }
    }
  }

  /**
   * @template T
   * @param {string} scope @param {string} path @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  #locked(scope, path, fn) {
    const key = `${scope}\u0000${path}`;
    const run = (this.#locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.#locks.set(key, tail);
    tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key); });
    return run;
  }
}

/** @param {any} content @returns {Uint8Array} */
function contentBytes(content) {
  if (typeof content === 'string') return utf8(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return utf8(JSON.stringify(content, null, 2) + '\n');
}

/** @param {Tx} t @param {string} scope @param {number} now */
async function touchScope(t, scope, now) {
  const rec = await t.getScope(scope);
  if (!rec) throw new NotFoundError(`the trip or area "${scope}"`);
  await t.putScope({ ...rec, updated: now });
}

/** @template T @param {Promise<T>} p @returns {Promise<T>} */
async function guardStorage(p) {
  try {
    return await p;
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'QuotaExceededError') throw new StorageFullError();
    throw e;
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/unit/workspace.test.js`
Expected: 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/workspace.js test/unit/workspace.test.js
git commit -m "Add the workspace: transactional writes with history and undo"
```

---

### Task 7: Scopes, trips, app settings, events and the core schemas

**Files:**
- Create: `src/app/version.js`, `src/core/scopes.js`, `src/core/events.js`, `src/core/settings.js`, `src/plugins/core-schemas/schemas.js`, `src/plugins/core-schemas/index.js`, `test/unit/scopes.test.js`

**Interfaces:**
- Consumes: `Workspace`, `ValidationError` (Task 6); `makeSchemaFor` (Task 4).
- Produces:
  - `VERSION = '0.1.0'`
  - `FORMAT`, `ME`, `SYS`, `SYS_SETTINGS`, `SYS_PLUGINS`
  - `kindOf(scope) → 'me'|'trip'|'sys'|'other'`
  - `newId(prefix) → string`
  - `ensureBaseScopes(ws)`
  - `createTrip(ws, { title, start?, end? }) → Promise<string>` (the scope id)
  - `listTrips(store) → Promise<{ active: ScopeRecord[], archived: ScopeRecord[] }>`
  - `setTripStatus(store, id, 'active'|'archived')`
  - `syncTripTitles(ws) → unsubscribe`
  - `logEvent(store, scope, { type, actor?, data? }) → Promise<EventRecord>`
  - `readAppSettings(ws)`, `updateAppSettings(ws, changes)`
  - `CORE_SCHEMAS`
  - The built-in plugin module `{ manifest, activate }`.

- [ ] **Step 1: Write the failing test** `test/unit/scopes.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError } from '../../src/core/workspace.js';
import { makeSchemaFor, validate } from '../../src/core/schema.js';
import { ME, SYS, SYS_SETTINGS, SYS_PLUGINS, kindOf, newId, ensureBaseScopes, createTrip, listTrips, setTripStatus, syncTripTitles } from '../../src/core/scopes.js';
import { logEvent } from '../../src/core/events.js';
import { readAppSettings, updateAppSettings } from '../../src/core/settings.js';
import { CORE_SCHEMAS, PLAN_ITEM_SCHEMA, BOOKING_SCHEMA } from '../../src/plugins/core-schemas/schemas.js';
import * as corePlugin from '../../src/plugins/core-schemas/index.js';

function setup() {
  const store = createMemoryStore();
  let clock = 1000;
  const ws = new Workspace(store, { now: () => ++clock, schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  return { store, ws };
}

test('kindOf and newId', () => {
  assert.equal(kindOf(ME), 'me');
  assert.equal(kindOf(SYS), 'sys');
  assert.equal(kindOf(SYS_PLUGINS), 'sys');
  assert.equal(kindOf('trip-abc'), 'trip');
  assert.equal(kindOf('x'), 'other');
  const a = newId('trip'), b = newId('trip');
  assert.match(a, /^trip-[0-9a-z]+$/);
  assert.notEqual(a, b);
});

test('ensureBaseScopes creates me and the system scopes once', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  await ensureBaseScopes(ws);
  const ids = (await store.tx(['scopes'], 'readonly', (t) => t.listScopes())).map((s) => s.id).sort();
  assert.deepEqual(ids, [ME, SYS, SYS_PLUGINS, SYS_SETTINGS].sort());
  assert.match(await ws.readText(ME, '/profile.md'), /^# Profile/);
  assert.equal((await ws.history(ME, '/profile.md')).length, 1);
  assert.equal(await ws.readText(ME, '/memory.md'), '# Memory\n');
});

test('createTrip makes a scope, trip.json, trip memory and a scope.create event', async () => {
  const { store, ws } = setup();
  const id = await createTrip(ws, { title: '京都 in spring', start: '2027-04-03', end: '2027-04-10' });
  const rec = await store.tx(['scopes'], 'readonly', (t) => t.getScope(id));
  assert.equal(rec.kind, 'trip');
  assert.equal(rec.title, '京都 in spring');
  const trip = await ws.readJSON(id, '/trip.json');
  assert.deepEqual(trip, { id: rec.tripId, title: '京都 in spring', start: '2027-04-03', end: '2027-04-10', places: [], party: [] });
  assert.equal(await ws.readText(id, '/memory.md'), '# Trip memory\n');
  const types = (await store.tx(['events'], 'readonly', (t) => t.listEvents(id))).map((e) => e.type);
  assert.deepEqual(types, ['scope.create', 'file.write', 'file.write']);
});

test('createTrip refuses an empty title or a bad date and leaves nothing behind', async () => {
  const { store, ws } = setup();
  await assert.rejects(createTrip(ws, { title: '  ' }), ValidationError);
  await assert.rejects(createTrip(ws, { title: 'Big Sur', start: '2026-13-01' }), ValidationError);
  assert.deepEqual(await store.tx(['scopes'], 'readonly', (t) => t.listScopes()), []);
});

test('listTrips orders by last change and splits archived trips', async () => {
  const { store, ws } = setup();
  const a = await createTrip(ws, { title: 'A' });
  const b = await createTrip(ws, { title: 'B' });
  await ws.write(a, '/notes/x.md', 'newer', { author: 'user' });
  let trips = await listTrips(store);
  assert.deepEqual(trips.active.map((s) => s.title), ['A', 'B']);
  await setTripStatus(store, b, 'archived');
  trips = await listTrips(store);
  assert.deepEqual(trips.active.map((s) => s.title), ['A']);
  assert.deepEqual(trips.archived.map((s) => s.title), ['B']);
  const types = (await store.tx(['events'], 'readonly', (t) => t.listEvents(b))).map((e) => e.type);
  assert.equal(types.at(-1), 'scope.archive');
});

test('syncTripTitles keeps the scope title in step with trip.json', async () => {
  const { store, ws } = setup();
  syncTripTitles(ws);
  const id = await createTrip(ws, { title: 'Old' });
  await ws.patch(id, '/trip.json', { title: 'Big Sur · Thanksgiving' }, { author: 'user' });
  assert.equal((await store.tx(['scopes'], 'readonly', (t) => t.getScope(id))).title, 'Big Sur · Thanksgiving');
});

test('logEvent and app settings', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const ev = await logEvent(store, SYS, { type: 'error', data: { message: 'x' } });
  assert.equal(ev.actor, 'system');
  assert.deepEqual(await readAppSettings(ws), {});
  await updateAppSettings(ws, { lastExportAt: 5 });
  await updateAppSettings(ws, { theme: 'dark' });
  assert.deepEqual(await readAppSettings(ws), { lastExportAt: 5, theme: 'dark' });
  assert.equal((await ws.list(SYS_SETTINGS)).length, 1);
});

test('plan item and booking schemas', () => {
  const time = { at: '2026-11-26T18:30:00-08:00', tz: 'America/Los_Angeles' };
  assert.deepEqual(validate(PLAN_ITEM_SCHEMA, { id: 'p1', title: 'Nepenthe', fixed: true, start: time, place: { name: 'Nepenthe', lat: 36.22, lng: -121.76 } }), []);
  assert.deepEqual(validate(PLAN_ITEM_SCHEMA, { id: 'p1', title: 'Nepenthe' }), ['$.fixed: is required']);
  assert.deepEqual(validate(BOOKING_SCHEMA, { id: 'b1', kind: 'lodging', status: 'unverified', source: '/files/shot.png', cost: { amount: 612.4, currency: 'USD' } }), []);
  assert.equal(validate(BOOKING_SCHEMA, { id: 'b1', kind: 'boat', status: 'maybe', source: 'x' }).length, 3);
});

test('the core-schemas plugin registers its schemas and unregisters them', () => {
  /** @type {any[]} */
  const registered = [];
  const api = { schemas: { register: (/** @type {any} */ s) => { registered.push(s); return () => registered.splice(registered.indexOf(s), 1); } } };
  assert.equal(corePlugin.manifest.id, 'core-schemas');
  const dispose = corePlugin.activate(api);
  assert.equal(registered.length, CORE_SCHEMAS.length);
  dispose();
  assert.equal(registered.length, 0);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test test/unit/scopes.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/app/version.js` and `src/core/scopes.js`**

`src/app/version.js`:
```js
/** The app version. Keep in step with package.json and sw.js (a unit test checks). */
export const VERSION = '0.1.0';
```

`src/core/scopes.js`:
```js
import { ValidationError } from './workspace.js';

/** @typedef {import('./types.js').Store} Store @typedef {import('./types.js').ScopeRecord} ScopeRecord */
/** @typedef {import('./workspace.js').Workspace} Workspace */

export const FORMAT = 1;
export const ME = 'me';
export const SYS = 'sys';
export const SYS_SETTINGS = 'sys:settings';
export const SYS_PLUGINS = 'sys:plugins';

/** @param {string} scope @returns {'me'|'trip'|'sys'|'other'} */
export function kindOf(scope) {
  if (scope === ME) return 'me';
  if (scope === SYS || scope.startsWith('sys:')) return 'sys';
  if (scope.startsWith('trip-')) return 'trip';
  return 'other';
}

/** A sortable, collision-resistant id: "<prefix>-<time base36><8 random base36>". @param {string} prefix */
export function newId(prefix) {
  let r = '';
  for (const b of crypto.getRandomValues(new Uint8Array(8))) r += (b % 36).toString(36);
  return `${prefix}-${Date.now().toString(36)}${r}`;
}

const PROFILE = '# Profile\n\n- What to call me:\n- Language: English\n- Units:\n- Preferences:\n';

/** Creates "me" and the system scopes if they are missing. @param {Workspace} ws */
export async function ensureBaseScopes(ws) {
  const now = ws.now();
  /** @type {[string, ScopeRecord['kind'], string][]} */
  const base = [[ME, 'me', 'Me'], [SYS, 'sys', 'System log'], [SYS_SETTINGS, 'sys', 'Settings'], [SYS_PLUGINS, 'sys', 'Plugins']];
  const made = await ws.store.tx(['scopes'], 'readwrite', async (t) => {
    /** @type {string[]} */
    const created = [];
    for (const [id, kind, title] of base) {
      if (!(await t.getScope(id))) {
        await t.putScope({ id, kind, title, status: 'active', created: now, updated: now, format: FORMAT });
        created.push(id);
      }
    }
    return created;
  });
  if (made.includes(ME)) {
    await ws.write(ME, '/profile.md', PROFILE, { author: 'user' });
    await ws.write(ME, '/memory.md', '# Memory\n', { author: 'user' });
  }
}

/**
 * @param {Workspace} ws
 * @param {{ title: string, start?: string, end?: string }} trip
 * @returns {Promise<string>} the new scope id
 */
export async function createTrip(ws, { title, start, end }) {
  const clean = (title ?? '').trim();
  if (!clean) throw new ValidationError('/trip.json', ['$.title: is required']);
  const now = ws.now();
  const id = newId('trip');
  const tripId = newId('t');
  await ws.store.tx(['scopes', 'events'], 'readwrite', async (t) => {
    await t.putScope({ id, kind: 'trip', title: clean, status: 'active', created: now, updated: now, format: FORMAT, tripId });
    await t.appendEvent(id, { ts: now, type: 'scope.create', actor: 'user', data: { title: clean } });
  });
  try {
    await ws.write(id, '/trip.json', { id: tripId, title: clean, ...(start ? { start } : {}), ...(end ? { end } : {}), places: [], party: [] }, { author: 'user' });
    await ws.write(id, '/memory.md', '# Trip memory\n', { author: 'user' });
  } catch (e) {
    await ws.store.tx(['scopes', 'files', 'events'], 'readwrite', (t) => t.deleteScope(id));
    throw e;
  }
  return id;
}

/** @param {Store} store */
export async function listTrips(store) {
  const all = await store.tx(['scopes'], 'readonly', (t) => t.listScopes());
  const trips = all.filter((s) => s.kind === 'trip').sort((a, b) => b.updated - a.updated);
  return { active: trips.filter((s) => s.status === 'active'), archived: trips.filter((s) => s.status === 'archived') };
}

/** @param {Store} store @param {string} id @param {'active'|'archived'} status */
export async function setTripStatus(store, id, status, now = Date.now()) {
  await store.tx(['scopes', 'events'], 'readwrite', async (t) => {
    const rec = await t.getScope(id);
    if (!rec || rec.kind !== 'trip') throw new Error(`trip ${id} doesn't exist`);
    await t.putScope({ ...rec, status, updated: now });
    await t.appendEvent(id, { ts: now, type: status === 'archived' ? 'scope.archive' : 'scope.unarchive', actor: 'user' });
  });
}

/** Keeps each trip scope's title equal to the title in its trip.json. @param {Workspace} ws */
export function syncTripTitles(ws) {
  return ws.onChange(async ({ op, scope, path }) => {
    if (op !== 'write' || kindOf(scope) !== 'trip' || path !== '/trip.json') return;
    const trip = await ws.readJSON(scope, '/trip.json');
    const title = String(trip?.title ?? '').trim();
    if (!title) return;
    await ws.store.tx(['scopes'], 'readwrite', async (t) => {
      const rec = await t.getScope(scope);
      if (rec && rec.title !== title) await t.putScope({ ...rec, title });
    });
  });
}
```

- [ ] **Step 4: Implement `src/core/events.js` and `src/core/settings.js`**

`src/core/events.js`:
```js
/** @typedef {import('./types.js').Store} Store */

/**
 * Appends one event to a scope in its own transaction.
 * @param {Store} store
 * @param {string} scope
 * @param {{ type: string, actor?: string, data?: any, refs?: string[] }} ev
 */
export function logEvent(store, scope, ev, now = Date.now()) {
  return store.tx(['events'], 'readwrite', (t) => t.appendEvent(scope, { ts: now, actor: 'system', ...ev }));
}
```

`src/core/settings.js`:
```js
import { SYS_SETTINGS } from './scopes.js';

/** @typedef {import('./workspace.js').Workspace} Workspace */
const APP = '/app.json';

/** @param {Workspace} ws @returns {Promise<Record<string, any>>} */
export async function readAppSettings(ws) {
  return (await ws.readJSON(SYS_SETTINGS, APP)) ?? {};
}

/** Merges changes into the app settings (null removes a key). @param {Workspace} ws @param {Record<string, any>} changes */
export async function updateAppSettings(ws, changes) {
  const exists = (await ws.list(SYS_SETTINGS)).some((f) => f.path === APP);
  return exists
    ? ws.patch(SYS_SETTINGS, APP, changes, { author: 'system' })
    : ws.write(SYS_SETTINGS, APP, changes, { author: 'system' });
}
```

- [ ] **Step 5: Implement the core-schemas plugin**

`src/plugins/core-schemas/schemas.js`:
```js
const TIME = {
  type: 'object', required: ['at', 'tz'],
  properties: { at: { type: 'string', format: 'date-time' }, tz: { type: 'string', minLength: 1 } },
};
const PLACE = {
  type: 'object', required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
    address: { type: 'string' },
  },
};

export const TRIP_SCHEMA = {
  type: 'object', required: ['id', 'title'],
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    start: { type: 'string', format: 'date' },
    end: { type: 'string', format: 'date' },
    places: { type: 'array', items: { type: 'string' } },
    timezones: { type: 'array', items: { type: 'string' } },
    party: {
      type: 'array',
      items: {
        type: 'object', required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          age: { type: 'integer', minimum: 0, maximum: 130 },
          interests: { type: 'array', items: { type: 'string' } },
          driver: { type: 'boolean' },
        },
      },
    },
  },
};

export const PLAN_ITEM_SCHEMA = {
  type: 'object', required: ['id', 'title', 'fixed'],
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    kind: { type: 'string' },
    fixed: { type: 'boolean' },
    priority: { type: 'integer', minimum: 0, maximum: 3 },
    start: TIME,
    end: TIME,
    place: PLACE,
    booking: { type: 'string' },
    notes: { type: 'string' },
  },
};

export const BOOKING_SCHEMA = {
  type: 'object', required: ['id', 'kind', 'status', 'source'],
  properties: {
    id: { type: 'string', minLength: 1 },
    kind: { enum: ['flight', 'lodging', 'car', 'rail', 'event', 'restaurant', 'other'] },
    status: { enum: ['unverified', 'confirmed'] },
    source: { type: 'string', pattern: '^/' },
    title: { type: 'string' },
    start: TIME,
    end: TIME,
    place: PLACE,
    confirmation: { type: 'string' },
    cost: {
      type: 'object', required: ['amount', 'currency'],
      properties: { amount: { type: 'number' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } },
    },
    fields: { type: 'object' },
  },
};

/** Registrations for the workspace's schema lookup (spec §4.4). */
export const CORE_SCHEMAS = [
  { scope: 'trip', pattern: '/trip.json', schema: TRIP_SCHEMA },
  { scope: 'trip', pattern: '/plan/*.json', schema: PLAN_ITEM_SCHEMA },
  { scope: 'trip', pattern: '/bookings/*.json', schema: BOOKING_SCHEMA },
];
```

`src/plugins/core-schemas/index.js`:
```js
import { CORE_SCHEMAS } from './schemas.js';
import { VERSION } from '../../app/version.js';

export const manifest = {
  id: 'core-schemas',
  name: 'Trip record checks',
  version: VERSION,
  api: 1,
  description: 'Checks trip.json, plan items and bookings when they are saved.',
};

/** @param {{ schemas: { register: (entry: any) => () => void } }} annai */
export function activate(annai) {
  const off = CORE_SCHEMAS.map((entry) => annai.schemas.register(entry));
  return () => off.forEach((fn) => fn());
}
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `node --test test/unit/scopes.test.js && npm test`
Expected: 9 new tests pass, and the whole unit suite passes.

- [ ] **Step 7: Commit**

```bash
git add src/app/version.js src/core/scopes.js src/core/events.js src/core/settings.js src/plugins/core-schemas test/unit/scopes.test.js
git commit -m "Add scopes, trips, app settings and the core record schemas"
```

---
### Task 8: Zip writer and reader

**Files:**
- Create: `src/core/zip.js`, `test/unit/zip.test.js`, `test/fixtures/infozip.zip`

**Interfaces:**
- Consumes: `crc32` (Task 1), `utf8`, `text` (Task 1).
- Produces:
  - `class ZipWriter`, with `add(name: string, bytes: Uint8Array, { compress?: boolean, mtime?: number }): Promise<void>` and `finish(): Blob`
  - `readZip(zip: Uint8Array): Promise<Map<string, Uint8Array>>`
  - `class ZipError extends Error`
  - `deflateRaw(bytes)`, `inflateRaw(bytes)`

- [ ] **Step 1: Create the Info-ZIP fixture**

```bash
mkdir -p test/fixtures && cd test/fixtures
yes 'hello zip' | head -n 200 > hello.txt
mkdir dir && printf 'annai\n' > dir/annai.txt
zip -X -r infozip.zip hello.txt dir
rm -r hello.txt dir
unzip -l infozip.zip
cd ../..
```
Expected: the listing shows `hello.txt` (2000 bytes), `dir/` and `dir/annai.txt`.

- [ ] **Step 2: Write the failing test** `test/unit/zip.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ZipWriter, readZip, ZipError } from '../../src/core/zip.js';
import { utf8, text } from '../../src/core/bytes.js';

const bytesOf = async (/** @type {Blob} */ blob) => new Uint8Array(await blob.arrayBuffer());
const hasUnzip = (() => { try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('round-trips text, binary, empty files and UTF-8 names', async () => {
  const z = new ZipWriter();
  const note = '# 案内\n'.repeat(50);
  const bin = crypto.getRandomValues(new Uint8Array(60000));
  await z.add('trips/trip-1/notes/案内.md', utf8(note));
  await z.add('trips/trip-1/files/photo.jpg', bin, { compress: false });
  await z.add('empty.txt', new Uint8Array());
  const out = await readZip(await bytesOf(z.finish()));
  assert.deepEqual([...out.keys()], ['trips/trip-1/notes/案内.md', 'trips/trip-1/files/photo.jpg', 'empty.txt']);
  assert.equal(text(out.get('trips/trip-1/notes/案内.md')), note);
  assert.deepEqual(out.get('trips/trip-1/files/photo.jpg'), bin);
  assert.equal(out.get('empty.txt')?.length, 0);
});

test('compressible text is deflated', async () => {
  const z = new ZipWriter();
  const big = utf8('a'.repeat(10000));
  await z.add('a.txt', big);
  const blob = z.finish();
  assert.ok(blob.size < 1000, `archive is ${blob.size} bytes`);
  assert.deepEqual((await readZip(await bytesOf(blob))).get('a.txt'), big);
});

test('incompressible data is stored even when compression is requested', async () => {
  const z = new ZipWriter();
  const noise = crypto.getRandomValues(new Uint8Array(4000));
  await z.add('noise.bin', noise);
  const blob = z.finish();
  assert.ok(blob.size < 4000 + 200);
  assert.deepEqual((await readZip(await bytesOf(blob))).get('noise.bin'), noise);
});

test('duplicate names are refused', async () => {
  const z = new ZipWriter();
  await z.add('a', utf8('1'));
  await assert.rejects(z.add('a', utf8('2')), ZipError);
});

test('a flipped byte is caught by the checksum', async () => {
  const z = new ZipWriter();
  await z.add('a.txt', utf8('hello world'), { compress: false });
  const b = await bytesOf(z.finish());
  b[30 + 'a.txt'.length] ^= 1; // first data byte follows the 30-byte header and the name
  await assert.rejects(readZip(b), (e) => e instanceof ZipError && /corrupted/.test(e.message));
});

test('something that is not a zip is refused', async () => {
  await assert.rejects(readZip(utf8('just text, no zip here')), (e) => e instanceof ZipError && /not a zip/.test(e.message));
});

test('reads an archive made by Info-ZIP', async () => {
  const z = await readZip(new Uint8Array(await readFile(new URL('../fixtures/infozip.zip', import.meta.url))));
  assert.equal(text(z.get('hello.txt')), 'hello zip\n'.repeat(200));
  assert.equal(text(z.get('dir/annai.txt')), 'annai\n');
  assert.equal(z.has('dir/'), false);
});

test('Info-ZIP accepts our archives', { skip: !hasUnzip && 'unzip is not installed' }, async () => {
  const z = new ZipWriter();
  await z.add('hello.txt', utf8('hello\n'.repeat(100)));
  await z.add('notes/案内.md', utf8('案内'), { compress: false });
  const dir = await mkdtemp(join(tmpdir(), 'annai-zip-'));
  const file = join(dir, 'ours.zip');
  await writeFile(file, await bytesOf(z.finish()));
  execFileSync('unzip', ['-t', file], { stdio: 'pipe' });
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `node --test test/unit/zip.test.js`
Expected: FAIL with `Cannot find module '.../zip.js'`.

- [ ] **Step 4: Implement `src/core/zip.js`**

```js
import { crc32 } from './crc32.js';
import { utf8, text } from './bytes.js';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_FLAG = 0x0800;

export class ZipError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/** Raw DEFLATE using the platform's CompressionStream. @param {Uint8Array} bytes */
export async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @param {Uint8Array} bytes */
export async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Builds a zip archive one entry at a time. Each entry is compressed when it is
 * added, and the archive is returned as a Blob of the collected chunks, so a
 * large archive never needs one contiguous buffer. No zip64: at most 65,535
 * entries and 4 GiB.
 */
export class ZipWriter {
  /** @type {Uint8Array[]} */ #chunks = [];
  /** @type {{ name: Uint8Array, method: number, time: number, date: number, crc: number, csize: number, usize: number, offset: number }[]} */ #central = [];
  /** @type {Set<string>} */ #names = new Set();
  #offset = 0;

  /**
   * @param {string} name path inside the archive, with "/" separators
   * @param {Uint8Array} bytes
   * @param {{ compress?: boolean, mtime?: number }} [opts]
   */
  async add(name, bytes, opts = {}) {
    if (this.#names.has(name)) throw new ZipError(`the archive already has an entry called ${name}`);
    if (this.#central.length >= 0xffff) throw new ZipError('too many files for one archive');
    this.#names.add(name);
    const nameBytes = utf8(name);
    const crc = crc32(bytes);
    let method = 0;
    let data = bytes;
    if (opts.compress !== false && bytes.length > 0) {
      const packed = await deflateRaw(bytes);
      if (packed.length < bytes.length) {
        method = 8;
        data = packed;
      }
    }
    if (this.#offset + 30 + nameBytes.length + data.length > 0xffffffff) throw new ZipError('the archive would be larger than 4 GiB');
    const { time, date } = dosTime(opts.mtime ?? Date.now());
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, LOCAL, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, UTF8_FLAG, true);
    h.setUint16(8, method, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, bytes.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);
    this.#chunks.push(new Uint8Array(h.buffer), nameBytes, data);
    this.#central.push({ name: nameBytes, method, time, date, crc, csize: data.length, usize: bytes.length, offset: this.#offset });
    this.#offset += 30 + nameBytes.length + data.length;
  }

  /** @returns {Blob} the finished archive */
  finish() {
    const start = this.#offset;
    /** @type {Uint8Array[]} */
    const cd = [];
    for (const e of this.#central) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, CENTRAL, true);
      h.setUint16(4, 0x0314, true); // made by: Unix, zip 2.0
      h.setUint16(6, 20, true);
      h.setUint16(8, UTF8_FLAG, true);
      h.setUint16(10, e.method, true);
      h.setUint16(12, e.time, true);
      h.setUint16(14, e.date, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.csize, true);
      h.setUint32(24, e.usize, true);
      h.setUint16(28, e.name.length, true);
      h.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
      h.setUint32(42, e.offset, true);
      cd.push(new Uint8Array(h.buffer), e.name);
    }
    const size = cd.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, END, true);
    end.setUint16(8, this.#central.length, true);
    end.setUint16(10, this.#central.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, start, true);
    return new Blob([...this.#chunks, ...cd, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
}

/** @param {number} ms */
function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Reads a whole archive into memory. Supports stored and deflated entries,
 * checks every CRC-32, and skips folder entries.
 * @param {Uint8Array} zip
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(zip) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('this is not a zip archive');
  const count = v.getUint16(end + 10, true);
  const cdOffset = v.getUint32(end + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || v.getUint32(p, true) !== CENTRAL) throw new ZipError('the archive index is damaged');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = text(zip.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new ZipError(`${name} is encrypted with zip encryption, which annai does not read`);
    if (local + 30 > zip.length || v.getUint32(local, true) !== LOCAL) throw new ZipError(`the entry ${name} is damaged`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + csize);
    /** @type {Uint8Array} */
    let bytes;
    if (method === 0) bytes = raw.slice();
    else if (method === 8) {
      try {
        bytes = await inflateRaw(raw);
      } catch {
        throw new ZipError(`${name} is corrupted (it cannot be decompressed)`);
      }
    } else throw new ZipError(`${name} uses compression method ${method}, which annai does not read`);
    if (bytes.length !== usize || crc32(bytes) !== crc) throw new ZipError(`${name} is corrupted (checksum mismatch)`);
    out.set(name, bytes);
  }
  return out;
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `node --test test/unit/zip.test.js`
Expected: 8 tests pass (the Info-ZIP test is skipped only if `unzip` is missing).

- [ ] **Step 6: Commit**

```bash
git add src/core/zip.js test/unit/zip.test.js test/fixtures/infozip.zip
git commit -m "Add a zip writer and reader on CompressionStream"
```

---

### Task 9: Archive encryption

**Files:**
- Create: `src/core/archive-crypto.js`, `test/unit/archive-crypto.test.js`

**Interfaces:**
- Produces:
  - `encrypt(bytes: Uint8Array, passphrase: string, iterations?: number): Promise<Uint8Array>`
  - `decrypt(bytes: Uint8Array, passphrase: string): Promise<Uint8Array>`
  - `isEncrypted(bytes: Uint8Array): boolean`
  - `ITERATIONS = 600000`
  - `class PassphraseError extends Error`

- [ ] **Step 1: Write the failing test** `test/unit/archive-crypto.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, isEncrypted, PassphraseError } from '../../src/core/archive-crypto.js';
import { utf8, text } from '../../src/core/bytes.js';

const FAST = 100_000; // the minimum accepted; production uses ITERATIONS

test('round-trips with the right passphrase', async () => {
  const enc = await encrypt(utf8('our trip'), 'correct horse', FAST);
  assert.equal(isEncrypted(enc), true);
  assert.equal(isEncrypted(utf8('PK\u0003\u0004')), false);
  assert.equal(text(await decrypt(enc, 'correct horse')), 'our trip');
});

test('a wrong passphrase or a changed byte is refused', async () => {
  const enc = await encrypt(utf8('our trip'), 'correct horse', FAST);
  await assert.rejects(decrypt(enc, 'wrong'), PassphraseError);
  const bad = enc.slice();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(decrypt(bad, 'correct horse'), PassphraseError);
});

test('composed and decomposed passphrases are the same passphrase', async () => {
  const enc = await encrypt(utf8('x'), 'café', FAST);
  assert.equal(text(await decrypt(enc, 'café')), 'x');
});

test('empty passphrases, plain files and damaged headers are refused', async () => {
  await assert.rejects(encrypt(utf8('x'), ''), PassphraseError);
  await assert.rejects(decrypt(utf8('PK plain zip'), 'p'), (e) => e instanceof PassphraseError && /not encrypted/.test(e.message));
  const enc = await encrypt(utf8('x'), 'p', FAST);
  const bad = enc.slice();
  new DataView(bad.buffer).setUint32(11, 1); // iterations field right after the 11-byte magic
  await assert.rejects(decrypt(bad, 'p'), (e) => e instanceof PassphraseError && /damaged/.test(e.message));
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test test/unit/archive-crypto.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/core/archive-crypto.js`**

```js
import { utf8, concat } from './bytes.js';

/** File layout: MAGIC | iterations (u32, big-endian) | salt (16) | iv (12) | AES-GCM ciphertext + tag. */
const MAGIC = utf8('ANNAI-ENC1\n');
export const ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

export class PassphraseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PassphraseError';
  }
}

/** @param {Uint8Array} bytes */
export function isEncrypted(bytes) {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/** @param {string} passphrase @param {Uint8Array} salt @param {number} iterations */
async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', utf8(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypts a whole archive with a passphrase (PBKDF2-SHA-256 → AES-256-GCM).
 * @param {Uint8Array} bytes @param {string} passphrase @param {number} [iterations]
 */
export async function encrypt(bytes, passphrase, iterations = ITERATIONS) {
  if (!passphrase) throw new PassphraseError('Enter a passphrase to encrypt the file.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: MAGIC }, key, bytes));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, iterations);
  return concat([MAGIC, head, salt, iv, ct]);
}

/** @param {Uint8Array} bytes @param {string} passphrase */
export async function decrypt(bytes, passphrase) {
  if (!isEncrypted(bytes)) throw new PassphraseError('This file is not encrypted.');
  let o = MAGIC.length;
  const iterations = new DataView(bytes.buffer, bytes.byteOffset + o, 4).getUint32(0);
  o += 4;
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new PassphraseError('This file is damaged.');
  const salt = bytes.slice(o, o + 16);
  const iv = bytes.slice(o + 16, o + 28);
  const key = await deriveKey(passphrase, salt, iterations);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: MAGIC }, key, bytes.slice(o + 28)));
  } catch {
    throw new PassphraseError('Wrong passphrase, or the file is damaged.');
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/unit/archive-crypto.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/archive-crypto.js test/unit/archive-crypto.test.js
git commit -m "Add passphrase encryption for archives"
```

---

### Task 10: Archive export and import

**Files:**
- Create: `src/core/archive.js`, `test/unit/archive.test.js`
- Modify: `docs/superpowers/specs/2026-10-15-annai-design.md`. In §12.1 the events file moves to `trips/<id>/.annai/events.jsonl`, and system scopes go under `system/`. In §4.3, note that `/.annai` is reserved.

**Interfaces:**
- Consumes:
  - `Store` (Task 5)
  - `ZipWriter`, `readZip` (Task 8)
  - `encrypt`, `decrypt`, `isEncrypted` (Task 9)
  - `ME`, `SYS`, `SYS_SETTINGS`, `SYS_PLUGINS`, `newId` (Task 7)
  - `validate` (Task 4)
  - `isCompressedType` (Task 3)
- Produces:
  - `exportArchive(store, { kind, scopes?, include, secrets?, passphrase?, iterations?, app, now? }) → Promise<{ blob, filename, manifest }>`
  - `openArchive(bytes, passphrase?) → Promise<{ manifest, entries }>`
  - `describeArchive(store, opened) → Promise<Description>`
  - `importArchive(store, opened, choices) → Promise<{ trips: string[], archived: string[], me: boolean, settings: boolean, plugins: boolean, secrets: number }>`
  - `archiveName({ kind, title, encrypted, now })`
  - `PRESETS`, `ARCHIVE_FORMAT`, `MANIFEST_NAME`
  - `ArchiveError`, `NeedsPassphraseError`

Archive layout (spec §12.1, as amended here):
```
annai-archive.json                  manifest (written last)
me/<path>                           files of "me"
trips/<scopeId>/<path>              files of a trip
trips/<scopeId>/.annai/events.jsonl that trip's log (when history is included)
system/settings/<path>, system/plugins/<path>, system/log/.annai/events.jsonl
blobs/<sha256>                      older versions referenced by the logs
system/secrets.json                 API keys (encrypted backups only)
```

- [ ] **Step 1: Write the failing test** `test/unit/archive.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, listTrips, ME, SYS_SETTINGS } from '../../src/core/scopes.js';
import { updateAppSettings, readAppSettings } from '../../src/core/settings.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, describeArchive, importArchive, archiveName, PRESETS, ArchiveError, NeedsPassphraseError, MANIFEST_NAME } from '../../src/core/archive.js';
import { PassphraseError } from '../../src/core/archive-crypto.js';
import { ZipWriter, readZip } from '../../src/core/zip.js';
import { utf8, text } from '../../src/core/bytes.js';

const FAST = 100_000;
const bytesOf = async (/** @type {Blob} */ b) => new Uint8Array(await b.arrayBuffer());

async function device() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  return { store, ws };
}

/** @param {Workspace} ws */
async function sampleTrip(ws) {
  const id = await createTrip(ws, { title: '京都 in spring', start: '2027-04-03', end: '2027-04-10' });
  await ws.write(id, '/notes/案内.md', 'first', { author: 'user' });
  await ws.write(id, '/notes/案内.md', 'second', { author: 'shiori' });
  await ws.write(id, '/plan/dinner.json', { id: 'dinner', title: 'Dinner', fixed: true }, { author: 'user' });
  await ws.write(id, '/files/photo.jpg', crypto.getRandomValues(new Uint8Array(4096)), { author: 'user' });
  return id;
}

/** @param {Workspace} ws @param {string} scope */
async function snapshot(ws, scope) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const f of await ws.list(scope)) out[f.path] = { type: f.type, author: f.author, hash: f.hash, created: f.created, modified: f.modified };
  return out;
}

test('a backup of everything restores onto an empty device, history included', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  await a.ws.write(ME, '/profile.md', '# Profile\n\n- What to call me: Yufei\n', { author: 'user' });
  await updateAppSettings(a.ws, { units: 'metric' });
  const { blob, manifest, filename } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  assert.match(filename, /^annai-backup-\d{4}-\d{2}-\d{2}\.annai\.zip$/);
  assert.equal(manifest.kind, 'everything');

  const b = await device();
  const opened = await openArchive(await bytesOf(blob));
  const desc = await describeArchive(b.store, opened);
  assert.deepEqual(desc.trips.map((t) => [t.title, t.existing]), [['京都 in spring', null]]);
  const result = await importArchive(b.store, opened, { me: 'replace', settings: 'replace' });
  assert.equal(result.trips.length, 1);
  const copy = result.trips[0];
  assert.deepEqual(await snapshot(b.ws, copy), await snapshot(a.ws, trip));
  assert.equal(await b.ws.readText(copy, '/notes/案内.md'), 'second');
  const history = await b.ws.history(copy, '/notes/案内.md');
  assert.equal(history.length, 2);
  await b.ws.restore(copy, '/notes/案内.md', history[0].new, { author: 'user' });
  assert.equal(await b.ws.readText(copy, '/notes/案内.md'), 'first');
  assert.match(await b.ws.readText(ME, '/profile.md'), /Yufei/);
  assert.equal((await readAppSettings(b.ws)).units, 'metric');
  const evA = await a.store.tx(['events'], 'readonly', (t) => t.listEvents(trip));
  const evB = await b.store.tx(['events'], 'readonly', (t) => t.listEvents(copy));
  assert.deepEqual(evB.slice(0, -1).map((e) => [e.seq, e.type, e.data]), evA.map((e) => [e.seq, e.type, e.data]));
  assert.equal(evB.at(-1).type, 'import');
});

test('the share preset leaves out memory and history', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['/files/photo.jpg', '/notes/案内.md', '/plan/dinner.json', '/trip.json']);
  assert.equal(manifest.blobs.length, 0);
  assert.equal(manifest.scopes[0].events, undefined);
  const b = await device();
  const r = await importArchive(b.store, await openArchive(await bytesOf(blob)));
  assert.equal(await b.ws.readText(r.trips[0], '/memory.md'), undefined);
  assert.deepEqual(await b.ws.history(r.trips[0], '/notes/案内.md'), []);
});

test('photos can be left out', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: { history: false, memory: true, photos: false }, app: '0.1.0' });
  assert.equal(manifest.files.some((f) => f.path === '/files/photo.jpg'), false);
});

test('encrypted exports need the passphrase', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob, filename } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, passphrase: 'pine needle', iterations: FAST, app: '0.1.0' });
  assert.match(filename, /^annai-in-spring-\d{4}-\d{2}-\d{2}\.annai$/);
  const bytes = await bytesOf(blob);
  await assert.rejects(openArchive(bytes), NeedsPassphraseError);
  await assert.rejects(openArchive(bytes, 'wrong'), PassphraseError);
  const opened = await openArchive(bytes, 'pine needle');
  assert.equal(opened.manifest.encrypted, true);
});

test('a tampered entry is refused, and nothing is imported', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const entries = await readZip(await bytesOf(blob));
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name.endsWith('案内.md') ? utf8('evil') : bytes);
  const b = await device();
  await assert.rejects(openArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /damaged/.test(e.message) && /案内\.md/.test(e.message));
  assert.deepEqual((await listTrips(b.store)).active, []);
});

test('an archive from a newer annai is refused', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  const entries = await readZip(await bytesOf(blob));
  const manifest = JSON.parse(text(entries.get(MANIFEST_NAME)));
  manifest.format = 99;
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name === MANIFEST_NAME ? utf8(JSON.stringify(manifest)) : bytes);
  await assert.rejects(openArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /newer version of annai/.test(e.message));
});

test('something that is not an annai file is refused', async () => {
  await assert.rejects(openArchive(utf8('hello')), ArchiveError);
  const z = new ZipWriter();
  await z.add('readme.txt', utf8('hi'));
  await assert.rejects(openArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /isn't an annai file/.test(e.message));
});

test('"replace mine" archives the existing copy; "add as new" keeps both', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const bytes = await bytesOf(blob);
  const b = await device();
  const first = (await importArchive(b.store, await openArchive(bytes))).trips[0];
  const opened = await openArchive(bytes);
  const desc = await describeArchive(b.store, opened);
  assert.equal(desc.trips[0].existing, first);
  const r = await importArchive(b.store, opened, { trips: { [trip]: 'replace' } });
  assert.deepEqual(r.archived, [first]);
  const trips = await listTrips(b.store);
  assert.deepEqual(trips.active.map((s) => s.id), r.trips);
  assert.deepEqual(trips.archived.map((s) => s.id), [first]);
  const again = await importArchive(b.store, await openArchive(bytes), { trips: { [trip]: 'new' } });
  assert.equal((await listTrips(b.store)).active.length, 2);
  assert.equal(again.archived.length, 0);
});

test('API keys travel only in encrypted backups of everything, and only when chosen', async () => {
  const a = await device();
  await a.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('openrouter', 'sk-or-1'));
  await assert.rejects(exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, secrets: true, app: '0.1.0' }), ArchiveError);
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, secrets: true, passphrase: 'p', iterations: FAST, app: '0.1.0' });
  const bytes = await bytesOf(blob);
  const b = await device();
  const without = await importArchive(b.store, await openArchive(bytes, 'p'));
  assert.equal(without.secrets, 0);
  assert.equal(await b.store.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), undefined);
  const withKeys = await importArchive(b.store, await openArchive(bytes, 'p'), { secrets: true });
  assert.equal(withKeys.secrets, 1);
  assert.equal(await b.store.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), 'sk-or-1');
});

test('a 5 MB photo round-trips byte for byte', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'Big Sur' });
  const photo = new Uint8Array(5 * 1024 * 1024);
  for (let i = 0; i < photo.length; i += 65536) crypto.getRandomValues(photo.subarray(i, i + 65536));
  await a.ws.write(trip, '/files/bixby.jpg', photo, { author: 'user' });
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  const b = await device();
  const r = await importArchive(b.store, await openArchive(await bytesOf(blob)));
  assert.deepEqual((await b.ws.read(r.trips[0], '/files/bixby.jpg'))?.bytes, photo);
});

test('Japanese names round-trip and file names stay readable', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: '京都' });
  await a.ws.write(trip, '/notes/伏見稲荷.md', '千本鳥居', { author: 'user' });
  const { blob, filename } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  assert.match(filename, /^annai-trip-/);
  const b = await device();
  const r = await importArchive(b.store, await openArchive(await bytesOf(blob)));
  assert.equal(await b.ws.readText(r.trips[0], '/notes/伏見稲荷.md'), '千本鳥居');
  assert.equal(archiveName({ kind: 'trip', title: 'Big Sur · Thanksgiving', encrypted: false, now: Date.UTC(2026, 10, 30) }), 'annai-big-sur-thanksgiving-2026-11-30.annai.zip');
});

test('settings are kept unless the user chooses to replace them', async () => {
  const a = await device();
  await updateAppSettings(a.ws, { units: 'imperial' });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  await updateAppSettings(b.ws, { units: 'metric' });
  await importArchive(b.store, await openArchive(await bytesOf(blob)));
  assert.equal((await readAppSettings(b.ws)).units, 'metric');
  assert.equal((await b.ws.list(SYS_SETTINGS)).length, 1);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test test/unit/archive.test.js`
Expected: FAIL with `Cannot find module '.../archive.js'`.

- [ ] **Step 3: Implement `src/core/archive.js`**

```js
import { ZipWriter, readZip } from './zip.js';
import { encrypt, decrypt, isEncrypted } from './archive-crypto.js';
import { sha256Hex } from './hash.js';
import { utf8, text, ownBuffer } from './bytes.js';
import { isCompressedType } from './paths.js';
import { validate } from './schema.js';
import { ME, SYS, SYS_SETTINGS, SYS_PLUGINS, newId } from './scopes.js';

/**
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').ScopeRecord} ScopeRecord
 * @typedef {import('./types.js').EventRecord} EventRecord
 * @typedef {{ history: boolean, memory: boolean, photos: boolean }} Include
 * @typedef {{ dir: string, record: ScopeRecord, events?: string }} ManifestScope
 * @typedef {{ name: string, scope: string, path: string, hash: string, size: number, type: string,
 *   author: string, source?: string, created: number, modified: number }} ManifestFile
 * @typedef {{ format: number, app: string, kind: 'trip'|'everything', created: number, include: Include,
 *   encrypted: boolean, scopes: ManifestScope[], files: ManifestFile[],
 *   blobs: { name: string, hash: string, type: string, size: number }[],
 *   extras: { name: string, hash: string }[], secrets?: string }} Manifest
 * @typedef {{ manifest: Manifest, entries: Map<string, Uint8Array> }} OpenedArchive
 */

export const ARCHIVE_FORMAT = 1;
export const MANIFEST_NAME = 'annai-archive.json';

/** Export presets (spec §12.2). */
export const PRESETS = Object.freeze({
  backup: Object.freeze({ history: true, memory: true, photos: true }),
  share: Object.freeze({ history: false, memory: false, photos: true }),
});

export class ArchiveError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export class NeedsPassphraseError extends ArchiveError {
  constructor() {
    super('This file is encrypted. Enter its passphrase to open it.');
    this.name = 'NeedsPassphraseError';
  }
}

/** @type {Record<string, string>} */
const DIRS = { [ME]: 'me', [SYS]: 'system/log', [SYS_SETTINGS]: 'system/settings', [SYS_PLUGINS]: 'system/plugins' };
const dirFor = (/** @type {string} */ id) => DIRS[id] ?? `trips/${id}`;

const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['format', 'app', 'kind', 'created', 'include', 'scopes', 'files', 'blobs', 'extras'],
  properties: {
    format: { type: 'integer', minimum: 1 },
    kind: { enum: ['trip', 'everything'] },
    scopes: { type: 'array', items: { type: 'object', required: ['dir', 'record'] } },
    files: { type: 'array', items: { type: 'object', required: ['name', 'scope', 'path', 'hash', 'size', 'type'] } },
    blobs: { type: 'array', items: { type: 'object', required: ['name', 'hash', 'type', 'size'] } },
    extras: { type: 'array', items: { type: 'object', required: ['name', 'hash'] } },
  },
};

/**
 * Builds an archive of one trip or of everything (spec §12.1–12.2).
 * @param {Store} store
 * @param {{ kind: 'trip'|'everything', scopes?: string[], include: Include, secrets?: boolean,
 *   passphrase?: string, iterations?: number, app: string, now?: number }} opts
 * @returns {Promise<{ blob: Blob, filename: string, manifest: Manifest }>}
 */
export async function exportArchive(store, opts) {
  const now = opts.now ?? Date.now();
  if (opts.secrets && (opts.kind !== 'everything' || !opts.passphrase)) {
    throw new ArchiveError('API keys can only be included in an encrypted backup of everything.');
  }
  const all = await store.tx(['scopes'], 'readonly', (t) => t.listScopes());
  const scopes = opts.kind === 'trip'
    ? all.filter((s) => s.kind === 'trip' && (opts.scopes ?? []).includes(s.id))
    : all.filter((s) => s.id !== SYS || opts.include.history);
  if (!scopes.length) throw new ArchiveError('There is nothing to export.');

  /** @type {Manifest} */
  const manifest = {
    format: ARCHIVE_FORMAT, app: opts.app, kind: opts.kind, created: now, include: { ...opts.include },
    encrypted: Boolean(opts.passphrase), scopes: [], files: [], blobs: [], extras: [],
  };
  const zip = new ZipWriter();
  /** @type {Set<string>} */ const current = new Set();
  /** @type {Set<string>} */ const historic = new Set();

  for (const scope of scopes) {
    const dir = dirFor(scope.id);
    const { files, events } = await store.tx(['files', 'events'], 'readonly', async (t) => ({
      files: await t.listFiles(scope.id, '/'),
      events: opts.include.history ? await t.listEvents(scope.id) : [],
    }));
    /** @type {ManifestScope} */
    const ms = { dir, record: scope };
    for (const f of files) {
      if (!opts.include.memory && f.path === '/memory.md' && scope.kind !== 'sys') continue;
      if (!opts.include.photos && f.path.startsWith('/files/') && f.type.startsWith('image/')) continue;
      const name = dir + f.path;
      await zip.add(name, await readBlob(store, f.hash, f.path), { compress: !isCompressedType(f.type), mtime: f.modified });
      manifest.files.push({
        name, scope: scope.id, path: f.path, hash: f.hash, size: f.size, type: f.type, author: f.author,
        created: f.created, modified: f.modified, ...(f.source ? { source: f.source } : {}),
      });
      current.add(f.hash);
    }
    if (events.length) {
      const name = `${dir}/.annai/events.jsonl`;
      const body = utf8(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      await zip.add(name, body, { mtime: now });
      manifest.extras.push({ name, hash: await sha256Hex(body) });
      ms.events = name;
      for (const e of events) {
        for (const h of [e.data?.old, e.data?.new]) if (typeof h === 'string') historic.add(h);
        for (const r of e.refs ?? []) historic.add(r);
      }
    }
    manifest.scopes.push(ms);
  }

  for (const hash of historic) {
    if (current.has(hash)) continue;
    const rec = await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
    if (!rec) continue;
    const name = `blobs/${hash}`;
    await zip.add(name, new Uint8Array(rec.data), { compress: !isCompressedType(rec.type), mtime: now });
    manifest.blobs.push({ name, hash, type: rec.type, size: rec.size });
  }

  if (opts.secrets) {
    const secrets = await store.tx(['secrets'], 'readonly', async (t) => {
      const out = [];
      for (const id of await t.listSecretIds()) out.push({ id, value: await t.getSecret(id) });
      return out;
    });
    const name = 'system/secrets.json';
    const body = utf8(JSON.stringify(secrets));
    await zip.add(name, body, { mtime: now });
    manifest.extras.push({ name, hash: await sha256Hex(body) });
    manifest.secrets = name;
  }

  await zip.add(MANIFEST_NAME, utf8(JSON.stringify(manifest, null, 2)), { mtime: now });
  let blob = zip.finish();
  if (opts.passphrase) {
    const sealed = await encrypt(new Uint8Array(await blob.arrayBuffer()), opts.passphrase, opts.iterations);
    blob = new Blob([sealed], { type: 'application/octet-stream' });
  }
  const title = opts.kind === 'trip' ? scopes[0].title : '';
  return { blob, manifest, filename: archiveName({ kind: opts.kind, title, encrypted: Boolean(opts.passphrase), now }) };
}

/** @param {Store} store @param {string} hash @param {string} path */
async function readBlob(store, hash, path) {
  const rec = await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
  if (!rec) throw new ArchiveError(`The content of ${path} is missing from storage, so it can't be exported.`);
  return new Uint8Array(rec.data);
}

/**
 * Decrypts (if needed), unzips and verifies an archive. Throws ArchiveError
 * (or NeedsPassphraseError / PassphraseError) without touching storage.
 * @param {Uint8Array} bytes
 * @param {string} [passphrase]
 * @returns {Promise<OpenedArchive>}
 */
export async function openArchive(bytes, passphrase) {
  if (isEncrypted(bytes)) {
    if (!passphrase) throw new NeedsPassphraseError();
    bytes = await decrypt(bytes, passphrase);
  }
  /** @type {Map<string, Uint8Array>} */
  let entries;
  try {
    entries = await readZip(bytes);
  } catch (e) {
    throw new ArchiveError(`This file isn't an annai file, or it is damaged (${/** @type {Error} */ (e).message}).`);
  }
  const raw = entries.get(MANIFEST_NAME);
  if (!raw) throw new ArchiveError("This zip isn't an annai file: it has no annai-archive.json.");
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(text(raw));
  } catch {
    throw new ArchiveError('This file is damaged: its manifest is not readable.');
  }
  if (typeof manifest?.format === 'number' && manifest.format > ARCHIVE_FORMAT) {
    throw new ArchiveError('This file was made by a newer version of annai. Update annai, then open it again.');
  }
  const errors = validate(MANIFEST_SCHEMA, manifest);
  if (errors.length) throw new ArchiveError(`This file is damaged: ${errors.join('; ')}`);
  /** @type {string[]} */
  const problems = [];
  const check = async (/** @type {string} */ name, /** @type {string} */ hash) => {
    const b = entries.get(name);
    if (!b) problems.push(`${name} is missing`);
    else if ((await sha256Hex(b)) !== hash) problems.push(`${name} was changed`);
  };
  for (const f of manifest.files) await check(f.name, f.hash);
  for (const b of manifest.blobs) await check(b.name, b.hash);
  for (const x of manifest.extras) await check(x.name, x.hash);
  if (problems.length) throw new ArchiveError(`This file is damaged: ${problems.join('; ')}.`);
  return { manifest, entries };
}

/**
 * What the import preview shows, including which trips already exist here.
 * @param {Store} store
 * @param {OpenedArchive} opened
 */
export async function describeArchive(store, { manifest }) {
  const local = await store.tx(['scopes'], 'readonly', (t) => t.listScopes());
  const trips = manifest.scopes
    .filter((s) => s.record.kind === 'trip')
    .map((s) => {
      const files = manifest.files.filter((f) => f.scope === s.record.id);
      const existing = local.find((l) => l.kind === 'trip' && l.status === 'active' && l.tripId && l.tripId === s.record.tripId);
      return {
        scope: s.record.id, title: s.record.title, files: files.length,
        bytes: files.reduce((n, f) => n + f.size, 0), history: Boolean(s.events),
        existing: existing?.id ?? null, existingTitle: existing?.title ?? null,
      };
    });
  const has = (/** @type {string} */ id) => manifest.scopes.some((s) => s.record.id === id);
  return {
    kind: manifest.kind, created: manifest.created, app: manifest.app, include: manifest.include,
    encrypted: manifest.encrypted, trips, hasMe: has(ME), hasSettings: has(SYS_SETTINGS), hasPlugins: has(SYS_PLUGINS),
    hasSecrets: Boolean(manifest.secrets),
  };
}

/**
 * Imports an opened archive in one transaction: everything or nothing.
 * Trips default to "new". "me", settings and plugins default to "keep".
 * @param {Store} store
 * @param {OpenedArchive} opened
 * @param {{ trips?: Record<string, 'new'|'replace'|'skip'>, me?: 'keep'|'replace', settings?: 'keep'|'replace',
 *   plugins?: 'keep'|'replace', secrets?: boolean, now?: number }} [choices]
 */
export async function importArchive(store, { manifest, entries }, choices = {}) {
  const now = choices.now ?? Date.now();
  /** @type {{ rec: ScopeRecord, target: string, mode: 'new'|'replace'|'system', files: ManifestFile[], events: EventRecord[] }[]} */
  const plan = [];
  for (const s of manifest.scopes) {
    const rec = s.record;
    /** @type {string} */ let target;
    /** @type {'new'|'replace'|'system'} */ let mode;
    if (rec.kind === 'trip') {
      const choice = choices.trips?.[rec.id] ?? 'new';
      if (choice === 'skip') continue;
      target = newId('trip');
      mode = choice;
    } else if (rec.id === ME && choices.me === 'replace') {
      target = ME; mode = 'system';
    } else if (rec.id === SYS_SETTINGS && choices.settings === 'replace') {
      target = SYS_SETTINGS; mode = 'system';
    } else if (rec.id === SYS_PLUGINS && choices.plugins === 'replace') {
      target = SYS_PLUGINS; mode = 'system';
    } else {
      continue; // kept, or the system log, which belongs to the device it came from
    }
    const files = manifest.files.filter((f) => f.scope === rec.id);
    const events = s.events
      ? text(/** @type {Uint8Array} */ (entries.get(s.events))).split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    plan.push({ rec, target, mode, files, events });
  }
  /** @type {{ id: string, value: any }[]} */
  const secrets = choices.secrets && manifest.secrets ? JSON.parse(text(/** @type {Uint8Array} */ (entries.get(manifest.secrets)))) : [];

  const result = { trips: /** @type {string[]} */ ([]), archived: /** @type {string[]} */ ([]), me: false, settings: false, plugins: false, secrets: 0 };
  await store.tx(['blobs', 'files', 'events', 'scopes', 'secrets'], 'readwrite', async (t) => {
    for (const p of plan) {
      if (p.mode === 'replace') {
        const old = (await t.listScopes()).find((l) => l.kind === 'trip' && l.status === 'active' && l.tripId === p.rec.tripId);
        if (old) {
          await t.putScope({ ...old, status: 'archived', updated: now });
          await t.appendEvent(old.id, { ts: now, type: 'scope.archive', actor: 'user', data: { reason: 'replaced by an import' } });
          result.archived.push(old.id);
        }
      }
      if (p.mode === 'system') await t.deleteScope(p.target);
      await t.putScope({ ...p.rec, id: p.target, status: 'active', updated: now });
      for (const f of p.files) {
        if (!(await t.hasBlob(f.hash))) {
          await t.putBlob({ hash: f.hash, type: f.type, size: f.size, data: ownBuffer(/** @type {Uint8Array} */ (entries.get(f.name))) });
        }
        await t.putFile({
          scope: p.target, path: f.path, hash: f.hash, size: f.size, type: f.type, author: f.author,
          created: f.created, modified: f.modified, ...(f.source ? { source: f.source } : {}),
        });
      }
      for (const e of p.events) await t.putEvent({ ...e, scope: p.target });
      await t.appendEvent(p.target, { ts: now, type: 'import', actor: 'user', data: { created: manifest.created, app: manifest.app, kind: manifest.kind } });
      if (p.rec.kind === 'trip') result.trips.push(p.target);
      else if (p.target === ME) result.me = true;
      else if (p.target === SYS_SETTINGS) result.settings = true;
      else if (p.target === SYS_PLUGINS) result.plugins = true;
    }
    for (const b of manifest.blobs) {
      if (!(await t.hasBlob(b.hash))) {
        await t.putBlob({ hash: b.hash, type: b.type, size: b.size, data: ownBuffer(/** @type {Uint8Array} */ (entries.get(b.name))) });
      }
    }
    for (const s of secrets) {
      await t.putSecret(s.id, s.value);
      result.secrets++;
    }
  });
  return result;
}

/**
 * "annai-<slug>-<yyyy-mm-dd>.annai.zip", or ".annai" when encrypted.
 * @param {{ kind: 'trip'|'everything', title?: string, encrypted: boolean, now: number }} o
 */
export function archiveName({ kind, title, encrypted, now }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const base = kind === 'everything' ? 'backup' : slug(title ?? '');
  return `annai-${base}-${day}${encrypted ? '.annai' : '.annai.zip'}`;
}

/** @param {string} s */
function slug(s) {
  const out = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'trip';
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/unit/archive.test.js && npm test`
Expected: 12 archive tests pass, and the whole unit suite passes.

- [ ] **Step 5: Update the spec to match the archive layout**

In `docs/superpowers/specs/2026-10-15-annai-design.md` §12.1, replace the layout block with the layout shown above this task's steps. Add one sentence to §4.3: "The top-level folder `/.annai` is reserved inside every scope; archives keep their metadata there."

- [ ] **Step 6: Commit**

```bash
git add src/core/archive.js test/unit/archive.test.js docs/superpowers/specs/2026-10-15-annai-design.md
git commit -m "Add archive export, verification and atomic import"
```

---
### Task 11: Plugin registry and plugin host

**Files:**
- Create: `src/core/registry.js`, `src/core/plugins.js`, `test/unit/plugins.test.js`, `test/fixtures/plugins/hello/annai-plugin.json`, `test/fixtures/plugins/hello/index.js`, `test/fixtures/plugins/broken/annai-plugin.json`, `test/fixtures/plugins/broken/index.js`

**Interfaces:**
- Consumes:
  - `Workspace` (Task 6)
  - `SYS_PLUGINS`, `kindOf`, `ensureBaseScopes` (Task 7)
  - `validate`, `makeSchemaFor` (Task 4)
  - `normPath`, `typeForPath` (Task 3)
  - `logEvent` (Task 7)
- Produces:
  - `class Registry({ log?, maxFailures? })`, with methods:
    - `add(pluginId, kind, item) → remove()`
    - `list(kind)`
    - `removePlugin(id)`
    - `guard(pluginId, name, fn)`
    - `isDisabled(id)`
    - `enable(id)`
    - `onChange(fn)`
  - `class PluginError(pluginId, message, cause?)`
  - `class PluginHost({ registry, workspace, importModule?, pluginUrl? })`, with methods:
    - `addBuiltin(moduleUrl)`
    - `install(files: Map<string, Uint8Array>, { source? })`
    - `installed()`
    - `startInstalled() → failures[]`
    - `start(id)`, `stop(id)`
    - `setEnabled(id, enabled)`
    - `uninstall(id)`
    - `describe()` → rows `{ id, name, version, description, builtin, enabled, active, failing }`
  - `API_VERSION = 1`, `MANIFEST_FILE`
  - The plugin API object passed to `activate(annai)`: `{ id, register(kind, item), schemas.register(entry), tools.register(tool), events.append(scope, type, data), files }`.

- [ ] **Step 1: Create the fixtures**

`test/fixtures/plugins/hello/annai-plugin.json`:
```json
{
  "id": "hello",
  "name": "Hello checks",
  "version": "1.0.0",
  "api": 1,
  "entry": "index.js",
  "description": "Test plugin: /hello/*.json files in a trip need a greeting."
}
```

`test/fixtures/plugins/hello/index.js`:
```js
export function activate(annai) {
  return annai.schemas.register({ scope: 'trip', pattern: '/hello/*.json', schema: { type: 'object', required: ['greeting'] } });
}
```

`test/fixtures/plugins/broken/annai-plugin.json`:
```json
{ "id": "broken", "name": "Broken", "version": "0.0.1", "api": 1, "entry": "index.js" }
```

`test/fixtures/plugins/broken/index.js`:
```js
export function activate() {
  throw new Error('this plugin always fails to start');
}
```

- [ ] **Step 2: Write the failing test** `test/unit/plugins.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { utf8 } from '../../src/core/bytes.js';

/** @param {string} dir @param {string} [prefix] */
async function fixture(dir, prefix = '') {
  const root = new URL(`../fixtures/plugins/${dir}/`, import.meta.url);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const name of await readdir(root)) files.set(prefix + name, new Uint8Array(await readFile(new URL(name, root))));
  return files;
}

async function setup() {
  const store = createMemoryStore();
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => logged.push(ev) });
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  // In Node there is no service worker: load installed plugin files from the workspace as data: URLs.
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const host = new PluginHost({ registry, workspace: ws, importModule });
  return { store, ws, registry, host, logged };
}

test('registry: add, list, remove one, remove a plugin, onChange', () => {
  const r = new Registry();
  let changes = 0;
  r.onChange(() => changes++);
  const off = r.add('a', 'tool', { name: 't1' });
  r.add('a', 'tool', { name: 't2' });
  r.add('b', 'tool', { name: 't3' });
  assert.deepEqual(r.list('tool').map((t) => t.name), ['t1', 't2', 't3']);
  off();
  r.removePlugin('b');
  assert.deepEqual(r.list('tool').map((t) => t.name), ['t2']);
  assert.equal(changes, 5);
});

test('registry: guard logs failures and switches a plugin off after three in a row', async () => {
  /** @type {any[]} */
  const logged = [];
  const r = new Registry({ log: (ev) => logged.push(ev) });
  r.add('flaky', 'tool', { name: 'x' });
  let fail = true;
  const fn = r.guard('flaky', 'tool x', async () => { if (fail) throw new Error('nope'); return 'ok'; });
  await assert.rejects(fn(), PluginError);
  fail = false;
  assert.equal(await fn(), 'ok'); // success resets the count
  fail = true;
  for (let i = 0; i < 3; i++) await assert.rejects(fn(), PluginError);
  assert.equal(r.isDisabled('flaky'), true);
  assert.deepEqual(r.list('tool'), []);
  assert.deepEqual(logged.map((e) => e.type), ['plugin.error', 'plugin.error', 'plugin.error', 'plugin.error', 'plugin.disabled']);
  await assert.rejects(fn(), /switched off/);
  r.enable('flaky');
  fail = false;
  assert.equal(await fn(), 'ok');
  assert.equal(r.list('tool').length, 1);
});

test('host: built-in core schemas take effect', async () => {
  const { ws, host } = await setup();
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await assert.rejects(createTrip(ws, { title: 'Big Sur', start: 'not a date' }), ValidationError);
  const rows = await host.describe();
  assert.deepEqual(rows.map((r) => [r.id, r.builtin, r.active]), [['core-schemas', true, true]]);
});

test('host: install, start, turn off, turn on and uninstall a plugin', async () => {
  const { ws, host } = await setup();
  const manifest = await host.install(await fixture('hello'));
  assert.equal(manifest.id, 'hello');
  assert.deepEqual((await ws.list(SYS_PLUGINS, '/hello/')).map((f) => f.path), ['/hello/annai-plugin.json', '/hello/index.js']);
  assert.equal((await host.installed()).hello.enabled, true);
  await host.start('hello');
  const trip = await createTrip(ws, { title: 'T' });
  await assert.rejects(ws.write(trip, '/hello/a.json', {}, { author: 'user' }), (e) => e instanceof ValidationError && /greeting/.test(e.message));
  await host.setEnabled('hello', false);
  await ws.write(trip, '/hello/a.json', {}, { author: 'user' });
  await host.setEnabled('hello', true);
  await assert.rejects(ws.write(trip, '/hello/b.json', {}, { author: 'user' }), ValidationError);
  await host.uninstall('hello');
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/hello/'), []);
  assert.equal((await host.installed()).hello, undefined);
  await ws.write(trip, '/hello/c.json', {}, { author: 'user' });
});

test('host: a package inside one folder installs too', async () => {
  const { host } = await setup();
  const m = await host.install(await fixture('hello', 'hello-1.0.0/'));
  assert.equal(m.id, 'hello');
});

test('host: refuses bad packages and writes nothing', async () => {
  const { ws, host } = await setup();
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  const good = await fixture('hello');
  const manifest = JSON.parse(new TextDecoder().decode(good.get('annai-plugin.json')));
  const variant = (/** @type {any} */ changes, /** @type {Record<string, string>} */ extra = {}) => {
    const files = new Map(good);
    files.set('annai-plugin.json', utf8(JSON.stringify({ ...manifest, ...changes })));
    for (const [k, v] of Object.entries(extra)) files.set(k, utf8(v));
    return files;
  };
  const cases = [
    new Map([['index.js', utf8('export {}')]]),
    new Map([['annai-plugin.json', utf8('{not json')]]),
    variant({ id: 'Hello World' }),
    variant({ api: 2 }),
    variant({ entry: 'missing.js' }),
    variant({ id: 'core-schemas' }),
    variant({}, { '../evil.js': 'export {}' }),
  ];
  for (const files of cases) await assert.rejects(host.install(files), PluginError);
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/hello/'), []);
  assert.deepEqual(await host.installed(), {});
});

test('host: a plugin whose activate throws is not started and is logged', async () => {
  const { host, logged } = await setup();
  await host.install(await fixture('broken'));
  await assert.rejects(host.start('broken'), PluginError);
  assert.equal(host.active.has('broken'), false);
  assert.equal(logged.at(-1).type, 'plugin.error');
  const failures = await host.startInstalled();
  assert.deepEqual(failures.map((f) => f.id), ['broken']);
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `node --test test/unit/plugins.test.js`
Expected: FAIL with `Cannot find module '.../registry.js'`.

- [ ] **Step 4: Implement `src/core/registry.js`**

```js
export class PluginError extends Error {
  /** @param {string} pluginId @param {string} message @param {unknown} [cause] */
  constructor(pluginId, message, cause) {
    super(`${pluginId}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'PluginError';
    this.pluginId = pluginId;
  }
}

/**
 * Everything plugins contribute, grouped by kind ("schema", "tool", …).
 * Functions plugins hand over go through guard(): a failure becomes a
 * plugin.error event, and a plugin that fails maxFailures times in a row is
 * switched off until enable() is called (spec §5.5).
 */
export class Registry {
  /** @type {Map<string, { pluginId: string, item: any }[]>} */ #items = new Map();
  /** @type {Map<string, number>} */ #failures = new Map();
  /** @type {Set<string>} */ #disabled = new Set();
  /** @type {Set<() => void>} */ #listeners = new Set();

  /** @param {{ log?: (ev: { type: string, actor: string, data: any }) => unknown, maxFailures?: number }} [opts] */
  constructor(opts = {}) {
    this.log = opts.log ?? (() => {});
    this.maxFailures = opts.maxFailures ?? 3;
  }

  /** @param {string} pluginId @param {string} kind @param {any} item @returns {() => void} removes this contribution */
  add(pluginId, kind, item) {
    const entry = { pluginId, item };
    const list = this.#items.get(kind) ?? [];
    list.push(entry);
    this.#items.set(kind, list);
    this.#emit();
    return () => {
      const l = this.#items.get(kind);
      const i = l ? l.indexOf(entry) : -1;
      if (l && i >= 0) {
        l.splice(i, 1);
        this.#emit();
      }
    };
  }

  /** Contributions of a kind from plugins that are not switched off. @param {string} kind */
  list(kind) {
    return (this.#items.get(kind) ?? []).filter((e) => !this.#disabled.has(e.pluginId)).map((e) => e.item);
  }

  /** @param {string} pluginId */
  removePlugin(pluginId) {
    let changed = false;
    for (const [kind, l] of this.#items) {
      const kept = l.filter((e) => e.pluginId !== pluginId);
      if (kept.length !== l.length) {
        this.#items.set(kind, kept);
        changed = true;
      }
    }
    if (changed) this.#emit();
  }

  /** @param {string} pluginId */
  isDisabled(pluginId) {
    return this.#disabled.has(pluginId);
  }

  /** Clears a plugin's failure count and switches it back on. @param {string} pluginId */
  enable(pluginId) {
    this.#failures.delete(pluginId);
    if (this.#disabled.delete(pluginId)) this.#emit();
  }

  /**
   * @template {(...args: any[]) => any} F
   * @param {string} pluginId @param {string} name what the function is, for messages
   * @param {F} fn
   * @returns {(...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>}
   */
  guard(pluginId, name, fn) {
    return async (...args) => {
      if (this.#disabled.has(pluginId)) throw new PluginError(pluginId, 'is switched off after repeated errors');
      try {
        const result = await fn(...args);
        this.#failures.set(pluginId, 0);
        return result;
      } catch (e) {
        this.#fail(pluginId, name, e);
        throw new PluginError(pluginId, `${name} failed: ${/** @type {any} */ (e)?.message ?? e}`, e);
      }
    };
  }

  /** @param {() => void} fn */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** @param {string} pluginId @param {string} name @param {any} e */
  #fail(pluginId, name, e) {
    const n = (this.#failures.get(pluginId) ?? 0) + 1;
    this.#failures.set(pluginId, n);
    this.#safeLog({ type: 'plugin.error', actor: `plugin:${pluginId}`, data: { name, message: String(e?.message ?? e), count: n } });
    if (n >= this.maxFailures && !this.#disabled.has(pluginId)) {
      this.#disabled.add(pluginId);
      this.#safeLog({ type: 'plugin.disabled', actor: 'system', data: { plugin: pluginId, reason: `failed ${n} times in a row` } });
      this.#emit();
    }
  }

  /** @param {{ type: string, actor: string, data: any }} ev */
  #safeLog(ev) {
    try {
      const r = /** @type {any} */ (this.log(ev));
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      // logging must never break the caller
    }
  }

  #emit() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a registry listener failed', e);
      }
    }
  }
}
```

- [ ] **Step 5: Implement `src/core/plugins.js`**

```js
import { validate } from './schema.js';
import { text } from './bytes.js';
import { normPath, typeForPath } from './paths.js';
import { SYS_PLUGINS } from './scopes.js';
import { logEvent } from './events.js';
import { PluginError } from './registry.js';

/** @typedef {import('./registry.js').Registry} Registry @typedef {import('./workspace.js').Workspace} Workspace */

export const API_VERSION = 1;
export const MANIFEST_FILE = 'annai-plugin.json';
const STATE = '/installed.json';

export const PLUGIN_MANIFEST_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'version', 'api'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,63}$' },
    name: { type: 'string', minLength: 1, maxLength: 80 },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.-]+)?$' },
    api: { type: 'integer', minimum: 1 },
    description: { type: 'string', maxLength: 500 },
    author: { type: 'string', maxLength: 200 },
    homepage: { type: 'string', maxLength: 500 },
    entry: { type: 'string', pattern: '^[^/].*\\.m?js$' },
    skills: { type: 'array', items: { type: 'string' } },
    personalities: { type: 'array', items: { type: 'string' } },
    templates: { type: 'array', items: { type: 'string' } },
    settings: { type: 'object' },
  },
};

/** @param {any} manifest */
function checkManifest(manifest) {
  const id = typeof manifest?.id === 'string' ? manifest.id : 'plugin';
  const errors = validate(PLUGIN_MANIFEST_SCHEMA, manifest);
  if (errors.length) throw new PluginError(id, `its ${MANIFEST_FILE} is not valid: ${errors.join('; ')}`);
  if (manifest.api !== API_VERSION) {
    throw new PluginError(id, `was made for plugin API ${manifest.api}; this version of annai supports API ${API_VERSION}`);
  }
}

/** The folder the package lives in: "" or "name/" when everything sits in one top folder. @param {Map<string, Uint8Array>} files */
function findRoot(files) {
  if (files.has(MANIFEST_FILE)) return '';
  const tops = new Set([...files.keys()].map((n) => n.split('/')[0]));
  if (tops.size === 1) {
    const [top] = tops;
    if (files.has(`${top}/${MANIFEST_FILE}`)) return `${top}/`;
  }
  return '';
}

/**
 * Installs, starts and stops plugins (spec §5). Installed plugin files live
 * in the sys:plugins scope under /<id>/…; the service worker serves them at
 * /plugins/<id>/… so they load as ordinary same-origin modules.
 */
export class PluginHost {
  /** @type {Map<string, { manifest: any, builtin: boolean, dispose: () => void }>} */
  active = new Map();
  /** @type {Map<string, any>} built-in manifests by id */
  builtins = new Map();

  /**
   * @param {{ registry: Registry, workspace: Workspace, importModule?: (url: string) => Promise<any>,
   *   pluginUrl?: (id: string, file: string) => string }} deps
   */
  constructor({ registry, workspace, importModule = (url) => import(url), pluginUrl = (id, file) => `/plugins/${encodeURIComponent(id)}/${file}` }) {
    this.registry = registry;
    this.ws = workspace;
    this.importModule = importModule;
    this.pluginUrl = pluginUrl;
  }

  /** Starts a plugin that ships with the app. @param {string} moduleUrl */
  async addBuiltin(moduleUrl) {
    const mod = await this.importModule(moduleUrl);
    checkManifest(mod.manifest);
    this.builtins.set(mod.manifest.id, mod.manifest);
    await this.#start(mod.manifest, mod, true);
    return mod.manifest;
  }

  /** @returns {Promise<Record<string, { version: string, name: string, enabled: boolean, installed: number, source: string }>>} */
  async installed() {
    return (await this.ws.readJSON(SYS_PLUGINS, STATE)) ?? {};
  }

  /**
   * Installs (or replaces) a plugin from its files, e.g. an unzipped package.
   * Everything is checked before anything is written.
   * @param {Map<string, Uint8Array>} files
   * @param {{ source?: string }} [opts]
   */
  async install(files, { source = 'file' } = {}) {
    const root = findRoot(files);
    const raw = files.get(root + MANIFEST_FILE);
    if (!raw) throw new PluginError('plugin', `there is no ${MANIFEST_FILE} in this package`);
    /** @type {any} */
    let manifest;
    try {
      manifest = JSON.parse(text(raw));
    } catch {
      throw new PluginError('plugin', `its ${MANIFEST_FILE} is not valid JSON`);
    }
    checkManifest(manifest);
    const id = manifest.id;
    if (this.builtins.has(id)) throw new PluginError(id, 'has the same id as a plugin built into annai');
    if (manifest.entry && !files.has(root + manifest.entry)) throw new PluginError(id, `its entry file ${manifest.entry} is missing`);
    /** @type {[string, Uint8Array][]} */
    const toWrite = [];
    for (const [name, bytes] of files) {
      if (!name.startsWith(root) || name.endsWith('/')) continue;
      const rel = name.slice(root.length);
      try {
        toWrite.push([normPath(`/${id}/${rel}`), bytes]);
      } catch {
        throw new PluginError(id, `the file name "${rel}" isn't allowed`);
      }
    }
    await this.stop(id);
    for (const f of await this.ws.list(SYS_PLUGINS, `/${id}/`)) await this.ws.delete(SYS_PLUGINS, f.path, { author: 'system' });
    for (const [path, bytes] of toWrite) await this.ws.write(SYS_PLUGINS, path, bytes, { author: 'system', type: typeForPath(path) });
    await this.#updateState(id, { version: manifest.version, name: manifest.name, enabled: true, installed: this.ws.now(), source });
    return manifest;
  }

  /** Starts every enabled installed plugin; returns the ones that failed. */
  async startInstalled() {
    /** @type {{ id: string, error: unknown }[]} */
    const failures = [];
    for (const [id, s] of Object.entries(await this.installed())) {
      if (!s.enabled) continue;
      try {
        await this.start(id);
      } catch (error) {
        failures.push({ id, error });
      }
    }
    return failures;
  }

  /** @param {string} id */
  async start(id) {
    if (this.active.has(id)) return;
    const manifest = await this.ws.readJSON(SYS_PLUGINS, `/${id}/${MANIFEST_FILE}`);
    if (!manifest) throw new PluginError(id, 'is not installed');
    const mod = manifest.entry ? await this.importModule(this.pluginUrl(id, manifest.entry)) : {};
    await this.#start(manifest, mod, false);
  }

  /** @param {string} id */
  async stop(id) {
    const a = this.active.get(id);
    if (a) {
      this.active.delete(id);
      try {
        a.dispose();
      } catch (e) {
        console.warn(`plugin ${id} failed to stop cleanly`, e);
      }
    }
    this.registry.removePlugin(id);
  }

  /** @param {string} id @param {boolean} enabled */
  async setEnabled(id, enabled) {
    await this.#updateState(id, { enabled });
    if (enabled) {
      this.registry.enable(id);
      await this.start(id);
    } else {
      await this.stop(id);
    }
  }

  /** @param {string} id */
  async uninstall(id) {
    await this.stop(id);
    for (const f of await this.ws.list(SYS_PLUGINS, `/${id}/`)) await this.ws.delete(SYS_PLUGINS, f.path, { author: 'system' });
    const state = await this.installed();
    delete state[id];
    await this.ws.write(SYS_PLUGINS, STATE, state, { author: 'system' });
  }

  /** Rows for the plugins screen. */
  async describe() {
    const rows = [];
    for (const m of this.builtins.values()) {
      rows.push({ id: m.id, name: m.name, version: m.version, description: m.description ?? '', builtin: true, enabled: true, active: this.active.has(m.id), failing: this.registry.isDisabled(m.id) });
    }
    for (const [id, s] of Object.entries(await this.installed())) {
      const m = await this.ws.readJSON(SYS_PLUGINS, `/${id}/${MANIFEST_FILE}`);
      rows.push({ id, name: m?.name ?? s.name ?? id, version: m?.version ?? s.version, description: m?.description ?? '', builtin: false, enabled: Boolean(s.enabled), active: this.active.has(id), failing: this.registry.isDisabled(id) });
    }
    return rows;
  }

  /** @param {any} manifest @param {any} mod @param {boolean} builtin */
  async #start(manifest, mod, builtin) {
    const id = manifest.id;
    let dispose = () => {};
    if (typeof mod?.activate === 'function') {
      const r = await this.registry.guard(id, 'starting', mod.activate)(this.#api(id));
      if (typeof r === 'function') dispose = r;
    } else if (manifest.entry) {
      throw new PluginError(id, 'its module has no activate() function');
    }
    this.active.set(id, { manifest, builtin, dispose });
  }

  /** The object a plugin's activate() receives (milestone 1 subset of spec §5.4). @param {string} id */
  #api(id) {
    const registry = this.registry;
    return Object.freeze({
      id,
      register: (/** @type {string} */ kind, /** @type {any} */ item) => registry.add(id, kind, item),
      schemas: Object.freeze({ register: (/** @type {any} */ entry) => registry.add(id, 'schema', entry) }),
      tools: Object.freeze({
        register: (/** @type {any} */ tool) => registry.add(id, 'tool', { ...tool, run: registry.guard(id, `tool ${tool.name}`, tool.run) }),
      }),
      events: Object.freeze({
        append: (/** @type {string} */ scope, /** @type {string} */ type, /** @type {any} */ data) => logEvent(this.ws.store, scope, { type, actor: `plugin:${id}`, data }),
      }),
      files: this.ws,
    });
  }

  /** @param {string} id @param {Record<string, any>} changes */
  async #updateState(id, changes) {
    const state = await this.installed();
    state[id] = { ...state[id], ...changes };
    await this.ws.write(SYS_PLUGINS, STATE, state, { author: 'system' });
  }
}
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `node --test test/unit/plugins.test.js && npm test`
Expected: 7 plugin tests pass, and the whole suite passes.

- [ ] **Step 7: Commit**

```bash
git add src/core/registry.js src/core/plugins.js test/unit/plugins.test.js test/fixtures/plugins
git commit -m "Add the plugin registry and the plugin host"
```

---

### Task 12: IndexedDB store, dev server and browser test harness

**Files:**
- Create: `src/core/store-idb.js`, `_headers`, `scripts/headers.mjs`, `scripts/serve.mjs`, `playwright.config.js`, `test/browser/index.html`, `test/browser/run.js`, `test/browser/mini-test.js`, `test/browser/suites/store-idb.js`, `test/browser/suites/platform.js`, `test/e2e/browser-suites.spec.js`, `test/unit/headers.test.js`

**Interfaces:**
- Consumes:
  - `storeContract` (Task 5)
  - Everything in the core, for the platform suite
- Produces:
  - `createIdbStore(name = 'annai', { onOpen? }) → Promise<Store>`
  - `openDatabase(name)`, `eraseDatabase(name)`
  - `DB_NAME = 'annai'`, `DB_VERSION = 1`
  - `parseHeaders(src)`, `headersFor(rules, path)`
  - A dev server on `http://127.0.0.1:8765`
  - `window.__results` for in-browser suites

- [ ] **Step 1: Write the headers file and its test**

`_headers` (Cloudflare Pages format; the dev server applies it too):
```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; img-src 'self' blob: data: https:; media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self), microphone=(self), geolocation=(self)
/sw.js
  Cache-Control: no-cache
```

`test/unit/headers.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHeaders, headersFor } from '../../scripts/headers.mjs';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; img-src 'self' blob: data: https:; media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

test('parses rules and applies wildcard and exact paths', () => {
  const rules = parseHeaders('/*\n  A: 1\n  B: two words\n# comment\n/sw.js\n  C: 3\n');
  assert.deepEqual([...headersFor(rules, '/x').entries()], [['A', '1'], ['B', 'two words']]);
  assert.deepEqual([...headersFor(rules, '/sw.js').entries()], [['A', '1'], ['B', 'two words'], ['C', '3']]);
});

test('the real _headers carries the spec CSP on every path', async () => {
  const rules = parseHeaders(await readFile(new URL('../../_headers', import.meta.url), 'utf8'));
  assert.equal(headersFor(rules, '/index.html').get('Content-Security-Policy'), CSP);
  assert.equal(headersFor(rules, '/sw.js').get('Cache-Control'), 'no-cache');
});
```

`scripts/headers.mjs`:
```js
/**
 * Parses a Cloudflare Pages style _headers file: a path pattern on its own
 * line, then indented "Name: value" lines. "*" at the end of a pattern matches
 * any rest of the path.
 * @param {string} src
 * @returns {{ pattern: string, headers: [string, string][] }[]}
 */
export function parseHeaders(src) {
  /** @type {{ pattern: string, headers: [string, string][] }[]} */
  const rules = [];
  /** @type {{ pattern: string, headers: [string, string][] } | null} */
  let current = null;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const i = line.indexOf(':');
      if (i > 0) current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

/** @param {ReturnType<typeof parseHeaders>} rules @param {string} path */
export function headersFor(rules, path) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const r of rules) {
    const hit = r.pattern.endsWith('*') ? path.startsWith(r.pattern.slice(0, -1)) : r.pattern === path;
    if (hit) for (const [k, v] of r.headers) out.set(k, v);
  }
  return out;
}
```

Run: `node --test test/unit/headers.test.js`
Expected: 2 tests pass.

- [ ] **Step 2: Write the dev server** `scripts/serve.mjs`

```js
#!/usr/bin/env node
// Static dev server for annai: serves the repository root on 127.0.0.1 with
// the _headers rules applied (so the CSP is enforced during development and tests).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeaders, headersFor } from './headers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argPort = process.argv.indexOf('--port');
const port = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT ?? 8765);
/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon',
};
const rules = parseHeaders(await readFile(join(root, '_headers'), 'utf8'));

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  for (const [k, v] of headersFor(rules, url.pathname)) res.setHeader(k, v);
  if (req.method === 'POST') {
    // Only reached when the service worker did not handle a share (e.g. before it installed).
    res.writeHead(303, { Location: '/#/import' }).end();
    return;
  }
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root) || file.includes(`${sep}.git${sep}`)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`annai dev server: http://127.0.0.1:${port}/`));
```

- [ ] **Step 3: Install the browsers and configure Playwright**

Run: `npx playwright install chromium webkit`. Then check that WebKit launches here with `npx playwright install-deps webkit` (as root). If WebKit still can't launch on this Debian release, run the browser suites with `--project=chromium` locally; CI (Ubuntu) runs both projects.

`playwright.config.js`:
```js
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://127.0.0.1:8765', trace: 'retain-on-failure', acceptDownloads: true },
  webServer: {
    command: 'node scripts/serve.mjs --port 8765',
    url: 'http://127.0.0.1:8765/_headers',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Pixel 7'] } },
    { name: 'webkit', use: { ...devices['iPhone 15'] } },
  ],
});
```

- [ ] **Step 4: Write the in-browser harness**

`test/browser/index.html`:
```html
<!doctype html>
<meta charset="utf-8">
<title>annai browser suites</title>
<script type="module" src="./run.js"></script>
<pre id="out">running…</pre>
```

`test/browser/mini-test.js`:
```js
/** A tiny test runner and assert for suites that run inside the browser. */
export function createRunner() {
  /** @type {{ name: string, fn: () => Promise<void> }[]} */
  const tests = [];
  const test = (/** @type {string} */ name, /** @type {() => Promise<void>} */ fn) => { tests.push({ name, fn }); };
  async function run() {
    const results = [];
    for (const t of tests) {
      try {
        await t.fn();
        results.push({ name: t.name, ok: true });
      } catch (e) {
        results.push({ name: t.name, ok: false, error: String(/** @type {any} */ (e)?.stack ?? e) });
      }
    }
    return results;
  }
  return { test, run };
}

/** @param {any} v */
const show = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

/** @param {any} a @param {any} b @returns {boolean} */
function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) return deepEq(new Uint8Array(a), new Uint8Array(b));
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]));
}

export const assert = {
  /** @param {any} a @param {any} b @param {string} [msg] */
  equal(a, b, msg) { if (!Object.is(a, b)) throw new Error(msg ?? `expected ${show(b)}, got ${show(a)}`); },
  /** @param {any} a @param {any} b @param {string} [msg] */
  deepEqual(a, b, msg) { if (!deepEq(a, b)) throw new Error(msg ?? `expected ${show(b)}, got ${show(a)}`); },
  /** @param {any} v @param {string} [msg] */
  ok(v, msg) { if (!v) throw new Error(msg ?? `expected a truthy value, got ${show(v)}`); },
  /** @param {Promise<any> | (() => Promise<any>)} p @param {any} [expected] class, RegExp or predicate */
  async rejects(p, expected) {
    try {
      await (typeof p === 'function' ? p() : p);
    } catch (e) {
      if (!expected) return;
      if (expected instanceof RegExp && expected.test(String(/** @type {any} */ (e)?.message ?? e))) return;
      if (typeof expected === 'function' && expected.prototype && e instanceof expected) return;
      if (typeof expected === 'function' && !expected.prototype && expected(e)) return;
      throw new Error(`rejected with the wrong error: ${/** @type {any} */ (e)?.name}: ${/** @type {any} */ (e)?.message}`);
    }
    throw new Error('expected a rejection');
  },
};
```

`test/browser/run.js`:
```js
import { createRunner, assert } from './mini-test.js';

const suite = new URLSearchParams(location.search).get('suite') ?? '';
const out = /** @type {HTMLElement} */ (document.getElementById('out'));
if (!/^[a-z0-9-]+$/.test(suite)) {
  out.textContent = 'unknown suite';
  /** @type {any} */ (window).__results = [{ name: 'suite name', ok: false, error: 'unknown suite' }];
} else {
  const { test, run } = createRunner();
  const mod = await import(`./suites/${suite}.js`);
  await mod.default(test, assert);
  const results = await run();
  out.textContent = results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n${r.error}`}`).join('\n');
  /** @type {any} */ (window).__results = results;
}
```

- [ ] **Step 5: Write the browser suites**

`test/browser/suites/store-idb.js`:
```js
import { storeContract } from '../../contract/store-contract.js';
import { createIdbStore, eraseDatabase } from '../../../src/core/store-idb.js';

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  let n = 0;
  const fresh = async () => {
    const name = `annai-test-${Date.now()}-${n++}`;
    await eraseDatabase(name);
    return createIdbStore(name);
  };
  storeContract(test, assert, fresh);

  const rec = { scope: 'trip-1', path: '/a.md', hash: 'h1', size: 1, type: 'text/plain', author: 'user', created: 1, modified: 1 };

  test('idb: data survives closing and reopening', async () => {
    const name = `annai-test-persist-${Date.now()}`;
    const a = await createIdbStore(name);
    await a.tx(['files'], 'readwrite', (t) => t.putFile(rec));
    a.close();
    const b = await createIdbStore(name);
    const f = await b.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md'));
    assert.equal(f.hash, 'h1');
    b.close();
    await eraseDatabase(name);
  });

  test('idb: reopens after the connection is closed under it', async () => {
    const name = `annai-test-lost-${Date.now()}`;
    /** @type {IDBDatabase[]} */
    const connections = [];
    const s = await createIdbStore(name, { onOpen: (db) => connections.push(db) });
    await s.tx(['files'], 'readwrite', (t) => t.putFile(rec));
    connections[0].close(); // what Safari does to a backgrounded page's connection
    const f = await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md'));
    assert.equal(f.hash, 'h1');
    assert.equal(connections.length, 2);
    s.close();
    await eraseDatabase(name);
  });

  test('idb: erasing the database while it is open closes our connection cleanly', async () => {
    const name = `annai-test-erase-${Date.now()}`;
    const s = await createIdbStore(name);
    await s.tx(['files'], 'readwrite', (t) => t.putFile(rec));
    await eraseDatabase(name);
    assert.equal(await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')), undefined);
    s.close();
    await eraseDatabase(name);
  });
}
```

`test/browser/suites/platform.js`:
```js
import { sha256Hex } from '../../../src/core/hash.js';
import { ZipWriter, readZip } from '../../../src/core/zip.js';
import { encrypt, decrypt } from '../../../src/core/archive-crypto.js';
import { utf8, text } from '../../../src/core/bytes.js';
import { createIdbStore, eraseDatabase } from '../../../src/core/store-idb.js';
import { Workspace } from '../../../src/core/workspace.js';
import { makeSchemaFor } from '../../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, importArchive, PRESETS } from '../../../src/core/archive.js';

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('SHA-256 works here', async () => {
    assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('zip with deflate-raw round-trips here', async () => {
    const z = new ZipWriter();
    await z.add('notes/案内.md', utf8('案内 '.repeat(500)));
    const out = await readZip(new Uint8Array(await z.finish().arrayBuffer()));
    assert.equal(text(/** @type {Uint8Array} */ (out.get('notes/案内.md'))), '案内 '.repeat(500));
  });

  test('archive encryption round-trips here', async () => {
    const enc = await encrypt(utf8('trip'), 'pass', 100_000);
    assert.equal(text(await decrypt(enc, 'pass')), 'trip');
  });

  test('a trip exported from one IndexedDB imports into another', async () => {
    const names = [`annai-test-a-${Date.now()}`, `annai-test-b-${Date.now()}`];
    for (const n of names) await eraseDatabase(n);
    const [sa, sb] = await Promise.all(names.map((n) => createIdbStore(n)));
    const lookup = makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf);
    const a = new Workspace(sa, { schemaFor: lookup });
    const b = new Workspace(sb, { schemaFor: lookup });
    await ensureBaseScopes(a);
    await ensureBaseScopes(b);
    const trip = await createTrip(a, { title: 'Big Sur' });
    await a.write(trip, '/notes/day1.md', 'one', { author: 'user' });
    await a.write(trip, '/notes/day1.md', 'two', { author: 'user' });
    await a.write(trip, '/files/photo.jpg', crypto.getRandomValues(new Uint8Array(30000)), { author: 'user' });
    const { blob } = await exportArchive(sa, { kind: 'trip', scopes: [trip], include: PRESETS.backup, passphrase: 'p', iterations: 100_000, app: '0.1.0' });
    const r = await importArchive(sb, await openArchive(new Uint8Array(await blob.arrayBuffer()), 'p'));
    const copy = r.trips[0];
    assert.equal(await b.readText(copy, '/notes/day1.md'), 'two');
    assert.equal((await b.history(copy, '/notes/day1.md')).length, 2);
    assert.deepEqual((await b.read(copy, '/files/photo.jpg'))?.bytes, (await a.read(trip, '/files/photo.jpg'))?.bytes);
    sa.close();
    sb.close();
    for (const n of names) await eraseDatabase(n);
  });
}
```

`test/e2e/browser-suites.spec.js`:
```js
import { test, expect } from '@playwright/test';

for (const suite of ['store-idb', 'platform']) {
  test(`browser suite: ${suite}`, async ({ page }) => {
    await page.goto(`/test/browser/index.html?suite=${suite}`);
    const handle = await page.waitForFunction(() => /** @type {any} */ (window).__results, null, { timeout: 120_000 });
    /** @type {{ name: string, ok: boolean, error?: string }[]} */
    const results = await handle.jsonValue();
    const failed = results.filter((r) => !r.ok);
    expect(failed, failed.map((f) => `${f.name}\n${f.error}`).join('\n\n')).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(4);
  });
}
```

- [ ] **Step 6: Run the e2e suites and verify they fail**

Run: `npx playwright test test/e2e/browser-suites.spec.js --project=chromium`
Expected: FAIL, because the suites can't import `src/core/store-idb.js`.

- [ ] **Step 7: Implement `src/core/store-idb.js`**

```js
/** @typedef {import('./types.js').Store} Store @typedef {import('./types.js').Tx} Tx */

export const DB_NAME = 'annai';
export const DB_VERSION = 1;

/** Opens the database, creating or upgrading it. @param {string} [name] @returns {Promise<IDBDatabase>} */
export function openDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('annai is open in another tab that needs to close first.'));
  });
}

/** Ordered migrations, each in the all-or-nothing versionchange transaction (spec §4.6). @param {IDBDatabase} db @param {number} from */
function upgrade(db, from) {
  if (from < 1) {
    db.createObjectStore('blobs', { keyPath: 'hash' });
    db.createObjectStore('files', { keyPath: ['scope', 'path'] });
    db.createObjectStore('events', { keyPath: ['scope', 'seq'] });
    db.createObjectStore('secrets', { keyPath: 'id' });
    db.createObjectStore('scopes', { keyPath: 'id' });
  }
}

/** Deletes a whole database (used by "Erase everything" and by tests). @param {string} [name] */
export function eraseDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(req.error);
  });
}

/**
 * The IndexedDB Store. If the connection is lost (Safari drops it after the
 * page has been in the background), the next transaction reopens it and
 * retries once; a failed transaction never commits, so the retry is safe.
 * @param {string} [name]
 * @param {{ onOpen?: (db: IDBDatabase) => void }} [hooks] test hook: sees every connection opened
 * @returns {Promise<Store>}
 */
export async function createIdbStore(name = DB_NAME, hooks = {}) {
  /** @type {IDBDatabase | null} */
  let db = null;
  const connect = async () => {
    const d = await openDatabase(name);
    d.onversionchange = () => {
      d.close();
      if (db === d) db = null;
    };
    d.onclose = () => {
      if (db === d) db = null;
    };
    hooks.onOpen?.(d);
    db = d;
    return d;
  };
  await connect();
  return {
    async tx(stores, mode, fn) {
      for (let attempt = 0; ; attempt++) {
        const d = db ?? (await connect());
        try {
          return await runTx(d, stores, mode, fn);
        } catch (e) {
          if (attempt === 0 && connectionLost(e)) {
            if (db === d) db = null;
            continue;
          }
          throw e;
        }
      }
    },
    close() {
      db?.close();
      db = null;
    },
  };
}

/** @param {any} e */
function connectionLost(e) {
  return e?.name === 'InvalidStateError' || /connection (is )?(lost|closing|closed)|database (is )?clos/i.test(String(e?.message));
}

/**
 * @template T
 * @param {IDBDatabase} db
 * @param {import('./types.js').StoreName[]} stores
 * @param {'readonly'|'readwrite'} mode
 * @param {(tx: Tx) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runTx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    /** @type {any} */
    let result;
    let settled = false;
    const fail = (/** @type {any} */ e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    t.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    t.onabort = () => fail(t.error ?? new DOMException('The transaction was aborted.', 'AbortError'));
    Promise.resolve()
      .then(() => fn(makeTx(t)))
      .then((r) => { result = r; }, (e) => {
        fail(e);
        try { t.abort(); } catch { /* already finished */ }
      });
  });
}

/** @param {IDBTransaction} t @returns {Tx} */
function makeTx(t) {
  const os = (/** @type {string} */ name) => t.objectStore(name);
  /** @template R @param {IDBRequest<R>} r @returns {Promise<R>} */
  const req = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const seqRange = (/** @type {string} */ scope, /** @type {number} */ lo, /** @type {number} */ hi) => IDBKeyRange.bound([scope, lo], [scope, hi]);
  const pathRange = (/** @type {string} */ scope, /** @type {string} */ prefix) => IDBKeyRange.bound([scope, prefix], [scope, prefix + '￿']);

  /** @type {Tx} */
  const tx = {
    getBlob: (hash) => req(os('blobs').get(hash)),
    hasBlob: async (hash) => (await req(os('blobs').getKey(hash))) !== undefined,
    putBlob: async (rec) => { await req(os('blobs').put(rec)); },
    deleteBlob: async (hash) => { await req(os('blobs').delete(hash)); },
    getFile: (scope, path) => req(os('files').get([scope, path])),
    putFile: async (entry) => { await req(os('files').put(entry)); },
    deleteFile: async (scope, path) => { await req(os('files').delete([scope, path])); },
    listFiles: (scope, prefix = '/') => req(os('files').getAll(pathRange(scope, prefix))),
    lastSeq: (scope) => new Promise((res, rej) => {
      const r = os('events').openKeyCursor(seqRange(scope, -Infinity, Infinity), 'prev');
      r.onsuccess = () => res(r.result ? /** @type {[string, number]} */ (r.result.primaryKey)[1] : 0);
      r.onerror = () => rej(r.error);
    }),
    appendEvent: async (scope, ev) => {
      const seq = (await tx.lastSeq(scope)) + 1;
      const rec = { ...ev, scope, seq };
      await req(os('events').add(rec));
      return rec;
    },
    putEvent: async (rec) => { await req(os('events').put(rec)); },
    listEvents: (scope, q = {}) => new Promise((res, rej) => {
      const lo = (q.after ?? 0) + 1;
      const hi = q.before === undefined ? Infinity : q.before - 1;
      const limit = q.limit ?? Infinity;
      if (lo > hi || limit <= 0) {
        res([]);
        return;
      }
      /** @type {any[]} */
      const out = [];
      const r = os('events').openCursor(seqRange(scope, lo, hi), q.reverse ? 'prev' : 'next');
      r.onsuccess = () => {
        const c = r.result;
        if (!c) {
          res(out);
          return;
        }
        if (!q.types || q.types.includes(c.value.type)) out.push(c.value);
        if (out.length >= limit) {
          res(out);
          return;
        }
        c.continue();
      };
      r.onerror = () => rej(r.error);
    }),
    getScope: (id) => req(os('scopes').get(id)),
    putScope: async (rec) => { await req(os('scopes').put(rec)); },
    listScopes: () => req(os('scopes').getAll()),
    deleteScope: async (id) => {
      await req(os('scopes').delete(id));
      await req(os('files').delete(pathRange(id, '')));
      await req(os('events').delete(seqRange(id, -Infinity, Infinity)));
    },
    getSecret: async (id) => (await req(os('secrets').get(id)))?.value,
    putSecret: async (id, value) => { await req(os('secrets').put({ id, value })); },
    deleteSecret: async (id) => { await req(os('secrets').delete(id)); },
    listSecretIds: async () => /** @type {string[]} */ (await req(os('secrets').getAllKeys())),
  };
  return tx;
}
```

- [ ] **Step 8: Run the browser suites and verify they pass**

Run: `npx playwright test test/e2e/browser-suites.spec.js`
Expected: both suites pass in Chromium (Pixel 7) and WebKit (iPhone 15). If WebKit can't run on this machine, `--project=chromium` passes and the WebKit run is recorded as pending CI.

- [ ] **Step 9: Commit**

```bash
git add src/core/store-idb.js _headers scripts/headers.mjs scripts/serve.mjs playwright.config.js test/browser test/e2e/browser-suites.spec.js test/unit/headers.test.js
git commit -m "Add the IndexedDB store, dev server and in-browser test suites"
```

---
### Task 13: The app shell

**Files:**
- Create:
  - `index.html`, `src/app/main.js`, `src/core/lock.js`
  - `src/ui/dom.js`, `src/ui/router.js`, `src/ui/platform.js`, `src/ui/format.js`, `src/ui/notices.js`, `src/ui/install.js`, `src/ui/shell.js`, `src/ui/import-state.js`, `src/ui/open-file.js`, `src/ui/screens/trips.js`
  - `src/ui/tokens.css`, `src/ui/base.css`
  - `assets/fonts/*.woff2`, `assets/fonts/OFL.txt`
  - `test/unit/ui-pure.test.js`, `test/e2e/helpers.js`, `test/e2e/shell.spec.js`

**Interfaces:**
- Consumes: the whole core (Tasks 1–12).
- Produces:
  - `h(tag, attrs, ...children)`, `field(label, control)`, `checkbox(label, checked)`, `radios(legend, options, value, onChange)`, `twoStep(label, confirmLabel, action)`
  - `parseHash(hash) → { name, parts, params }`
  - `isStandalone()`, `platform()`, `storageStatus()`, `requestPersist()`
  - `relTime(ts, now?)`, `bytes(n)`, `dateRange(start, end?)`
  - `createNotices() → { el, card({ title, body?, tone?, actions? }), toast(text) }`
  - `startShell(root, core) → { notices, render, setUpdateReady(apply) }`
  - `showBlocking(root, { title, body, action, onAction? }) → Promise<boolean>`
  - `acquireInstanceLock({ onHeldElsewhere, onStolen }) → Promise<boolean>`
  - `setPendingImport(file)`, `takePendingImport()`
  - `openFileButton(ctx, label?)`
  - The screen contract, `screen(ctx, route) → Promise<Node>`, where `ctx = { store, ws, registry, plugins, version, notices, go(hash), render(), update }`

- [ ] **Step 1: Write the failing pure-UI test** `test/unit/ui-pure.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash } from '../../src/ui/router.js';
import { relTime, bytes, dateRange } from '../../src/ui/format.js';

test('parseHash: screens, parts and params', () => {
  assert.deepEqual(parseHash(''), { name: 'trips', parts: ['trips'], params: {} });
  assert.deepEqual(parseHash('#/trip/trip-1'), { name: 'trip', parts: ['trip', 'trip-1'], params: {} });
  assert.deepEqual(parseHash('#/trip/trip-1/file?path=%2Fnotes%2F%E6%A1%88%E5%86%85.md'), { name: 'file', parts: ['trip', 'trip-1', 'file'], params: { path: '/notes/案内.md' } });
  assert.deepEqual(parseHash('#/import?inbox=1'), { name: 'import', parts: ['import'], params: { inbox: '1' } });
});

test('parseHash: "#import=<url>" from spec §12.3, with the URL kept whole', () => {
  const url = 'https://example.com/a?b=1&c=2#x';
  assert.deepEqual(parseHash('#import=' + encodeURIComponent(url)), { name: 'import', parts: ['import'], params: { url } });
});

test('format helpers', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  assert.equal(relTime(now - 10_000, now), 'just now');
  assert.match(relTime(now - 2 * 3600_000, now), /2 hours ago/);
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1536), '1.5 KB');
  assert.equal(bytes(5 * 1024 * 1024), '5.0 MB');
  assert.match(dateRange('2026-11-25', '2026-11-29'), /Nov/);
  assert.match(dateRange('2026-11-25', '2026-11-29'), /25/);
  assert.match(dateRange('2026-11-25'), /Nov 25/);
});
```

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL with `Cannot find module '.../router.js'`.

- [ ] **Step 2: Implement `src/ui/router.js` and `src/ui/format.js`**

`src/ui/router.js`:
```js
/**
 * Hash routes: "#/trips", "#/trip/<id>", "#/trip/<id>/file?path=…", "#/settings",
 * "#/plugins", "#/trace", "#/import?inbox=1". "#import=<url>" (spec §12.3)
 * becomes the import screen with that URL.
 * @param {string} hash
 * @returns {{ name: string, parts: string[], params: Record<string, string> }}
 */
export function parseHash(hash) {
  const raw = hash.replace(/^#/, '');
  if (raw.startsWith('import=')) return { name: 'import', parts: ['import'], params: { url: decodeURIComponent(raw.slice('import='.length)) } };
  const h = raw.startsWith('/') ? raw : '/trips';
  const q = h.indexOf('?');
  const path = q < 0 ? h : h.slice(0, q);
  const query = q < 0 ? '' : h.slice(q + 1);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) parts.push('trips');
  const name = parts[0] === 'trip' && parts[2] === 'file' ? 'file' : parts[0];
  return { name, parts, params: Object.fromEntries(new URLSearchParams(query)) };
}
```

`src/ui/format.js`:
```js
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** @type {[Intl.RelativeTimeFormatUnit, number][]} */
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

/** "2 hours ago", "yesterday", "just now". @param {number} ts @param {number} [now] */
export function relTime(ts, now = Date.now()) {
  const diff = (ts - now) / 1000;
  for (const [unit, sec] of UNITS) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
  return 'just now';
}

/** @param {number} n */
export function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Nov 25 – 29" for plain dates (YYYY-MM-DD), shown as written, with no time-zone shift. @param {string} start @param {string} [end] */
export function dateRange(start, end) {
  const a = new Date(`${start}T00:00:00Z`);
  if (!end) return day.format(a);
  const b = new Date(`${end}T00:00:00Z`);
  return typeof day.formatRange === 'function' ? day.formatRange(a, b) : `${day.format(a)} – ${day.format(b)}`;
}
```

Run: `node --test test/unit/ui-pure.test.js`
Expected: 3 tests pass.

- [ ] **Step 3: Implement the DOM helpers** `src/ui/dom.js`

```js
/**
 * Builds DOM without innerHTML (the CSP and spec §15 forbid it).
 * attrs: class (string | string[]), text (textContent), style (object → setProperty, never a style attribute),
 * dataset (object), on<event> (listener), value (property), true → empty attribute, false/null/undefined → skipped.
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...any} children nodes, strings, numbers, arrays; null/false are skipped
 * @returns {any}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val));
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in el) /** @type {any} */ (el).value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** A labelled control: <label class="field"><span>Label</span>control</label>. @param {string} label @param {HTMLElement} control */
export function field(label, control) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control);
}

/** @param {string} label @param {boolean} checked */
export function checkbox(label, checked) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  return { input, el: h('label', { class: 'check' }, input, h('span', { text: label })) };
}

/**
 * @param {string} legend
 * @param {[string, string][]} options [value, label]
 * @param {string} value
 * @param {(value: string) => void} onChange
 */
export function radios(legend, options, value, onChange) {
  const name = `r-${Math.random().toString(36).slice(2)}`;
  return h('fieldset', { class: 'radios' }, h('legend', { text: legend }),
    ...options.map(([v, label]) => {
      const input = h('input', { type: 'radio', name, value: v, onchange: () => onChange(v) });
      input.checked = v === value;
      return h('label', { class: 'check' }, input, h('span', { text: label }));
    }));
}

/**
 * A destructive button that needs a second tap within four seconds.
 * @param {string} label @param {string} confirmLabel @param {() => Promise<void> | void} action
 */
export function twoStep(label, confirmLabel, action) {
  let armed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const btn = h('button', {
    class: 'btn danger', type: 'button',
    onclick: async () => {
      if (!armed) {
        armed = true;
        btn.textContent = confirmLabel;
        timer = setTimeout(() => { armed = false; btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      try {
        await action();
      } finally {
        btn.disabled = false;
        armed = false;
        btn.textContent = label;
      }
    },
  }, label);
  return btn;
}
```

- [ ] **Step 4: Implement platform, notices, install, pending import, open-file and the lock**

`src/ui/platform.js`:
```js
/** Running from the Home Screen (installed), not in a browser tab. */
export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || /** @type {any} */ (navigator).standalone === true;
}

/** @returns {'ios' | 'android' | 'desktop'} */
export function platform() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

export async function storageStatus() {
  const persisted = (await navigator.storage?.persisted?.().catch(() => false)) ?? false;
  const est = (await navigator.storage?.estimate?.().catch(() => ({}))) ?? {};
  return { persisted, usage: est.usage ?? 0, quota: est.quota ?? 0 };
}

/** Asks the browser not to clear annai's storage under pressure (spec §4.6). */
export async function requestPersist() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
```

`src/ui/notices.js`:
```js
import { h } from './dom.js';

/** System cards and toasts. These are never in Shiori's voice (spec §16.1). */
export function createNotices() {
  const el = h('div', { class: 'notices', role: 'status', 'aria-live': 'polite' });
  /**
   * @param {{ title: string, body?: string, tone?: 'info'|'ok'|'warn'|'risk', actions?: { label: string, run: () => void, primary?: boolean }[] }} n
   * @returns {() => void} dismiss
   */
  function card({ title, body, tone = 'info', actions = [] }) {
    const node = h('section', { class: ['notice', `notice-${tone}`] },
      h('strong', { text: title }),
      body ? h('p', { text: body }) : null,
      h('div', { class: 'acts' },
        ...actions.map((a) => h('button', { class: a.primary ? 'btn pri' : 'btn', type: 'button', onclick: () => { a.run(); dismiss(); } }, a.label)),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dismiss() }, 'Dismiss')));
    const dismiss = () => node.remove();
    el.append(node);
    return dismiss;
  }
  /** @param {string} text */
  function toast(text) {
    const t = h('div', { class: 'toast', text });
    el.append(t);
    setTimeout(() => t.remove(), 3500);
  }
  return { el, card, toast };
}
```

`src/ui/install.js`:
```js
import { h } from './dom.js';
import { isStandalone, platform } from './platform.js';

/** @type {any} */
let deferred = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
});

const STEPS = {
  ios: ['Tap the Share button in Safari.', 'Choose "Add to Home Screen".', 'Open annai from your Home Screen.'],
  android: ['Open the browser menu (⋮).', 'Choose "Install app" or "Add to Home screen".', 'Open annai from your Home screen.'],
  desktop: ['Use your browser menu to install annai as an app.'],
};

/** The data-safety warning shown until annai runs installed (spec §2, §17 rule 1). */
export function installBanner() {
  if (isStandalone()) return h('div', { hidden: true });
  const p = platform();
  const how = h('ol', { class: 'steps', hidden: true }, ...STEPS[p].map((s) => h('li', { text: s })));
  const install = h('button', {
    class: 'btn pri', type: 'button', hidden: !deferred,
    onclick: async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      install.hidden = true;
    },
  }, 'Install annai');
  addEventListener('beforeinstallprompt', () => { install.hidden = false; });
  return h('section', { class: 'risk', 'aria-label': 'Install annai' },
    h('p', {}, h('strong', { text: "annai isn't installed yet." }), ' ',
      p === 'ios'
        ? 'Safari can erase your trips after 7 days without a visit. Add annai to your Home Screen to keep them.'
        : 'Your browser may clear your trips when space runs low. Install annai to keep them safe.'),
    h('div', { class: 'acts' }, install, h('button', { class: 'btn', type: 'button', onclick: () => { how.hidden = !how.hidden; } }, 'Show me how')),
    how);
}
```

`src/ui/import-state.js`:
```js
/** A file picked on one screen and opened on the import screen (hash routes can't carry files). */
/** @type {File | null} */
let pending = null;
/** @param {File} file */
export function setPendingImport(file) { pending = file; }
export function takePendingImport() {
  const f = pending;
  pending = null;
  return f;
}
```

`src/ui/open-file.js`:
```js
import { h } from './dom.js';
import { setPendingImport } from './import-state.js';

let n = 0;
/** A button that picks an annai file and opens the import screen. @param {any} ctx @param {string} [label] */
export function openFileButton(ctx, label = 'Open a trip someone sent you') {
  const id = `open-file-${n++}`;
  const input = h('input', {
    type: 'file', id, class: 'visually-hidden', accept: '.zip,.annai,application/zip,application/octet-stream',
    onchange: () => {
      const f = input.files?.[0];
      if (!f) return;
      setPendingImport(f);
      input.value = '';
      if (location.hash === '#/import') ctx.render();
      else ctx.go('#/import');
    },
  });
  return h('div', { class: 'acts' }, h('label', { class: 'btn', for: id }, label), input);
}
```

`src/core/lock.js`:
```js
/**
 * Keeps one running copy of annai per device (spec §4.6), using a Web Lock held
 * until the page closes. If another tab holds it, onHeldElsewhere decides
 * whether to take it over; the tab that loses the lock gets onStolen.
 * @param {{ onHeldElsewhere: () => Promise<boolean>, onStolen: () => void }} hooks
 * @returns {Promise<boolean>} true when this page holds the lock
 */
export async function acquireInstanceLock({ onHeldElsewhere, onStolen }) {
  if (!navigator.locks) return true;
  if (await request({ ifAvailable: true }, onStolen)) return true;
  if (!(await onHeldElsewhere())) return false;
  return request({ steal: true }, onStolen);
}

/** @param {LockOptions} opts @param {() => void} onStolen @returns {Promise<boolean>} */
function request(opts, onStolen) {
  return new Promise((resolve) => {
    navigator.locks
      .request('annai-instance', opts, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise(() => {}); // held until the page closes or another tab steals it
      })
      .catch((e) => {
        if (e?.name === 'AbortError') onStolen();
      });
  });
}
```

- [ ] **Step 5: Implement the shell and a first trips screen**

`src/ui/shell.js`:
```js
import { h } from './dom.js';
import { parseHash } from './router.js';
import { createNotices } from './notices.js';
import { installBanner } from './install.js';
import { renderTrips } from './screens/trips.js';

/** @type {Record<string, (ctx: any, route: any) => Promise<Node>>} */
const SCREENS = { trips: renderTrips };

/**
 * @param {HTMLElement} root
 * @param {{ store: any, ws: any, registry: any, plugins: any, version: string }} core
 */
export function startShell(root, core) {
  const notices = createNotices();
  const main = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  const links = [['#/trips', 'Trips'], ['#/trace', 'Trace'], ['#/settings', 'Settings']].map(([href, label]) => h('a', { href }, label));
  const header = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/trips', 'aria-label': 'annai' }, 'ann', h('span', { class: 'brand-ai' }, 'ai')),
    h('nav', { class: 'topnav', 'aria-label': 'Main' }, ...links));
  root.replaceChildren(header, installBanner(), main, notices.el);

  const update = { ready: false, apply: () => {} };
  const ctx = {
    ...core, notices, update,
    go: (/** @type {string} */ hash) => { if (location.hash === hash) render(); else location.hash = hash; },
    render: () => render(),
  };
  let seq = 0;
  async function render() {
    const my = ++seq;
    const route = parseHash(location.hash);
    for (const a of links) {
      const on = a.getAttribute('href') === `#/${route.parts[0]}` || (route.parts[0] === 'trip' && a.getAttribute('href') === '#/trips');
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const screen = SCREENS[route.name] ?? SCREENS.trips;
    try {
      const node = await screen(ctx, route);
      if (my !== seq) return;
      main.replaceChildren(node);
    } catch (e) {
      if (my !== seq) return;
      main.replaceChildren(h('div', { class: 'screen' },
        h('h1', { class: 'title', text: "This screen couldn't open" }),
        h('p', { text: String(/** @type {any} */ (e)?.message ?? e) }),
        h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips'))));
      dispatchEvent(new ErrorEvent('error', { error: e, message: String(e) }));
    }
  }
  addEventListener('hashchange', render);
  render();
  return {
    notices,
    render,
    /** Shown in Settings → App once a new version is waiting. @param {() => void} apply */
    setUpdateReady(apply) {
      update.ready = true;
      update.apply = apply;
      notices.card({ title: 'An update is ready', body: 'It will be used the next time annai starts.', actions: [{ label: 'Restart now', primary: true, run: apply }] });
    },
  };
}

/**
 * A full-screen message with one action, used for the single-instance lock.
 * @param {HTMLElement} root
 * @param {{ title: string, body: string, action: string, onAction?: () => void }} msg
 * @returns {Promise<boolean>} resolves true when the action is chosen
 */
export function showBlocking(root, { title, body, action, onAction }) {
  return new Promise((resolve) => {
    root.replaceChildren(h('div', { class: 'blocking' },
      h('h1', { class: 'title', text: title }),
      h('p', { text: body }),
      h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => { onAction?.(); resolve(true); } }, action))));
  });
}
```

`src/ui/screens/trips.js` (Task 15 extends it):
```js
import { h } from '../dom.js';
import { listTrips } from '../../core/scopes.js';

/** @param {any} ctx */
export async function renderTrips(ctx) {
  const { active } = await listTrips(ctx.store);
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Trips' }),
    active.length
      ? h('ul', { class: 'cards' }, ...active.map((s) => h('li', {}, h('a', { class: 'card', href: `#/trip/${encodeURIComponent(s.id)}` }, s.title))))
      : h('p', { class: 'empty', text: 'No trips yet.' }));
}
```

- [ ] **Step 6: Implement the bootstrap** `src/app/main.js` and `index.html`

`index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#b8392b">
  <meta name="apple-mobile-web-app-title" content="annai">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="description" content="annai, an AI guide for your trips. Local-first: your trips stay on your device.">
  <title>annai</title>
  <link rel="stylesheet" href="/src/ui/tokens.css">
  <link rel="stylesheet" href="/src/ui/base.css">
  <script type="module" src="/src/app/main.js"></script>
</head>
<body>
  <div id="app"><p class="booting">Opening annai…</p></div>
  <noscript>annai needs JavaScript to run.</noscript>
</body>
</html>
```

`src/app/main.js`:
```js
import { VERSION } from './version.js';
import { createIdbStore } from '../core/store-idb.js';
import { Workspace } from '../core/workspace.js';
import { makeSchemaFor } from '../core/schema.js';
import { kindOf, ensureBaseScopes, syncTripTitles, SYS } from '../core/scopes.js';
import { Registry } from '../core/registry.js';
import { PluginHost } from '../core/plugins.js';
import { logEvent } from '../core/events.js';
import { acquireInstanceLock } from '../core/lock.js';
import { startShell, showBlocking } from '../ui/shell.js';
import { h } from '../ui/dom.js';
import { isStandalone, requestPersist } from '../ui/platform.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
/** @type {{ store: import('../core/types.js').Store } | null} */
let running = null;

async function boot() {
  const held = await acquireInstanceLock({
    onHeldElsewhere: () => showBlocking(root, {
      title: 'annai is open in another tab',
      body: 'Only one copy of annai runs at a time, so your trips stay consistent.',
      action: 'Use it here',
    }),
    onStolen: () => {
      running?.store.close();
      showBlocking(root, {
        title: 'annai was opened in another tab',
        body: 'This tab has stopped, so your trips stay consistent.',
        action: 'Use it here instead',
        onAction: () => location.reload(),
      });
    },
  });
  if (!held) return;

  const store = await createIdbStore();
  running = { store };
  const registry = new Registry({ log: (ev) => logEvent(store, SYS, ev) });
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  syncTripTitles(ws);
  const plugins = new PluginHost({ registry, workspace: ws });
  await plugins.addBuiltin(new URL('../plugins/core-schemas/index.js', import.meta.url).href);
  const failures = await plugins.startInstalled();

  const shell = startShell(root, { store, ws, registry, plugins, version: VERSION });
  watchErrors(store, shell);
  for (const f of failures) {
    shell.notices.card({ tone: 'warn', title: `The plugin "${f.id}" didn't start`, body: `${/** @type {any} */ (f.error)?.message ?? f.error} You can turn it off in Settings → Plugins.` });
  }
  if (isStandalone()) requestPersist();
}

/** Spec §17 rule 4: record unexpected errors, show a card, keep running. */
function watchErrors(/** @type {any} */ store, /** @type {ReturnType<typeof startShell>} */ shell) {
  const report = (/** @type {any} */ err) => {
    logEvent(store, SYS, { type: 'error', data: { message: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 2000) } }).catch(() => {});
    shell.notices.card({
      tone: 'warn', title: 'Something went wrong',
      body: 'annai kept running. The details are in Trace.',
      actions: [{ label: 'Open Trace', run: () => { location.hash = '#/trace'; } }],
    });
  };
  addEventListener('error', (e) => report(e.error ?? e.message));
  addEventListener('unhandledrejection', (e) => report(e.reason));
}

boot().catch((e) => {
  console.error(e);
  root.replaceChildren(h('div', { class: 'blocking' },
    h('h1', { class: 'title', text: "annai couldn't start" }),
    h('p', { text: String(e?.message ?? e) }),
    h('p', { text: 'If this keeps happening, your browser may be blocking storage (for example, in a private window).' }),
    h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => location.reload() }, 'Try again'))));
});
```

- [ ] **Step 7: Add the fonts**

```bash
mkdir -p assets/fonts
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
get() { # family weight file
  url=$(curl -sA "$UA" "https://fonts.googleapis.com/css2?family=$1:wght@$2&display=swap" | tr '\n' ' ' \
    | sed -E 's/.*\/\* latin \*\/[^}]*src: url\(([^)]+)\).*/\1/')
  curl -sfL "$url" -o "assets/fonts/$3"
}
get 'Zen+Maru+Gothic' 500 zen-maru-gothic-500.woff2
get 'Zen+Maru+Gothic' 700 zen-maru-gothic-700.woff2
get 'Zen+Kaku+Gothic+New' 400 zen-kaku-gothic-new-400.woff2
get 'Zen+Kaku+Gothic+New' 500 zen-kaku-gothic-new-500.woff2
get 'Zen+Kaku+Gothic+New' 700 zen-kaku-gothic-new-700.woff2
get 'IBM+Plex+Mono' 400 ibm-plex-mono-400.woff2
get 'IBM+Plex+Mono' 500 ibm-plex-mono-500.woff2
for f in zenmarugothic zenkakugothicnew ibmplexmono; do
  printf '\n===== %s =====\n' "$f"; curl -sfL "https://raw.githubusercontent.com/google/fonts/main/ofl/$f/OFL.txt"
done > assets/fonts/OFL.txt
file assets/fonts/*.woff2
```
Expected: seven files reported as `Web Open Font Format (Version 2)`, each under 60 KB (Latin subsets only; Japanese text falls back to the system's Japanese fonts). `OFL.txt` contains three licenses.

- [ ] **Step 8: Write the styles**

`src/ui/tokens.css`:
```css
/* Design tokens (spec §16.2): vermilion accent, plain paper neutrals, three typefaces (self-hosted, OFL). */
@font-face { font-family: 'Zen Maru Gothic'; font-weight: 500; font-display: swap; src: url('/assets/fonts/zen-maru-gothic-500.woff2') format('woff2'); }
@font-face { font-family: 'Zen Maru Gothic'; font-weight: 700; font-display: swap; src: url('/assets/fonts/zen-maru-gothic-700.woff2') format('woff2'); }
@font-face { font-family: 'Zen Kaku Gothic New'; font-weight: 400; font-display: swap; src: url('/assets/fonts/zen-kaku-gothic-new-400.woff2') format('woff2'); }
@font-face { font-family: 'Zen Kaku Gothic New'; font-weight: 500; font-display: swap; src: url('/assets/fonts/zen-kaku-gothic-new-500.woff2') format('woff2'); }
@font-face { font-family: 'Zen Kaku Gothic New'; font-weight: 700; font-display: swap; src: url('/assets/fonts/zen-kaku-gothic-new-700.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 400; font-display: swap; src: url('/assets/fonts/ibm-plex-mono-400.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 500; font-display: swap; src: url('/assets/fonts/ibm-plex-mono-500.woff2') format('woff2'); }

:root {
  --paper: #f1f2f5;
  --sheet: #ffffff;
  --ink: #1d2030;
  --ink-2: #5b6075;
  --line: #dcdfe8;
  --ai: #b8392b;
  --ai-ink: #ffffff;
  --ai-wash: #fbe5e1;
  --amber: #8f5a0f;
  --amber-wash: #fbf0dc;
  --risk: #b3343b;
  --risk-wash: #fbe6e7;
  --ok: #2d7a5c;
  --ok-wash: #e2f2ea;
  --lattice: #e6e3ea;
  --shadow: rgba(20, 22, 40, 0.18);
  --f-display: 'Zen Maru Gothic', 'Hiragino Maru Gothic ProN', ui-rounded, system-ui, sans-serif;
  --f-body: 'Zen Kaku Gothic New', 'Hiragino Sans', 'Noto Sans JP', system-ui, -apple-system, sans-serif;
  --f-mono: 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace;
  --radius: 14px;
  --gap: 14px;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0e0f15; --sheet: #181a23; --ink: #eceef4; --ink-2: #a2a7b8; --line: #2b2e3c;
    --ai: #ff9a8a; --ai-ink: #2a0d09; --ai-wash: #3b1d18;
    --amber: #e6ae55; --amber-wash: #33270f; --risk: #f08a8f; --risk-wash: #3a1a1d;
    --ok: #7fcaa8; --ok-wash: #16302a; --lattice: #262833; --shadow: rgba(0, 0, 0, 0.5);
    color-scheme: dark;
  }
}
```

`src/ui/base.css`:
```css
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100dvh; background: var(--paper); color: var(--ink);
  font-family: var(--f-body); font-size: 16px; line-height: 1.55;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
h1, h2, h3, p, ul, ol, figure { margin: 0; }
a { color: var(--ai); }
:focus-visible { outline: 2px solid var(--ai); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.mono { font-family: var(--f-mono); }

/* top bar */
.topbar {
  position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: calc(env(safe-area-inset-top, 0px) + 10px) max(16px, env(safe-area-inset-right, 0px)) 10px max(16px, env(safe-area-inset-left, 0px));
  background: color-mix(in srgb, var(--paper) 92%, transparent); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
}
.brand { font-family: var(--f-display); font-weight: 700; font-size: 24px; color: var(--ink); text-decoration: none; line-height: 1; }
.brand-ai { color: var(--ai); }
.topnav { display: flex; gap: 4px; }
.topnav a { padding: 6px 10px; border-radius: 999px; color: var(--ink-2); text-decoration: none; font-weight: 500; font-size: 15px; }
.topnav a[aria-current='page'] { background: var(--ai-wash); color: var(--ai); }

/* layout */
.view { display: block; padding: 16px max(16px, env(safe-area-inset-right, 0px)) 96px max(16px, env(safe-area-inset-left, 0px)); max-width: 760px; margin: 0 auto; outline: none; }
.screen { display: flex; flex-direction: column; gap: 18px; }
.title { font-family: var(--f-display); font-weight: 700; font-size: 26px; line-height: 1.2; text-wrap: balance; overflow-wrap: anywhere; }
.section { font-family: var(--f-display); font-weight: 700; font-size: 18px; }
.sub { color: var(--ink-2); font-size: 14px; }
.empty { color: var(--ink-2); }
.crumbs a { text-decoration: none; font-weight: 500; }
.booting { padding: 32px 16px; color: var(--ink-2); }

/* buttons */
.acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.btn {
  font: inherit; font-size: 15px; font-weight: 700; min-height: 44px; padding: 8px 16px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--sheet); color: var(--ink); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; text-decoration: none;
}
.btn.pri { background: var(--ai); color: var(--ai-ink); border-color: var(--ai); }
.btn.ghost { border-color: transparent; background: transparent; color: var(--ai); }
.btn.danger { color: var(--risk); border-color: var(--risk); }
.btn:disabled { opacity: 0.55; cursor: default; }

/* cards and lists */
.cards { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.card { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--sheet); color: var(--ink); text-decoration: none; }
.card .name { font-family: var(--f-display); font-weight: 700; font-size: 17px; overflow-wrap: anywhere; }
.panel { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--sheet); }
details.archived summary { cursor: pointer; color: var(--ink-2); padding: 6px 0; }

/* forms */
.field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 160px; min-width: 0; }
.field-label { font-size: 14px; font-weight: 500; color: var(--ink-2); }
input, textarea, select {
  font: inherit; font-size: 16px; color: var(--ink); background: var(--paper); border: 1px solid var(--line);
  border-radius: 10px; padding: 10px 12px; min-height: 44px; width: 100%;
}
input[type='checkbox'], input[type='radio'] { width: 22px; height: 22px; min-height: 0; accent-color: var(--ai); }
.row { display: flex; flex-wrap: wrap; gap: 12px; }
.check { display: flex; gap: 10px; align-items: center; min-height: 44px; }
.checks { display: flex; flex-direction: column; }
.radios { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; }
.radios legend { font-size: 14px; font-weight: 500; color: var(--ink-2); padding: 0; margin-bottom: 2px; }
.error, .errors { color: var(--risk); font-size: 14px; }
.errors { padding-left: 20px; }

/* files */
.files { display: flex; flex-direction: column; gap: 14px; }
.file-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.file-row { display: flex; flex-direction: column; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--sheet); color: var(--ink); text-decoration: none; }
.file-row .path { font-family: var(--f-mono); font-size: 14px; overflow-wrap: anywhere; }
.editor { font-family: var(--f-mono); font-size: 14px; line-height: 1.5; min-height: 40vh; resize: vertical; }
.preview img { max-width: 100%; border-radius: var(--radius); border: 1px solid var(--line); }
.history { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.history li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); }

/* trace */
.trace { list-style: none; padding: 0; display: flex; flex-direction: column; font-family: var(--f-mono); font-size: 13px; }
.trace li { border-bottom: 1px solid var(--line); padding: 6px 0; }
.trace summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 4px 10px; }
.trace .k { color: var(--ai); font-weight: 500; }
.trace .d { overflow-wrap: anywhere; }
.trace pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--paper); padding: 10px; border-radius: 8px; margin: 6px 0 0; }

/* the data-safety warning and notices */
.risk { margin: 12px max(16px, env(safe-area-inset-right, 0px)) 0 max(16px, env(safe-area-inset-left, 0px)); max-width: 728px; padding: 14px 16px; border-radius: var(--radius); background: var(--risk-wash); display: flex; flex-direction: column; gap: 10px; }
@media (min-width: 792px) { .risk { margin-left: auto; margin-right: auto; } }
.risk strong { color: var(--risk); }
.steps { padding-left: 20px; }
.risk-note { padding: 12px 14px; border-radius: 12px; background: var(--amber-wash); color: var(--ink); font-size: 14px; }
.notices { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; display: flex; flex-direction: column; gap: 8px; padding: 0 16px calc(16px + env(safe-area-inset-bottom, 0px)); pointer-events: none; align-items: center; }
.notice, .toast { pointer-events: auto; width: min(100%, 560px); padding: 14px 16px; border-radius: var(--radius); background: var(--sheet); border: 1px solid var(--line); box-shadow: 0 12px 30px -16px var(--shadow); display: flex; flex-direction: column; gap: 8px; }
.notice-warn { border-color: var(--amber); }
.notice-risk { border-color: var(--risk); }
.notice-ok { border-color: var(--ok); }
.toast { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.blocking { max-width: 560px; margin: 15vh auto 0; padding: 0 16px; display: flex; flex-direction: column; gap: 14px; }
```

- [ ] **Step 9: Write the e2e helpers and the shell tests**

`test/e2e/helpers.js`:
```js
import { expect } from '@playwright/test';

/** Collects console errors and uncaught page errors. @param {import('@playwright/test').Page} page */
export function watchConsole(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Opens annai and waits for the first screen. Exports always download in tests (no share sheet). @param {import('@playwright/test').Page} page @param {string} [hash] */
export async function openApp(page, hash = '') {
  await page.addInitScript(() => { try { localStorage.setItem('annai.forceDownload', '1'); } catch { /* storage blocked */ } });
  await page.goto('/' + hash);
  await expect(page.locator('main.view > *')).toBeVisible();
}

/** @param {import('@playwright/test').Page} page */
export async function waitForServiceWorker(page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
}
```

`test/e2e/shell.spec.js`:
```js
import { test, expect } from '@playwright/test';
import { openApp, watchConsole } from './helpers.js';

test('starts without errors and shows Trips', async ({ page }) => {
  const errors = watchConsole(page);
  await openApp(page);
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the install warning shows in a browser tab and explains how', async ({ page }) => {
  await openApp(page);
  const banner = page.getByRole('region', { name: 'Install annai' });
  await expect(banner).toContainText("annai isn't installed yet");
  await banner.getByRole('button', { name: 'Show me how' }).click();
  await expect(banner.getByRole('listitem').first()).toBeVisible();
});

test('only one tab runs annai at a time', async ({ page, context }) => {
  await openApp(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('heading', { name: 'annai is open in another tab' })).toBeVisible();
  await second.getByRole('button', { name: 'Use it here' }).click();
  await expect(second.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'annai was opened in another tab' })).toBeVisible();
});

test('an unexpected error shows a card and annai keeps running', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { setTimeout(() => { throw new Error('test boom'); }, 0); });
  await expect(page.getByText('Something went wrong')).toBeVisible();
  await page.getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
});
```

- [ ] **Step 10: Run the tests**

Run: `npm test && npx tsc -p tsconfig.json && npx playwright test test/e2e/shell.spec.js`
Expected: the unit suite passes; tsc prints nothing; the 4 shell tests pass in each available project. The screen for an unknown route (`#/trace`) falls back to Trips until Task 16 adds it.

- [ ] **Step 11: Commit**

```bash
git add index.html src/app/main.js src/core/lock.js src/ui assets/fonts test/unit/ui-pure.test.js test/e2e/helpers.js test/e2e/shell.spec.js
git commit -m "Add the app shell: bootstrap, single-instance lock, install warning, notices"
```

---

### Task 14: Service worker, manifest and icons

**Files:**
- Create: `sw.js`, `manifest.webmanifest`, `assets/shiori.svg`, `scripts/render-icons.mjs`, `assets/icons/icon-192.png`, `assets/icons/icon-512.png`, `assets/icons/icon-maskable-512.png`, `assets/icons/apple-touch-icon.png`, `test/unit/sw-shell.test.js`, `test/e2e/sw.spec.js`
- Modify: `index.html` (manifest and icon links), `src/app/main.js` (register the service worker)

**Interfaces:**
- Consumes:
  - The `files` and `blobs` stores of DB `annai` (Task 12), read-only
  - `startShell().setUpdateReady` (Task 13)
- Produces:
  - Cache `annai-shell-<VERSION>`
  - Cache `annai-inbox` for shared files, keyed `/inbox/<time>-<name>` with header `X-Annai-Name`
  - The route `GET /plugins/<id>/<file>`
  - The route `POST /share-target` → `303 /#/import?inbox=1`

- [ ] **Step 1: Write the failing test** `test/unit/sw-shell.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { VERSION } from '../../src/app/version.js';

const root = new URL('../../', import.meta.url);

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(`/${p}`);
  }
  return out;
}

test('the service worker caches exactly the files the app ships', async () => {
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '';
  const shell = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  const expected = ['/', '/index.html', '/manifest.webmanifest', ...(await walk('src')), ...(await walk('assets'))].sort();
  assert.deepEqual(shell, expected);
});

test('one version everywhere', async () => {
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(/const VERSION = '([^']+)'/.exec(sw)?.[1], VERSION);
  assert.equal(pkg.version, VERSION);
});

test('the manifest is installable and offers the share target', async () => {
  const m = JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.ok(m.icons.some((/** @type {any} */ i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.equal(m.share_target.action, '/share-target');
});
```

Run: `node --test test/unit/sw-shell.test.js`
Expected: FAIL (there's no `sw.js` yet).

- [ ] **Step 2: Draw Shiori for the icons** `assets/shiori.svg`

This is the white fox from the spec (§16.3) with the trail-tape hairpin and vermilion scarf. The nose is left out (UI polish list).

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 84 84" width="100%" height="100%" role="img" aria-label="Shiori, a white fox">
  <path d="M12 25L16.5 2 30 14z" fill="#fbf5ee" stroke="#e0cdb9" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M16 19l2.5-10.5L26 15z" fill="#f4a7a0"/>
  <path d="M21 15C16 11 11 8.5 4.5 8" fill="none" stroke="#6e4a30" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M13 10.5c-1.6-3.4-.4-6.4 2.8-7.6.9 3.2-.4 6-2.8 7.6z" fill="#7fb069"/>
  <path d="M8.5 9c-1.5 3-1.3 5.5-3 8" fill="none" stroke="#f05a87" stroke-width="2.8" stroke-linecap="round"/>
  <path d="M9.5 9.5c1 3 .5 5.5 1.5 8.5" fill="none" stroke="#e3487a" stroke-width="2.8" stroke-linecap="round"/>
  <rect x="5.5" y="5.6" width="6" height="4.6" rx="1.4" fill="#f05a87" transform="rotate(-20 8.5 7.9)"/>
  <path d="M52 25L47.5 2 34 14z" fill="#fbf5ee" stroke="#e0cdb9" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M48 19l-2.5-10.5L38 15z" fill="#f4a7a0"/>
  <path d="M32 10c14 0 22 8 22 19 0 9-6 14-11 17-4 2.5-7 6-11 6s-7-3.5-11-6c-5-3-11-8-11-17 0-11 8-19 22-19z" fill="#fbf5ee" stroke="#e0cdb9" stroke-width="1.2"/>
  <path d="M19.5 47.5Q32 55 44.5 47.5l-.8 4.2Q32 59 20.3 51.7z" fill="#d9473a"/>
  <circle cx="32" cy="55" r="2.6" fill="#d9473a"/>
  <path d="M31 56.5l-4 6.5 4.2-1zM33 56.5l4 6.5-4.2-1z" fill="#d9473a"/>
  <path d="M10.5 31c3 9 11 12 16 13 2.2.5 3.8 3 5.5 3s3.3-2.5 5.5-3c5-1 13-4 16-13-5 5-11 6-15 5.5-3-.4-4.5 1-6.5 1s-3.5-1.4-6.5-1C21.5 37 15.5 36 10.5 31z" fill="#ffffff"/>
  <ellipse cx="18.5" cy="35" rx="3.2" ry="1.9" fill="#f6a4a4" opacity=".7"/>
  <ellipse cx="45.5" cy="35" rx="3.2" ry="1.9" fill="#f6a4a4" opacity=".7"/>
  <ellipse cx="24" cy="28.5" rx="2.7" ry="3.4" fill="#3a2a26"/>
  <ellipse cx="40" cy="28.5" rx="2.7" ry="3.4" fill="#3a2a26"/>
  <circle cx="25" cy="27.3" r="1" fill="#fff"/>
  <circle cx="41" cy="27.3" r="1" fill="#fff"/>
</svg>
```

- [ ] **Step 3: Render the icons** `scripts/render-icons.mjs`

```js
// Renders the PNG app icons from assets/shiori.svg with Playwright's Chromium (dev-only tool).
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const svg = await readFile(new URL('../assets/shiori.svg', import.meta.url), 'utf8');
const out = new URL('../assets/icons/', import.meta.url);
await mkdir(out, { recursive: true });
const targets = [
  { file: 'icon-192.png', size: 192, pad: 0.08 },
  { file: 'icon-512.png', size: 512, pad: 0.08 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0.08 },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.2 },
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  const inner = Math.round(t.size * (1 - 2 * t.pad));
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${t.size}px;height:${t.size}px;display:grid;place-items:center;background:#fbe5e1"><div style="width:${inner}px;height:${inner}px">${svg}</div></body></html>`);
  await writeFile(new URL(t.file, out), await page.screenshot({ type: 'png' }));
}
await browser.close();
console.log('icons written to assets/icons/');
```

Run: `node scripts/render-icons.mjs && file assets/icons/*.png`
Expected: four PNGs at 192×192, 512×512, 180×180 and 512×512.

- [ ] **Step 4: Write `manifest.webmanifest` and link it**

```json
{
  "id": "/",
  "name": "annai",
  "short_name": "annai",
  "description": "An AI guide for your trips. Your trips stay on your device.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#f1f2f5",
  "theme_color": "#b8392b",
  "icons": [
    { "src": "/assets/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/assets/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/assets/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "share_target": {
    "action": "/share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": { "files": [{ "name": "files", "accept": [".zip", ".annai", "application/zip", "application/octet-stream"] }] }
  }
}
```

In `index.html`, add after the description meta:
```html
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/assets/icons/icon-192.png">
  <link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">
```

- [ ] **Step 5: Write `sw.js`**

The SHELL list covers every shipped file at this point; each later task adds its own new files, and the unit test enforces it.

```js
/* annai service worker: offline app shell, installed plugin files, Android share target (spec §3). */
const VERSION = '0.1.0';
const CACHE = `annai-shell-${VERSION}`;
const INBOX = 'annai-inbox';
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
const DEV = ['localhost', '127.0.0.1'].includes(sw.location.hostname);
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/assets/fonts/OFL.txt',
  '/assets/fonts/ibm-plex-mono-400.woff2',
  '/assets/fonts/ibm-plex-mono-500.woff2',
  '/assets/fonts/zen-kaku-gothic-new-400.woff2',
  '/assets/fonts/zen-kaku-gothic-new-500.woff2',
  '/assets/fonts/zen-kaku-gothic-new-700.woff2',
  '/assets/fonts/zen-maru-gothic-500.woff2',
  '/assets/fonts/zen-maru-gothic-700.woff2',
  '/assets/icons/apple-touch-icon.png',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-maskable-512.png',
  '/assets/shiori.svg',
  '/src/app/main.js',
  '/src/app/version.js',
  '/src/core/archive-crypto.js',
  '/src/core/archive.js',
  '/src/core/bytes.js',
  '/src/core/crc32.js',
  '/src/core/events.js',
  '/src/core/hash.js',
  '/src/core/lock.js',
  '/src/core/patch.js',
  '/src/core/paths.js',
  '/src/core/plugins.js',
  '/src/core/registry.js',
  '/src/core/schema.js',
  '/src/core/scopes.js',
  '/src/core/settings.js',
  '/src/core/store-idb.js',
  '/src/core/store-memory.js',
  '/src/core/types.js',
  '/src/core/workspace.js',
  '/src/core/zip.js',
  '/src/plugins/core-schemas/index.js',
  '/src/plugins/core-schemas/schemas.js',
  '/src/ui/base.css',
  '/src/ui/dom.js',
  '/src/ui/format.js',
  '/src/ui/import-state.js',
  '/src/ui/install.js',
  '/src/ui/notices.js',
  '/src/ui/open-file.js',
  '/src/ui/platform.js',
  '/src/ui/router.js',
  '/src/ui/screens/trips.js',
  '/src/ui/shell.js',
  '/src/ui/tokens.css',
];

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('annai-shell-') && key !== CACHE) await caches.delete(key);
    await sw.clients.claim();
  })());
});

// A new version waits until annai restarts; it only takes over early when the user taps "Restart now" (spec §17 rule 5).
sw.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith('/plugins/')) {
    event.respondWith(servePlugin(url.pathname));
    return;
  }
  if (url.pathname === '/share-target' && req.method === 'POST') {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET' || url.pathname.startsWith('/test/')) return;
  event.respondWith(respond(req, req.mode === 'navigate' ? '/index.html' : null));
});

/** Production: cache first. Development (localhost): network first, so edits show up. @param {Request} req @param {string | null} fallback */
async function respond(req, fallback) {
  const cache = await caches.open(CACHE);
  const cached = () => cache.match(fallback ?? req, { ignoreSearch: true });
  if (DEV) {
    try {
      return await fetch(req);
    } catch {
      return (await cached()) ?? Response.error();
    }
  }
  return (await cached()) ?? fetch(req);
}

/** Opens the app's database without ever creating it from here. @returns {Promise<IDBDatabase>} */
function openExisting() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('annai');
    r.onupgradeneeded = () => r.transaction?.abort();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Serves /plugins/<id>/<file> from the sys:plugins scope. @param {string} pathname */
async function servePlugin(pathname) {
  const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(pathname);
  if (!m) return new Response('not found', { status: 404 });
  const path = `/${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
  /** @type {IDBDatabase | undefined} */
  let db;
  try {
    db = await openExisting();
    const found = await new Promise((resolve, reject) => {
      const t = /** @type {IDBDatabase} */ (db).transaction(['files', 'blobs'], 'readonly');
      const f = t.objectStore('files').get(['sys:plugins', path]);
      f.onsuccess = () => {
        const entry = f.result;
        if (!entry) {
          resolve(null);
          return;
        }
        const b = t.objectStore('blobs').get(entry.hash);
        b.onsuccess = () => resolve(b.result ? { data: b.result.data, type: entry.type } : null);
      };
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    if (!found) return new Response('not found', { status: 404 });
    return new Response(found.data, { headers: { 'Content-Type': found.type, 'Cache-Control': 'no-cache' } });
  } catch {
    return new Response('plugin storage is not available', { status: 503 });
  } finally {
    db?.close();
  }
}

/** Android's share sheet posts files here; they wait in a cache until the import screen opens them. @param {Request} req */
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const inbox = await caches.open(INBOX);
    for (const f of form.getAll('files')) {
      if (!(f instanceof File)) continue;
      await inbox.put(`/inbox/${Date.now()}-${encodeURIComponent(f.name)}`, new Response(f, {
        headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Annai-Name': encodeURIComponent(f.name) },
      }));
    }
  } catch {
    // The import screen explains when the inbox is empty.
  }
  return Response.redirect(new URL('/#/import?inbox=1', sw.location.origin).href, 303);
}
```

- [ ] **Step 6: Register it** in `src/app/main.js`

Add this function, and call `registerServiceWorker(store, shell)` at the end of `boot()`:

```js
/** @param {any} store @param {ReturnType<typeof startShell>} shell */
async function registerServiceWorker(store, shell) {
  if (!('serviceWorker' in navigator)) return;
  let restartRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (restartRequested) location.reload(); // never on the first install, which also changes the controller
  });
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const announce = () => shell.setUpdateReady(() => {
      restartRequested = true;
      reg.waiting?.postMessage('skip-waiting');
    });
    if (reg.waiting && navigator.serviceWorker.controller) announce();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) announce();
      });
    });
  } catch (e) {
    logEvent(store, SYS, { type: 'error', data: { message: `The offline service didn't start: ${/** @type {any} */ (e)?.message ?? e}` } }).catch(() => {});
  }
}
```

- [ ] **Step 7: Run the unit tests and type checks**

Run: `npm test && npm run typecheck`
Expected: all pass, including the 3 `sw-shell` tests.

- [ ] **Step 8: Write the e2e test** `test/e2e/sw.spec.js`

```js
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker } from './helpers.js';

test('annai opens offline after the first visit', async ({ page, context }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await context.setOffline(false);
});

test('installed plugin files are served from storage', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const answer = await page.evaluate(async () => {
    const { createIdbStore } = await import('/src/core/store-idb.js');
    const { Workspace } = await import('/src/core/workspace.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write('sys:plugins', '/demo/hello.js', 'export const answer = 42;', { author: 'system' });
    store.close();
    const mod = await import('/plugins/demo/hello.js');
    return mod.answer;
  });
  expect(answer).toBe(42);
});

test('a shared file lands in the inbox', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const count = await page.evaluate(async () => {
    const form = new FormData();
    form.append('files', new File(['hello'], 'trip.annai.zip', { type: 'application/zip' }));
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
    return (await (await caches.open('annai-inbox')).keys()).length;
  });
  expect(count).toBe(1);
});
```

Run: `npx playwright test test/e2e/sw.spec.js`
Expected: 3 tests pass per available project. If Playwright's WebKit build doesn't support service workers, mark these 3 with `test.skip(browserName === 'webkit', 'service workers are not available in Playwright WebKit')` and add them to the device checklist (Task 18).

- [ ] **Step 9: Commit**

```bash
git add sw.js manifest.webmanifest index.html src/app/main.js assets/shiori.svg assets/icons scripts/render-icons.mjs test/unit/sw-shell.test.js test/e2e/sw.spec.js
git commit -m "Add the service worker, manifest, share target and app icons"
```

---

### Task 15: Trips and files screens

**Files:**
- Modify: `src/ui/screens/trips.js` (full version), `src/ui/shell.js` (register screens), `sw.js` (SHELL)
- Create: `src/ui/screens/trip.js`, `src/ui/screens/file.js`, `src/ui/save.js`, `test/e2e/trips.spec.js`

**Interfaces:**
- Consumes:
  - `createTrip`, `listTrips`, `setTripStatus` (Task 7)
  - `Workspace` (Task 6)
  - `normPath`, `typeForPath`, `isTextType` (Task 3)
  - the DOM helpers (Task 13)
- Produces:
  - Screens `trip` and `file`
  - `saveFile(blob, filename) → Promise<'shared'|'downloaded'|'cancelled'>`. With `localStorage['annai.forceDownload'] === '1'` it always downloads (for tests).
  - The page labels used by tests:
    - Trips screen: field "Trip name", "Starts", "Ends"; button "Start trip"
    - Trip screen: field "File path"; buttons "Create", "Upload a file"
    - File screen: field "Content"; buttons "Save", "Restore this version", "Delete file"

- [ ] **Step 1: Write the failing e2e test** `test/e2e/trips.spec.js`

```js
import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByLabel('Starts').fill('2026-11-25');
  await page.getByLabel('Ends').fill('2026-11-29');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('create a trip, edit a note, and restore an earlier version', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur · Thanksgiving');
  await expect(page.getByRole('link', { name: /\/trip\.json/ })).toBeVisible();
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/notes/day1.md' })).toBeVisible();
  await page.getByLabel('Content').fill('# Day 1\nMcWay Falls at sunset.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.getByLabel('Content').fill('# Day 1\nChanged my mind.');
  await page.getByRole('button', { name: 'Save' }).click();
  const restore = page.getByRole('button', { name: 'Restore this version' });
  await expect(restore).toHaveCount(2);
  await restore.first().click();
  await expect(page.getByLabel('Content')).toHaveValue('# Day 1\nMcWay Falls at sunset.');
});

test('records are checked against their format before saving', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('File path').fill('/plan/dinner.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByLabel('Content').fill('{ "id": "dinner", "title": "Nepenthe" }');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('$.fixed: is required');
  await page.getByLabel('Content').fill('{ "id": "dinner", "title": "Nepenthe", "fixed": true }');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});

test('upload a photo and see it', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Upload a file').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('link', { name: /\/files\/gate\.png/ }).click();
  await expect(page.getByRole('img', { name: '/files/gate.png' })).toBeVisible();
});

test('archive a trip, then bring it back', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Old trip');
  await page.getByRole('button', { name: 'Archive trip' }).click();
  await page.getByRole('button', { name: 'Tap again to archive' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await page.getByText('Archived trips (1)').click();
  await page.getByRole('link', { name: /Old trip/ }).click();
  await page.getByRole('button', { name: 'Unarchive' }).click();
  await page.getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('link', { name: /Old trip/ })).toBeVisible();
});

test('a bad trip name gets a plain explanation', async ({ page }) => {
  await openApp(page);
  await page.getByLabel('Trip name').fill('   ');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('alert')).toContainText('Give the trip a name');
});
```

Run: `npx playwright test test/e2e/trips.spec.js --project=chromium`
Expected: FAIL (there is no "Trip name" field yet).

- [ ] **Step 2: Implement `src/ui/save.js`**

```js
/**
 * Hands a file to the user: the share sheet where it can take files (iOS: "Save to Files"),
 * otherwise a download. Call it from a tap, because share sheets need a fresh user action.
 * @param {Blob} blob @param {string} filename
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  let forceDownload = false;
  try { forceDownload = localStorage.getItem('annai.forceDownload') === '1'; } catch { /* storage blocked */ }
  if (!forceDownload && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
```

- [ ] **Step 3: Implement the full `src/ui/screens/trips.js`**

```js
import { h, field } from '../dom.js';
import { listTrips, createTrip } from '../../core/scopes.js';
import { readAppSettings } from '../../core/settings.js';
import { ValidationError } from '../../core/workspace.js';
import { relTime, dateRange } from '../format.js';
import { requestPersist } from '../platform.js';
import { openFileButton } from '../open-file.js';

/** @param {any} ctx */
export async function renderTrips(ctx) {
  const { active, archived } = await listTrips(ctx.store);
  const settings = await readAppSettings(ctx.ws);
  const cards = await Promise.all(active.map(async (s) => tripCard(s, await ctx.ws.readJSON(s.id, '/trip.json').catch(() => null))));
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Trips' }),
    active.length ? h('ul', { class: 'cards' }, ...cards) : h('p', { class: 'empty', text: 'No trips yet. Start one below, or open a trip someone sent you.' }),
    newTripForm(ctx),
    openFileButton(ctx),
    h('p', { class: 'sub', text: settings.lastExportAt ? `Last export ${relTime(settings.lastExportAt)}.` : 'No backup yet. You can export everything from Settings.' }),
    archived.length
      ? h('details', { class: 'archived' }, h('summary', { text: `Archived trips (${archived.length})` }), h('ul', { class: 'cards' }, ...archived.map((s) => tripCard(s, null))))
      : null);
}

/** @param {any} s @param {any} trip */
function tripCard(s, trip) {
  const when = trip?.start ? dateRange(trip.start, trip.end) : null;
  return h('li', {}, h('a', { class: 'card', href: `#/trip/${encodeURIComponent(s.id)}` },
    h('span', { class: 'name', text: s.title }),
    h('span', { class: 'sub', text: [when, `updated ${relTime(s.updated)}`].filter(Boolean).join(' · ') })));
}

/** @param {any} ctx */
function newTripForm(ctx) {
  const title = h('input', { id: 'trip-title', name: 'title', maxlength: '200', autocomplete: 'off', placeholder: 'Big Sur · Thanksgiving' });
  const start = h('input', { id: 'trip-start', name: 'start', type: 'date' });
  const end = h('input', { id: 'trip-end', name: 'end', type: 'date' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  return h('form', {
    class: 'panel',
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      error.hidden = true;
      requestPersist(); // inside the tap, so browsers that ask the user can
      try {
        const id = await createTrip(ctx.ws, { title: title.value, start: start.value || undefined, end: end.value || undefined });
        ctx.go(`#/trip/${encodeURIComponent(id)}`);
      } catch (err) {
        error.textContent = explain(err);
        error.hidden = false;
      }
    },
  },
  h('h2', { class: 'section', text: 'Start a trip' }),
  field('Trip name', title),
  h('div', { class: 'row' }, field('Starts', start), field('Ends', end)),
  error,
  h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, 'Start trip')));
}

/** @param {any} err */
function explain(err) {
  if (!(err instanceof ValidationError)) return String(err?.message ?? err);
  if (err.errors.some((m) => m.startsWith('$.title'))) return 'Give the trip a name.';
  if (err.errors.some((m) => /date/.test(m))) return 'Use real dates for the start and end.';
  return err.errors.join(' ');
}
```

- [ ] **Step 4: Implement `src/ui/screens/trip.js`**

```js
import { h, field, twoStep } from '../dom.js';
import { setTripStatus } from '../../core/scopes.js';
import { normPath, typeForPath } from '../../core/paths.js';
import { ValidationError } from '../../core/workspace.js';
import { relTime, bytes, dateRange } from '../format.js';

/** @param {string} id @param {string} path */
export const fileHref = (id, path) => `#/trip/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`;

/** @param {any} ctx @param {{ parts: string[] }} route */
export async function renderTrip(ctx, route) {
  const id = route.parts[1];
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: "This trip isn't on this device" }), h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips')));
  }
  const trip = await ctx.ws.readJSON(id, '/trip.json').catch(() => null);
  const files = await ctx.ws.list(id, '/');
  const archived = scope.status === 'archived';
  const extra = h('div', {}); // Task 16 puts the export panel here
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/trips' }, '← Trips')),
    h('h1', { class: 'title', text: scope.title }),
    h('p', { class: 'sub', text: [trip?.start ? dateRange(trip.start, trip.end) : null, archived ? 'Archived' : null, `${files.length} files`].filter(Boolean).join(' · ') }),
    h('div', { class: 'acts' },
      ...tripActions(ctx, id, scope, extra),
      archived
        ? h('button', { class: 'btn', type: 'button', onclick: async () => { await setTripStatus(ctx.store, id, 'active'); ctx.render(); } }, 'Unarchive')
        : twoStep('Archive trip', 'Tap again to archive', async () => { await setTripStatus(ctx.store, id, 'archived'); ctx.go('#/trips'); })),
    extra,
    fileList(id, files),
    newFile(ctx, id));
}

/** Extra trip buttons; Task 16 adds "Export trip". @param {any} ctx @param {string} id @param {any} scope @param {HTMLElement} slot @returns {HTMLElement[]} */
function tripActions(ctx, id, scope, slot) {
  return [];
}

/** @param {string} id @param {any[]} files */
function fileList(id, files) {
  if (!files.length) return h('p', { class: 'empty', text: 'No files yet.' });
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const folder = parts.length > 2 ? parts[1] : '';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)?.push(f);
  }
  return h('section', { class: 'files', 'aria-label': 'Files' },
    ...[...groups].map(([folder, list]) => h('div', {},
      h('h2', { class: 'section', text: folder ? `${folder}/` : 'Trip' }),
      h('ul', { class: 'file-list' }, ...list.map((f) => h('li', {}, h('a', { class: 'file-row', href: fileHref(id, f.path) },
        h('span', { class: 'path', text: f.path }),
        h('span', { class: 'sub', text: `${bytes(f.size)} · ${f.author} · ${relTime(f.modified)}` }))))))));
}

/** Starting content for a new file, valid for the core schemas. @param {string} path */
function starter(path) {
  const base = path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'item';
  if (path.startsWith('/plan/') && path.endsWith('.json')) return JSON.stringify({ id: base, title: base, fixed: false }, null, 2) + '\n';
  if (path.startsWith('/bookings/') && path.endsWith('.json')) return JSON.stringify({ id: base, kind: 'other', status: 'unverified', source: '/files/' }, null, 2) + '\n';
  if (path.endsWith('.json')) return '{}\n';
  if (path.endsWith('.md')) return `# ${base}\n`;
  return '';
}

/** @param {any} ctx @param {string} id */
function newFile(ctx, id) {
  const path = h('input', { id: 'new-path', value: '/notes/', autocomplete: 'off', spellcheck: 'false' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const show = (/** @type {any} */ e) => {
    error.textContent = e instanceof ValidationError ? `That file doesn't match its format: ${e.errors.join('; ')}` : String(e?.message ?? e);
    error.hidden = false;
  };
  const upload = h('input', {
    id: 'upload-file', type: 'file', class: 'visually-hidden',
    onchange: async () => {
      const f = upload.files?.[0];
      if (!f) return;
      try {
        const target = normPath(`/files/${f.name}`);
        await ctx.ws.write(id, target, new Uint8Array(await f.arrayBuffer()), { author: 'user', type: f.type || typeForPath(target) });
        ctx.notices.toast(`Added ${target}`);
        ctx.render();
      } catch (e) {
        show(e);
      }
    },
  });
  return h('form', {
    class: 'panel',
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      error.hidden = true;
      try {
        const p = normPath(path.value);
        if (await ctx.ws.read(id, p)) throw new Error(`${p} already exists. Open it from the list to edit it.`);
        await ctx.ws.write(id, p, starter(p), { author: 'user' });
        ctx.go(fileHref(id, p));
      } catch (err) {
        show(err);
      }
    },
  },
  h('h2', { class: 'section', text: 'Add a file' }),
  field('File path', path),
  error,
  h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, 'Create'), h('label', { class: 'btn', for: 'upload-file' }, 'Upload a file'), upload));
}
```

- [ ] **Step 5: Implement `src/ui/screens/file.js`**

```js
import { h, field, twoStep } from '../dom.js';
import { isTextType } from '../../core/paths.js';
import { text } from '../../core/bytes.js';
import { ValidationError } from '../../core/workspace.js';
import { relTime, bytes } from '../format.js';
import { saveFile } from '../save.js';

/** @type {string | null} */
let objectUrl = null;

/** @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route */
export async function renderFile(ctx, route) {
  const id = route.parts[1];
  const path = route.params.path ?? '';
  const back = `#/trip/${encodeURIComponent(id)}`;
  const head = [h('p', { class: 'crumbs' }, h('a', { href: back }, '← Back to trip')), h('h1', { class: 'title mono', text: path })];
  const r = await ctx.ws.read(id, path);
  const history = await ctx.ws.history(id, path);
  if (!r) return h('div', { class: 'screen' }, ...head, h('p', { class: 'empty', text: 'This file was deleted. You can bring back a version below.' }), historyView(ctx, id, path, history, null));
  const { entry, bytes: content } = r;
  return h('div', { class: 'screen' }, ...head,
    h('p', { class: 'sub', text: `${entry.type} · ${bytes(entry.size)} · changed by ${entry.author} ${relTime(entry.modified)}` }),
    editor(ctx, id, entry, content),
    historyView(ctx, id, path, history, entry.hash),
    h('div', { class: 'acts' }, twoStep('Delete file', 'Tap again to delete', async () => {
      await ctx.ws.delete(id, path, { author: 'user' });
      ctx.go(back);
    })));
}

/** @param {any} ctx @param {string} id @param {any} entry @param {Uint8Array} content */
function editor(ctx, id, entry, content) {
  if (isTextType(entry.type)) {
    const area = h('textarea', { id: 'file-content', class: 'editor', rows: '16', spellcheck: entry.type === 'text/markdown' ? 'true' : 'false' });
    area.value = text(content);
    const errors = h('ul', { class: 'errors', role: 'alert', hidden: true });
    const save = async () => {
      errors.hidden = true;
      try {
        await ctx.ws.write(id, entry.path, area.value, { author: 'user', type: entry.type });
        ctx.notices.toast('Saved');
        ctx.render();
      } catch (e) {
        const lines = e instanceof ValidationError ? e.errors : [String(/** @type {any} */ (e)?.message ?? e)];
        errors.replaceChildren(...lines.map((m) => h('li', { text: m })));
        errors.hidden = false;
      }
    };
    return h('div', { class: 'panel' }, field('Content', area), errors, h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: save }, 'Save')));
  }
  if (entry.type.startsWith('image/')) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([content], { type: entry.type }));
    return h('figure', { class: 'preview' }, h('img', { src: objectUrl, alt: entry.path }));
  }
  return h('div', { class: 'acts' }, h('button', {
    class: 'btn', type: 'button',
    onclick: () => saveFile(new Blob([content], { type: entry.type }), entry.path.split('/').pop() ?? 'file'),
  }, 'Download'));
}

/** @param {any} ctx @param {string} id @param {string} path @param {any[]} history @param {string | null} current */
function historyView(ctx, id, path, history, current) {
  if (!history.length) return h('p', { class: 'sub', text: 'No earlier versions.' });
  return h('section', { class: 'panel', 'aria-label': 'History' },
    h('h2', { class: 'section', text: 'History' }),
    h('ol', { class: 'history' }, ...history.slice().reverse().map((v) => h('li', {},
      h('span', { text: `${v.type === 'file.delete' ? 'Deleted' : 'Saved'} by ${v.actor} ${relTime(v.ts)}` }),
      v.type === 'file.write' && v.new !== current
        ? h('button', { class: 'btn', type: 'button', onclick: async () => { await ctx.ws.restore(id, path, v.new, { author: 'user' }); ctx.notices.toast('Version restored'); ctx.render(); } }, 'Restore this version')
        : v.new === current ? h('span', { class: 'sub', text: 'Current' }) : null))));
}
```

- [ ] **Step 6: Register the screens and update the SHELL**

In `src/ui/shell.js`, import and register the new screens:
```js
import { renderTrip } from './screens/trip.js';
import { renderFile } from './screens/file.js';
```
and change the table to `const SCREENS = { trips: renderTrips, trip: renderTrip, file: renderFile };`.

In `sw.js` SHELL, add `'/src/ui/save.js'`, `'/src/ui/screens/file.js'` and `'/src/ui/screens/trip.js'`, keeping the list sorted.

- [ ] **Step 7: Run the tests**

Run: `npm test && npm run typecheck && npx playwright test test/e2e/trips.spec.js test/e2e/shell.spec.js`
Expected: all pass. The restore test sees 2 "Restore this version" buttons: the starter content and the first save; the second save is current.

- [ ] **Step 8: Commit**

```bash
git add src/ui sw.js test/e2e/trips.spec.js
git commit -m "Add the trips, trip and file screens with history and restore"
```

---
### Task 16: Settings, export, import and trace

**Files:**
- Create: `src/ui/export-panel.js`, `src/ui/screens/settings.js`, `src/ui/screens/import.js`, `src/ui/screens/trace.js`, `test/e2e/roundtrip.spec.js`, `test/e2e/trace.spec.js`
- Modify: `src/ui/screens/trip.js` (Export button), `src/ui/shell.js` (register screens), `sw.js` (SHELL)

**Interfaces:**
- Consumes:
  - `exportArchive`, `openArchive`, `describeArchive`, `importArchive`, `PRESETS`, `NeedsPassphraseError` (Task 10)
  - `PassphraseError` (Task 9)
  - `eraseDatabase` (Task 12)
  - `readAppSettings`, `updateAppSettings` (Task 7)
  - `saveFile` (Task 15)
  - `takePendingImport` (Task 13)
- Produces:
  - `exportPanel(ctx, { kind, scopes?, title }) → HTMLElement`
  - Screens `settings`, `import` and `trace`
  - The page labels used by tests:
    - Export panel: "Build file", "Save file", "Passphrase (optional)", "Repeat passphrase", "Share: plan, bookings, files and notes"
    - Import screen: "Passphrase", "Unlock", "Import", "Replace mine (yours moves to archived trips)", "Replace my profile and memory with the ones in this file"
    - Settings: "Export everything", "Type ERASE to confirm", "Erase now", "Copy diagnostics"
    - Trace: "Show", "Type contains"

- [ ] **Step 1: Write the failing e2e tests**

`test/e2e/roundtrip.spec.js`, the milestone's "done when":
```js
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp } from './helpers.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { exportArchive, PRESETS } from '../../src/core/archive.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** @param {import('@playwright/test').Page} page @param {string} path @param {string} content */
async function writeNote(page, path, content) {
  await page.getByLabel('File path').fill(path);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByLabel('Content').fill(content);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
}

/** Builds the file, then saves it with a separate tap (the iOS share sheet needs a fresh tap). @param {import('@playwright/test').Page} page */
async function buildAndSave(page) {
  await page.getByRole('button', { name: 'Build file' }).click();
  const save = page.getByRole('button', { name: 'Save file' });
  await expect(save).toBeVisible({ timeout: 60_000 });
  const downloading = page.waitForEvent('download');
  await save.click();
  const download = await downloading;
  return /** @type {string} */ (await download.path());
}

test('everything survives export, erase and import', async ({ page }) => {
  await openApp(page);
  await startTrip(page, '京都 in spring');
  await writeNote(page, '/notes/伏見稲荷.md', '千本鳥居 at dawn');
  await page.getByLabel('Content').fill('千本鳥居 at dawn, before the crowds');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(2);
  await page.getByRole('link', { name: '← Back to trip' }).click();
  await page.getByLabel('Upload a file').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('link', { name: /\/files\/gate\.png/ })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Export everything' }).click();
  const file = await buildAndSave(page);

  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Erase now' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByText('No trips yet.')).toBeVisible();

  await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
  await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible();
  await page.getByLabel('Replace my profile and memory with the ones in this file').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('link', { name: 'Open 京都 in spring' }).click();
  await page.getByRole('link', { name: /伏見稲荷\.md/ }).click();
  await expect(page.getByLabel('Content')).toHaveValue('千本鳥居 at dawn, before the crowds');
  await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(2);
  await page.getByRole('link', { name: '← Back to trip' }).click();
  await page.getByRole('link', { name: /\/files\/gate\.png/ }).click();
  await expect(page.getByRole('img', { name: '/files/gate.png' })).toBeVisible();
});

test('an encrypted trip opens only with its passphrase, and can replace the copy you have', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await writeNote(page, '/notes/bixby.md', 'Bixby Bridge, 1932');
  await page.getByRole('link', { name: '← Back to trip' }).click();
  await page.getByRole('button', { name: 'Export trip' }).click();
  await page.getByLabel('Share: plan, bookings, files and notes').check();
  await page.getByLabel('Passphrase (optional)').fill('pine needle');
  await page.getByLabel('Repeat passphrase').fill('pine needle');
  const file = await buildAndSave(page);
  expect((await readFile(file)).subarray(0, 10).toString()).toBe('ANNAI-ENC1');

  await page.getByRole('link', { name: 'Trips' }).click();
  await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
  await page.getByLabel('Passphrase').fill('wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong passphrase');
  await page.getByLabel('Passphrase').fill('pine needle');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByLabel('Replace mine (yours moves to archived trips)').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('1 older copy moved to archived trips.')).toBeVisible();
  await page.getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByText('Archived trips (1)')).toBeVisible();
});

test.describe('opening a hosted archive', () => {
  test.use({ serviceWorkers: 'block' });
  test('"#import=<url>" downloads and previews the archive', async ({ page }) => {
    const store = createMemoryStore();
    const ws = new Workspace(store);
    await ensureBaseScopes(ws);
    const id = await createTrip(ws, { title: 'Shared Big Sur' });
    await ws.write(id, '/notes/bixby.md', 'Bixby Bridge, 1932', { author: 'user' });
    const { blob } = await exportArchive(store, { kind: 'trip', scopes: [id], include: PRESETS.share, app: '0.1.0' });
    const body = Buffer.from(await blob.arrayBuffer());
    await page.route('https://files.example.test/big-sur.annai.zip', (route) =>
      route.fulfill({ body, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/zip' } }));
    await openApp(page, '#import=' + encodeURIComponent('https://files.example.test/big-sur.annai.zip'));
    await expect(page.getByText('Shared Big Sur')).toBeVisible();
    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('link', { name: 'Open Shared Big Sur' }).click();
    await expect(page.getByRole('link', { name: /bixby\.md/ })).toBeVisible();
  });
});
```

`test/e2e/trace.spec.js`:
```js
import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test('the trace shows what happened, newest first, and filters by type', async ({ page }) => {
  await openApp(page);
  await page.getByLabel('Trip name').fill('Trace trip');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Trace trip' })).toBeVisible();
  await page.getByRole('link', { name: 'Trace' }).click();
  await expect(page.getByRole('heading', { name: 'Trace' })).toBeVisible();
  await expect(page.getByText('/trip.json').first()).toBeVisible();
  await page.getByLabel('Type contains').fill('scope.create');
  await expect(page.locator('.trace li')).toHaveCount(1);
  await page.locator('.trace summary').first().click();
  await expect(page.locator('.trace pre').first()).toContainText('"type": "scope.create"');
});
```

Run: `npx playwright test test/e2e/roundtrip.spec.js test/e2e/trace.spec.js --project=chromium`
Expected: FAIL (there's no "Export everything" button and no Trace screen).

- [ ] **Step 2: Implement `src/ui/export-panel.js`**

```js
import { h, field, checkbox, radios } from './dom.js';
import { exportArchive, PRESETS } from '../core/archive.js';
import { updateAppSettings } from '../core/settings.js';
import { bytes } from './format.js';
import { saveFile } from './save.js';

let n = 0;
/**
 * Export choices (spec §12.2). Building and saving are two taps, because the
 * share sheet needs a fresh tap and encrypting can take a few seconds.
 * @param {any} ctx
 * @param {{ kind: 'trip'|'everything', scopes?: string[], title: string }} what
 */
export function exportPanel(ctx, what) {
  const k = n++;
  const isTrip = what.kind === 'trip';
  const history = checkbox('History (every version and the log)', true);
  const memory = checkbox('Memory', true);
  const photos = checkbox('Photos', true);
  const keys = isTrip ? null : checkbox('Include API keys (needs a passphrase)', false);
  const preset = isTrip
    ? radios('What to include', [['backup', 'Backup: everything'], ['share', 'Share: plan, bookings, files and notes']], 'backup', (v) => {
      const p = PRESETS[/** @type {'backup'|'share'} */ (v)];
      history.input.checked = p.history;
      memory.input.checked = p.memory;
      photos.input.checked = p.photos;
    })
    : null;
  const pass1 = h('input', { id: `export-pass-${k}`, type: 'password', autocomplete: 'new-password' });
  const pass2 = h('input', { id: `export-pass2-${k}`, type: 'password', autocomplete: 'new-password' });
  const status = h('p', { class: 'sub', role: 'status' });
  /** @type {{ blob: Blob, filename: string } | null} */
  let built = null;
  const saveBtn = h('button', {
    class: 'btn pri', type: 'button', hidden: true,
    onclick: async () => {
      if (!built) return;
      const how = await saveFile(built.blob, built.filename);
      if (how === 'cancelled') return;
      await updateAppSettings(ctx.ws, { lastExportAt: Date.now() });
      status.textContent = how === 'shared' ? 'Shared.' : 'Saved to your downloads.';
    },
  }, 'Save file');
  const build = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      if (pass1.value !== pass2.value) { status.textContent = "The passphrases don't match."; return; }
      if (keys?.input.checked && !pass1.value) { status.textContent = 'API keys can only be exported with a passphrase.'; return; }
      build.disabled = true;
      saveBtn.hidden = true;
      status.textContent = pass1.value ? 'Building and encrypting. This takes a few seconds…' : 'Building…';
      try {
        built = await exportArchive(ctx.store, {
          kind: what.kind, scopes: what.scopes,
          include: { history: history.input.checked, memory: memory.input.checked, photos: photos.input.checked },
          secrets: keys?.input.checked ?? false, passphrase: pass1.value || undefined, app: ctx.version,
        });
        status.textContent = `Ready: ${built.filename} (${bytes(built.blob.size)}). Tap Save file.`;
        saveBtn.hidden = false;
        saveBtn.focus();
      } catch (e) {
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
      } finally {
        build.disabled = false;
      }
    },
  }, 'Build file');
  return h('section', { class: 'panel', 'aria-label': 'Export' },
    h('h2', { class: 'section', text: isTrip ? `Export ${what.title}` : 'Export everything' }),
    preset,
    h('div', { class: 'checks' }, history.el, memory.el, photos.el, keys?.el ?? null),
    h('div', { class: 'row' }, field('Passphrase (optional)', pass1), field('Repeat passphrase', pass2)),
    h('p', { class: 'sub', text: 'With a passphrase, the file is encrypted. Without it, anyone with the file can read it.' }),
    h('div', { class: 'acts' }, build, saveBtn),
    status);
}
```

- [ ] **Step 3: Add the Export button to the trip screen**

In `src/ui/screens/trip.js`, add `import { exportPanel } from '../export-panel.js';` and replace `tripActions` with:
```js
/** @param {any} ctx @param {string} id @param {any} scope @param {HTMLElement} slot @returns {HTMLElement[]} */
function tripActions(ctx, id, scope, slot) {
  return [h('button', {
    class: 'btn', type: 'button',
    onclick: () => slot.replaceChildren(slot.firstChild ? '' : exportPanel(ctx, { kind: 'trip', scopes: [id], title: scope.title })),
  }, 'Export trip')];
}
```

- [ ] **Step 4: Implement `src/ui/screens/settings.js`**

```js
import { h, field } from '../dom.js';
import { readAppSettings } from '../../core/settings.js';
import { eraseDatabase } from '../../core/store-idb.js';
import { SYS } from '../../core/scopes.js';
import { relTime, bytes } from '../format.js';
import { storageStatus, requestPersist, platform, isStandalone } from '../platform.js';
import { exportPanel } from '../export-panel.js';
import { openFileButton } from '../open-file.js';

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/** @param {any} ctx */
export async function renderSettings(ctx) {
  const st = await storageStatus();
  const app = await readAppSettings(ctx.ws);
  const exportSlot = h('div', {});
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Settings' }),
    section('Storage',
      h('p', { text: st.persisted ? 'Protected from automatic clearing: yes.' : 'Protected from automatic clearing: no.' }),
      st.quota ? h('p', { class: 'sub', text: `Using ${bytes(st.usage)} of about ${bytes(st.quota)}.` }) : null,
      st.persisted ? null : h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          const ok = await requestPersist();
          ctx.notices.toast(ok ? 'Your data is now protected.' : "The browser didn't agree. Installing annai to your Home Screen usually fixes this.");
          ctx.render();
        },
      }, 'Protect my data'))),
    section('Backup',
      h('p', { class: 'sub', text: app.lastExportAt ? `Last export ${relTime(app.lastExportAt)}.` : 'No export yet. Export regularly: annai keeps everything on this device.' }),
      h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: () => exportSlot.replaceChildren(exportPanel(ctx, { kind: 'everything', title: 'everything' })),
      }, 'Export everything')),
      exportSlot),
    section('Open an annai file', openFileButton(ctx, 'Open an annai file')),
    section('Plugins', h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/plugins' }, 'Manage plugins'))),
    section('App',
      h('p', { text: `annai ${ctx.version}` }),
      ctx.update.ready
        ? h('div', { class: 'acts' }, h('span', { text: 'An update is ready.' }), h('button', { class: 'btn pri', type: 'button', onclick: () => ctx.update.apply() }, 'Restart annai'))
        : h('p', { class: 'sub', text: 'No update waiting.' })),
    section('Diagnostics',
      h('p', { class: 'sub', text: 'A report of recent errors and system events, without your files or keys, to paste into a bug report.' }),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => copyDiagnostics(ctx) }, 'Copy diagnostics'))),
    section('Erase', eraseControls(ctx)));
}

/** Spec §17 rule 4: a redacted report the user chooses to share. @param {any} ctx */
async function copyDiagnostics(ctx) {
  const events = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS, { reverse: true, limit: 200 }));
  const report = {
    app: ctx.version, platform: platform(), installed: isStandalone(), userAgent: navigator.userAgent,
    storage: await storageStatus(), at: new Date().toISOString(),
    events: events.map((/** @type {any} */ e) => ({ seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, data: e.data })),
  };
  const textOut = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(textOut);
    ctx.notices.toast('Diagnostics copied.');
  } catch {
    ctx.notices.card({ title: "Copying didn't work here. Select and copy this report:", body: textOut.slice(0, 6000) });
  }
}

/** @param {any} ctx */
function eraseControls(ctx) {
  const input = h('input', { id: 'erase-confirm', autocomplete: 'off', autocapitalize: 'characters' });
  const go = h('button', {
    class: 'btn danger', type: 'button', disabled: true,
    onclick: async () => {
      go.disabled = true;
      ctx.store.close();
      await eraseDatabase();
      try { await caches.delete('annai-inbox'); } catch { /* no caches */ }
      location.hash = '#/trips';
      location.reload();
    },
  }, 'Erase now');
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'ERASE'; });
  return h('div', { class: 'screen' },
    h('p', { class: 'sub', text: 'Deletes every trip, file, setting and key on this device. Export a backup first.' }),
    field('Type ERASE to confirm', input),
    h('div', { class: 'acts' }, go));
}
```

- [ ] **Step 5: Implement `src/ui/screens/import.js`**

```js
import { h, field, checkbox, radios } from '../dom.js';
import { openArchive, describeArchive, importArchive, NeedsPassphraseError } from '../../core/archive.js';
import { PassphraseError } from '../../core/archive-crypto.js';
import { takePendingImport } from '../import-state.js';
import { openFileButton } from '../open-file.js';
import { relTime, bytes } from '../format.js';

/** @typedef {{ name: string, bytes: Uint8Array }} Source */

/** @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderImport(ctx, route) {
  const body = h('div', { class: 'screen' });
  const screen = h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'Open a trip' }), body);
  /** @type {Source | null} */
  let source;
  try {
    source = await pickSource(route.params);
  } catch (e) {
    body.append(h('p', { class: 'error', role: 'alert', text: String(/** @type {any} */ (e)?.message ?? e) }), openFileButton(ctx, 'Choose a file instead'));
    return screen;
  }
  if (!source) {
    body.append(h('p', { class: 'empty', text: 'Choose an annai file (.annai.zip or .annai) to open it.' }), openFileButton(ctx, 'Choose a file'));
    return screen;
  }
  await step(ctx, body, source);
  return screen;
}

/** @param {Record<string, string>} params @returns {Promise<Source | null>} */
async function pickSource(params) {
  const pending = takePendingImport();
  if (pending) return { name: pending.name, bytes: new Uint8Array(await pending.arrayBuffer()) };
  if (params.url) {
    /** @type {Response} */
    let res;
    try {
      res = await fetch(params.url);
    } catch {
      throw new Error("annai couldn't download that file. The site may not allow other web apps to download it.");
    }
    if (!res.ok) throw new Error(`The download failed (${res.status} ${res.statusText}).`);
    const name = decodeURIComponent(new URL(params.url).pathname.split('/').pop() || 'trip');
    return { name, bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  if (params.inbox) {
    const inbox = await caches.open('annai-inbox');
    const [first] = await inbox.keys();
    if (!first) return null;
    const res = await inbox.match(first);
    await inbox.delete(first);
    if (!res) return null;
    return { name: decodeURIComponent(res.headers.get('X-Annai-Name') ?? 'shared file'), bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  return null;
}

/** @param {any} ctx @param {HTMLElement} body @param {Source} source @param {string} [passphrase] */
async function step(ctx, body, source, passphrase) {
  body.replaceChildren(h('p', { class: 'sub', text: `Reading ${source.name}…` }));
  /** @type {any} */
  let opened;
  try {
    opened = await openArchive(source.bytes, passphrase);
  } catch (e) {
    if (e instanceof NeedsPassphraseError || e instanceof PassphraseError) {
      body.replaceChildren(passphraseForm(ctx, body, source, e instanceof PassphraseError ? e.message : null));
      return;
    }
    body.replaceChildren(h('p', { class: 'error', role: 'alert', text: String(/** @type {any} */ (e)?.message ?? e) }), openFileButton(ctx, 'Choose another file'));
    return;
  }
  body.replaceChildren(preview(ctx, body, opened, await describeArchive(ctx.store, opened)));
}

/** @param {any} ctx @param {HTMLElement} body @param {Source} source @param {string | null} problem */
function passphraseForm(ctx, body, source, problem) {
  const input = h('input', { id: 'import-pass', type: 'password', autocomplete: 'off' });
  return h('form', { class: 'panel', onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); step(ctx, body, source, input.value); } },
    h('p', { text: `${source.name} is encrypted.` }),
    problem ? h('p', { class: 'error', role: 'alert', text: problem }) : null,
    field('Passphrase', input),
    h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, 'Unlock')));
}

/** @param {any} ctx @param {HTMLElement} body @param {any} opened @param {any} desc */
function preview(ctx, body, opened, desc) {
  /** @type {Record<string, 'new'|'replace'>} */
  const trips = {};
  const rows = desc.trips.map((/** @type {any} */ t) => {
    trips[t.scope] = 'new';
    return h('li', { class: 'card' },
      h('span', { class: 'name', text: t.title }),
      h('span', { class: 'sub', text: `${t.files} files · ${bytes(t.bytes)}${t.history ? ' · with history' : ''}` }),
      t.existing
        ? radios(`You already have "${t.existingTitle}"`, [['new', 'Add as a new trip'], ['replace', 'Replace mine (yours moves to archived trips)']], 'new', (v) => { trips[t.scope] = /** @type {any} */ (v); })
        : null);
  });
  const me = desc.hasMe ? checkbox('Replace my profile and memory with the ones in this file', false) : null;
  const settings = desc.hasSettings ? checkbox('Replace my settings', false) : null;
  const plugins = desc.hasPlugins ? checkbox('Replace my plugins', false) : null;
  const keys = desc.hasSecrets ? checkbox('Restore API keys', true) : null;
  const status = h('p', { class: 'sub', role: 'status' });
  const go = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      go.disabled = true;
      status.textContent = 'Importing…';
      try {
        const result = await importArchive(ctx.store, opened, {
          trips, me: me?.input.checked ? 'replace' : 'keep', settings: settings?.input.checked ? 'replace' : 'keep',
          plugins: plugins?.input.checked ? 'replace' : 'keep', secrets: keys?.input.checked ?? false,
        });
        const titles = desc.trips.map((/** @type {any} */ t) => t.title);
        body.replaceChildren(h('div', { class: 'panel' },
          h('p', { role: 'status', text: 'Imported.' }),
          h('div', { class: 'acts' }, ...result.trips.map((id, i) => h('a', { class: 'btn pri', href: `#/trip/${encodeURIComponent(id)}` }, `Open ${titles[i] ?? 'trip'}`))),
          result.archived.length ? h('p', { class: 'sub', text: `${result.archived.length} older ${result.archived.length === 1 ? 'copy' : 'copies'} moved to archived trips.` }) : null,
          result.settings || result.plugins ? h('p', { class: 'sub', text: 'Restart annai to use the imported settings and plugins.' }) : null));
      } catch (e) {
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
        go.disabled = false;
      }
    },
  }, 'Import');
  return h('div', { class: 'panel' },
    h('p', { text: `${desc.kind === 'everything' ? 'A backup of everything' : 'A trip'} exported ${relTime(desc.created)} from annai ${desc.app}${desc.encrypted ? ', encrypted' : ''}.` }),
    rows.length ? h('ul', { class: 'cards' }, ...rows) : h('p', { class: 'sub', text: 'There are no trips in this file.' }),
    h('div', { class: 'checks' }, me?.el ?? null, settings?.el ?? null, plugins?.el ?? null, keys?.el ?? null),
    h('div', { class: 'acts' }, go),
    status);
}
```

- [ ] **Step 6: Implement `src/ui/screens/trace.js`**

```js
import { h, field } from '../dom.js';

/** @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderTrace(ctx, route) {
  const scopes = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.listScopes());
  const titles = new Map(scopes.map((/** @type {any} */ s) => [s.id, s.kind === 'sys' ? `System · ${s.title}` : s.title]));
  const select = h('select', { id: 'trace-scope' }, h('option', { value: '', text: 'Everything' }),
    ...scopes.map((/** @type {any} */ s) => h('option', { value: s.id, text: titles.get(s.id) })));
  select.value = route.params.scope ?? '';
  const filter = h('input', { id: 'trace-type', autocomplete: 'off', placeholder: 'file.write', value: route.params.type ?? '' });
  const list = h('ol', { class: 'trace' });
  let pending = 0;
  const load = async () => {
    const my = ++pending;
    const ids = select.value ? [select.value] : scopes.map((/** @type {any} */ s) => s.id);
    const all = (await Promise.all(ids.map((/** @type {string} */ id) => ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(id, { reverse: true, limit: 300 }))))).flat();
    if (my !== pending) return;
    const f = filter.value.trim();
    const rows = all.filter((e) => !f || e.type.includes(f)).sort((a, b) => b.ts - a.ts || b.seq - a.seq).slice(0, 300);
    list.replaceChildren(...(rows.length ? rows.map((e) => row(e, titles)) : [h('li', { class: 'empty', text: 'Nothing here yet.' })]));
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  select.addEventListener('change', load);
  filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 150); });
  await load();
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Trace' }),
    h('p', { class: 'sub', text: 'Everything annai recorded: file changes, imports, plugin problems and errors. Newest first.' }),
    h('div', { class: 'row' }, field('Show', select), field('Type contains', filter)),
    list);
}

/** @param {any} e @param {Map<string, string>} titles */
function row(e, titles) {
  const summary = e.type.startsWith('file.') ? e.data?.path ?? '' : e.data?.message ?? e.data?.title ?? '';
  return h('li', {}, h('details', {},
    h('summary', {},
      h('span', { class: 'tm', text: new Date(e.ts).toLocaleString() }),
      h('span', { class: 'k', text: e.type }),
      h('span', { class: 'sub', text: `${titles.get(e.scope) ?? e.scope} · ${e.actor}` }),
      h('span', { class: 'd', text: summary })),
    h('pre', { text: JSON.stringify(e, null, 2) })));
}
```

- [ ] **Step 7: Register the screens and update the SHELL**

In `src/ui/shell.js` add:
```js
import { renderSettings } from './screens/settings.js';
import { renderImport } from './screens/import.js';
import { renderTrace } from './screens/trace.js';
```
and extend the table: `{ trips: renderTrips, trip: renderTrip, file: renderFile, settings: renderSettings, import: renderImport, trace: renderTrace }`.

In `sw.js` SHELL, add `'/src/ui/export-panel.js'`, `'/src/ui/screens/import.js'`, `'/src/ui/screens/settings.js'` and `'/src/ui/screens/trace.js'` (sorted).

- [ ] **Step 8: Run the tests**

Run: `npm test && npm run typecheck && npx playwright test`
Expected: everything passes in each available project. In particular, `roundtrip.spec.js` passes; that's milestone 1's "done when" in a browser.

- [ ] **Step 9: Commit**

```bash
git add src/ui sw.js test/e2e/roundtrip.spec.js test/e2e/trace.spec.js
git commit -m "Add export, import, settings, erase and the trace viewer"
```

---

### Task 17: Plugins screen

**Files:**
- Create: `src/ui/screens/plugins.js`, `test/e2e/plugins.spec.js`
- Modify: `src/ui/shell.js` (register screen), `sw.js` (SHELL)

**Interfaces:**
- Consumes:
  - `PluginHost.describe/install/start/setEnabled/uninstall` (Task 11)
  - `readZip` (Task 8)
  - `twoStep` (Task 13)
- Produces:
  - Screen `plugins`
  - The page labels used by tests: "Install a plugin from a file", "Turn off", "Turn on", "Uninstall"

- [ ] **Step 1: Write the failing e2e test** `test/e2e/plugins.spec.js`

```js
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker } from './helpers.js';
import { ZipWriter } from '../../src/core/zip.js';

async function helloZip() {
  const z = new ZipWriter();
  for (const name of ['annai-plugin.json', 'index.js']) {
    await z.add(`hello/${name}`, new Uint8Array(await readFile(new URL(`../fixtures/plugins/hello/${name}`, import.meta.url))));
  }
  return Buffer.from(await z.finish().arrayBuffer());
}

test('install a plugin, see it work, turn it off, uninstall it', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await page.getByLabel('Trip name').fill('Plugin trip');
  await page.getByRole('button', { name: 'Start trip' }).click();
  const tripUrl = page.url();

  await page.goto('/#/plugins');
  await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
  await expect(page.getByText('Trip record checks')).toBeVisible();
  await page.getByLabel('Install a plugin from a file').setInputFiles({ name: 'hello.zip', mimeType: 'application/zip', buffer: await helloZip() });
  await expect(page.getByText('Hello checks 1.0.0')).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();

  await page.goto(tripUrl);
  await page.getByLabel('File path').fill('/hello/a.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('alert')).toContainText('greeting');

  await page.goto('/#/plugins');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  await page.goto(tripUrl);
  await page.getByLabel('File path').fill('/hello/a.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/hello/a.json' })).toBeVisible();

  await page.goto('/#/plugins');
  await page.getByRole('button', { name: 'Uninstall' }).click();
  await page.getByRole('button', { name: 'Tap again to uninstall' }).click();
  await expect(page.getByText('Hello checks 1.0.0')).toHaveCount(0);
});

test('a bad plugin file is refused with a reason', async ({ page }) => {
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  await page.getByLabel('Install a plugin from a file').setInputFiles({ name: 'junk.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await expect(page.getByText("That plugin wasn't installed")).toBeVisible();
});
```

Run: `npx playwright test test/e2e/plugins.spec.js --project=chromium`
Expected: FAIL (there's no Plugins screen yet).

- [ ] **Step 2: Implement `src/ui/screens/plugins.js`**

```js
import { h, twoStep } from '../dom.js';
import { readZip } from '../../core/zip.js';

/** @param {any} ctx */
export async function renderPlugins(ctx) {
  const rows = await ctx.plugins.describe();
  const input = h('input', {
    id: 'plugin-file', type: 'file', class: 'visually-hidden', accept: '.zip,application/zip',
    onchange: async () => {
      const f = input.files?.[0];
      input.value = '';
      if (!f) return;
      try {
        if (!navigator.serviceWorker?.controller) {
          throw new Error("Plugins load through annai's offline service, which isn't running yet. Reload annai and try again.");
        }
        const files = await readZip(new Uint8Array(await f.arrayBuffer()));
        const manifest = await ctx.plugins.install(files, { source: f.name });
        await ctx.plugins.start(manifest.id);
        ctx.notices.toast(`Installed ${manifest.name}.`);
      } catch (e) {
        ctx.notices.card({ tone: 'warn', title: "That plugin wasn't installed", body: String(/** @type {any} */ (e)?.message ?? e) });
      }
      ctx.render();
    },
  });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Plugins' }),
    h('p', { class: 'risk-note', text: 'A plugin gets full access to your trips and API keys. Only install plugins you trust.' }),
    h('ul', { class: 'cards' }, ...rows.map((/** @type {any} */ r) => row(ctx, r))),
    h('div', { class: 'acts' }, h('label', { class: 'btn pri', for: 'plugin-file' }, 'Install a plugin from a file'), input));
}

/** @param {any} ctx @param {any} r */
function row(ctx, r) {
  const on = r.enabled && !r.failing;
  const state = r.builtin ? 'Built in' : r.failing ? 'Turned off after repeated errors' : r.enabled ? (r.active ? 'On' : "On, but it didn't start") : 'Off';
  return h('li', { class: 'card' },
    h('span', { class: 'name', text: `${r.name} ${r.version}` }),
    h('span', { class: 'sub', text: state }),
    r.description ? h('p', { class: 'sub', text: r.description }) : null,
    r.builtin ? null : h('div', { class: 'acts' },
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            await ctx.plugins.setEnabled(r.id, !on);
          } catch (e) {
            ctx.notices.card({ tone: 'warn', title: `${r.name} didn't start`, body: String(/** @type {any} */ (e)?.message ?? e) });
          }
          ctx.render();
        },
      }, on ? 'Turn off' : 'Turn on'),
      twoStep('Uninstall', 'Tap again to uninstall', async () => { await ctx.plugins.uninstall(r.id); ctx.render(); })));
}
```

- [ ] **Step 3: Register the screen and update the SHELL**

In `src/ui/shell.js`, add `import { renderPlugins } from './screens/plugins.js';` and `plugins: renderPlugins` to the table. In `sw.js` SHELL, add `'/src/ui/screens/plugins.js'`.

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck && npx playwright test test/e2e/plugins.spec.js`
Expected: both tests pass in each project where service workers run.

- [ ] **Step 5: Commit**

```bash
git add src/ui sw.js test/e2e/plugins.spec.js
git commit -m "Add the plugins screen: install from a file, turn on and off, uninstall"
```

---

### Task 18: CI, size budget, docs and final verification

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/size.mjs`, `docs/testing/device-checklist-m1.md`
- Modify: `README.md` (Develop section)

**Interfaces:**
- Consumes: everything.
- Produces:
  - `npm run size` (fails over budget)
  - CI on push and pull request
  - The manual device checklist

- [ ] **Step 1: Write `scripts/size.mjs`**

```js
// Fails when the JavaScript and CSS annai ships grow past the budget (spec §18).
import { readFile, stat } from 'node:fs/promises';

const BUDGET = 300 * 1024; // bytes, uncompressed, for milestone 1
const root = new URL('../', import.meta.url);
const sw = await readFile(new URL('sw.js', root), 'utf8');
const shell = [...(/const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '').matchAll(/'(\/[^']+\.(?:js|css))'/g)].map((m) => m[1]);
let total = 0;
for (const p of shell) total += (await stat(new URL(p.slice(1), root))).size;
total += (await stat(new URL('sw.js', root))).size;
console.log(`shipped JS + CSS: ${(total / 1024).toFixed(1)} KiB (budget ${BUDGET / 1024} KiB)`);
if (total > BUDGET) {
  console.error('Over budget: trim code or raise the budget on purpose.');
  process.exit(1);
}
```

Run: `npm run size`
Expected: prints a total well under 300 KiB and exits 0.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
  pull_request:
jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 26
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run size
      - run: npx playwright install --with-deps chromium webkit
      - run: npx playwright test
        env:
          CI: '1'
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report
```

- [ ] **Step 3: Write `docs/testing/device-checklist-m1.md`**

```markdown
# Milestone 1: device checklist

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), against the deployed site or the dev server tunnelled over HTTPS.

## Install and storage
- [ ] In a browser tab, the "annai isn't installed yet" card shows. "Show me how" lists the right steps for the phone.
- [ ] Android: the "Install annai" button appears and installs the app.
- [ ] iPhone: Share → Add to Home Screen; open from the Home Screen; the warning is gone.
- [ ] Settings → Storage says "Protected from automatic clearing: yes" in the installed app (tap "Protect my data" if not).

## Offline
- [ ] With the installed app opened once, turn on airplane mode, force-quit and reopen: Trips loads and trips are there.

## Trips and files
- [ ] Create a trip with Japanese text in its name. Add a note, edit it twice, restore the first version.
- [ ] Upload a photo from the camera roll; it shows on the file screen.

## Export and import
- [ ] Export everything with a passphrase. "Save file" opens the share sheet; save to Files (iPhone) or Downloads (Android).
- [ ] Settings → Erase → type ERASE → Erase now. Trips is empty.
- [ ] Open the saved file from Trips → "Open a trip someone sent you", enter the passphrase, tick "Replace my profile and memory", Import. Everything is back, including history.
- [ ] Android: share a `.annai.zip` from Files to annai; the import screen opens with it.
- [ ] AirDrop or message a trip export to the other phone and import it there.

## One instance and errors
- [ ] Open annai in a second Safari/Chrome tab: "annai is open in another tab" → "Use it here"; the first tab shows that it stopped.

## Plugins (service worker)
- [ ] Install `test/fixtures/plugins/hello` zipped; creating `/hello/a.json` in a trip is refused until the plugin is turned off.

## Updates
- [ ] Deploy a version bump while the app is open: "An update is ready" appears; it does not reload by itself; "Restart now" reloads into the new version.
```

- [ ] **Step 4: Add the Develop section to `README.md`**

Append:
```markdown
## Develop

annai has no build step and no runtime dependencies. Node 26 runs the tools.

```bash
npm install
npx playwright install chromium webkit
npm run serve      # http://127.0.0.1:8765 with the production CSP
npm run check      # type-check, unit tests, size budget
npm run e2e        # Playwright: Chromium as a Pixel 7, WebKit as an iPhone 15
```

`docs/testing/device-checklist-m1.md` lists what to verify by hand on real phones.
```

- [ ] **Step 5: Run everything**

Run: `npm run check && npx playwright test`
Expected: type-check clean; all unit tests pass; size within budget; all e2e tests pass (WebKit as far as this machine allows; CI runs both).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml scripts/size.mjs docs/testing/device-checklist-m1.md README.md
git commit -m "Add CI, a size budget and the milestone 1 device checklist"
```

---

## Self-review notes (filled in after writing)

Spec coverage for milestone 1 (§20 row 1):

| Milestone 1 item | Where |
|---|---|
| App shell and service worker | Tasks 13, 14 |
| Install and data-loss warnings, `persist()` | Task 13 (banner, persist on install and first trip), Task 16 (Settings → Storage) |
| Storage §4: stores, write path, records, events, robustness | Tasks 5, 6, 7, 12 |
| Event log | Tasks 5–7; trace viewer in Task 16 |
| Registry and plugin loading §5 | Tasks 11, 14 (served by the service worker), 17 |
| Settings | Tasks 7, 16 |
| Archive export and import §12.1–12.3 | Tasks 8–10, 16; share target in Task 14; `#import=` in Task 16 |
| Trace viewer | Task 16 |
| Errors §17 rules 1, 3, 4, 5 | Tasks 6 (storage full), 10 (refusals), 13 (global catch), 14 (updates wait), 16 (diagnostics) |
| Done when: create → edit → export → wipe → import intact | `test/e2e/roundtrip.spec.js` (Task 16), plus the device checklist (Task 18) |

Deliberately left for later milestones:
- Skills, MCP, and the UI slots (milestone 8).
- Remote backup targets (milestone 9).
- Unreferenced-blob cleanup (it belongs with the storage-full options in milestone 2's trace-body work).
