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
