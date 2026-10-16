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
      const prev = own(out, base);
      define(out, base, [...(Array.isArray(prev) ? prev : []), ...add.map(clone)]);
    } else if (value === null) {
      delete out[key];
    } else {
      define(out, key, mergePatch(own(out, key), value, opts));
    }
  }
  return out;
}

/**
 * The merge patch that turns base into edited: changed values, and null for keys edited no
 * longer has, recursing into objects both have, so mergePatch(base, diffPatch(base, edited))
 * equals edited. Arrays and other values are replaced whole. A null value in edited can't be
 * kept, since null deletes in a merge patch.
 * @param {Record<string, any>} base @param {Record<string, any>} edited @returns {Record<string, any>}
 */
export function diffPatch(base, edited) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of Object.keys(base)) if (!Object.hasOwn(edited, k)) define(out, k, null);
  for (const [k, v] of Object.entries(edited)) {
    const was = own(base, k);
    if (JSON.stringify(v) === JSON.stringify(was)) continue;
    define(out, k, isObject(v) && isObject(was) ? diffPatch(was, v) : clone(v));
  }
  return out;
}

// Keys are always own data properties, so "__proto__" in a patch is plain data
// and never changes an object's prototype (no pollution from untrusted patches).
/** @param {Record<string, any>} o @param {string} k */
function own(o, k) {
  return Object.hasOwn(o, k) ? o[k] : undefined;
}

/** @param {Record<string, any>} o @param {string} k @param {any} v */
function define(o, k, v) {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
}

/** @param {unknown} x @returns {x is Record<string, any>} */
function isObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** @param {any} x */
function clone(x) {
  return x === undefined ? undefined : structuredClone(x);
}
