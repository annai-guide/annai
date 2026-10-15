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
