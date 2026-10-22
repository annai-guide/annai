/**
 * annai's tool schemas as Gemini fills them, and its calls' arguments back as the tools take them. Pure.
 *
 * Gemini's Interactions API takes a tool's parameters as JSON Schema, and fills them by its schema, as measured on
 * 2026-10-22 (gemini-3.5-flash-lite, and gemini-3.5-flash for keys):
 * - an object with no properties is filled only as {}: `type: object`, `type: [string, object]` and an anyOf of
 *   the two alike, so Shiori wrote a booking as `content: {}` three times over;
 * - an open object (additionalProperties: true) is filled, but only with keys like names: a merge patch's "notes+"
 *   came back "notes__append", and "Content-Type" as "Content".
 * So an object whose keys aren't named (free-form) goes as JSON text, which takes any key, and its description says
 * so; it comes back as the object when the text is one, and as the text otherwise, for the tool to refuse in words.
 * One that may also be text (write's content) goes as text: the tool takes text as it is, a .json file's text too.
 * The input as a whole stays an object, as Gemini asks.
 */

/** What a free-form object's description says, after its own. */
export const OBJECT_TEXT = 'Give it as JSON text: an object, such as {"key": "value"}.';
/** What a string-or-object's description says, after its own. */
export const TEXT_OR_OBJECT = 'Text; an object goes as its JSON text, such as {"key": "value"}.';

/** The keywords that describe an object's keys, which a free-form object sent as text leaves out. */
const OBJECT_WORDS = new Set(['properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'required',
  'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas']);
/** Keywords whose value is a map of names to schemas. */
const MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];
/** Keywords whose value is a schema, or a list of them. */
const ONE = ['additionalProperties', 'items', 'not'];
const MANY = ['prefixItems', 'items', 'anyOf', 'oneOf', 'allOf'];
/** How deep a schema is walked, and how many $refs in a row are followed. */
const DEPTH = 32;
const REFS = 8;

/** @param {unknown} x @returns {x is Record<string, any>} */
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
/** @param {Record<string, any>} s @returns {unknown[]} */
const typesOf = (s) => (s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]);
/** An object whose keys aren't named: Gemini fills it only as {}. @param {Record<string, any>} s */
const free = (s) => typesOf(s).includes('object') && !(isObject(s.properties) && Object.keys(s.properties).length);
/** @param {Record<string, any>} s */
const takesText = (s) => typesOf(s).includes('string');

/**
 * A tool's input schema as Gemini is sent it: each free-form object below the top as JSON text, the rest as it is.
 * @param {unknown} schema @returns {any}
 */
export function forGemini(schema) {
  return isObject(schema) ? translate(schema, true, 0) : schema;
}

/** @param {any} s @param {boolean} top @param {number} depth @returns {any} */
function translate(s, top, depth) {
  if (!isObject(s) || depth > DEPTH) return s;
  if (!top && free(s)) {
    const type = [...new Set(typesOf(s).map((t) => (t === 'object' ? 'string' : t)))];
    const note = takesText(s) ? TEXT_OR_OBJECT : OBJECT_TEXT;
    const rest = Object.fromEntries(Object.entries(s).filter(([k]) => !OBJECT_WORDS.has(k) && k !== 'type' && k !== 'description'));
    return { ...rest, type: type.length === 1 ? type[0] : type, description: s.description ? `${s.description} ${note}` : note };
  }
  /** @type {Record<string, any>} */
  const out = { ...s };
  for (const k of MAPS) if (isObject(s[k])) out[k] = Object.fromEntries(Object.entries(s[k]).map(([n, x]) => [n, translate(x, false, depth + 1)]));
  for (const k of ONE) if (isObject(s[k])) out[k] = translate(s[k], false, depth + 1);
  for (const k of MANY) if (Array.isArray(s[k])) out[k] = s[k].map((x) => translate(x, false, depth + 1));
  return out;
}

/** The schema a local $ref names ("#/$defs/Filter"), or undefined. @param {any} root @param {string} ref */
function lookUp(root, ref) {
  if (!ref.startsWith('#')) return undefined;
  let at = root;
  for (const part of ref.slice(1).split('/').slice(1)) at = isObject(at) ? at[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  return at;
}

/** A schema with its $refs followed, a few in a row at most; undefined for one that can't be. @param {any} s @param {any} root */
function follow(s, root) {
  for (let i = 0; i < REFS && isObject(s) && typeof s.$ref === 'string'; i++) s = lookUp(root, s.$ref);
  return isObject(s) && typeof s.$ref !== 'string' ? s : undefined;
}

/**
 * A call's arguments as the tool takes them: each free-form object Gemini gave as JSON text, as the object when the
 * text is one. Text in a place that takes text stays text. Arguments that weren't JSON (kept as text) stay as they are.
 * @param {unknown} schema the tool's own input schema @param {unknown} args
 */
export function fromGemini(schema, args) {
  return walk(schema, args, schema, (s, v, options) => {
    if (typeof v !== 'string') return undefined;
    const parse = free(s) ? !takesText(s) : options.some(free) && !takesText(s) && !options.some(takesText);
    if (!parse) return v;
    try {
      const value = JSON.parse(v);
      return isObject(value) ? value : v;
    } catch {
      return v;
    }
  }, 0);
}

/**
 * A call's arguments as Gemini fills them, for a call that goes back to it: each free-form object as its JSON text.
 * fromGemini takes them back to what they were.
 * @param {unknown} schema the tool's own input schema @param {unknown} input
 */
export function toGeminiArgs(schema, input) {
  return walk(schema, input, schema, (s, v, options) => {
    if (!isObject(v)) return undefined;
    const text = free(s) || (options.some(free) && !options.some((o) => typesOf(o).includes('object') && !free(o)));
    return text ? JSON.stringify(v) : undefined;
  }, 0);
}

/**
 * The value walked alongside its schema: at each place, leaf may give the value there (undefined: walk on into it).
 * Nothing is changed in place.
 * @param {any} schema @param {any} v @param {any} root
 * @param {(s: Record<string, any>, v: any, options: Record<string, any>[]) => any} leaf options: the anyOf and oneOf schemas there
 * @param {number} depth @returns {any}
 */
function walk(schema, v, root, leaf, depth) {
  const s = follow(schema, root);
  if (!s || depth > DEPTH) return v;
  const options = [...(Array.isArray(s.anyOf) ? s.anyOf : []), ...(Array.isArray(s.oneOf) ? s.oneOf : [])].map((o) => follow(o, root)).filter((o) => o !== undefined);
  const done = depth === 0 ? undefined : leaf(s, v, options);
  if (done !== undefined) return done;
  let out = v;
  for (const part of Array.isArray(s.allOf) ? s.allOf : []) out = walk(part, out, root, leaf, depth + 1);
  if (Array.isArray(out)) {
    const shape = [s, ...options].find((o) => Array.isArray(o.prefixItems) || o.items !== undefined);
    if (!shape) return out;
    const listed = Array.isArray(shape.prefixItems) ? shape.prefixItems : Array.isArray(shape.items) ? shape.items : [];
    const rest = isObject(shape.items) ? shape.items : undefined;
    return out.map((x, i) => {
      const sub = listed[i] ?? rest;
      return sub ? walk(sub, x, root, leaf, depth + 1) : x;
    });
  }
  if (isObject(out)) {
    const shape = [s, ...options].find((o) => !free(o) && (isObject(o.properties) || isObject(o.patternProperties) || isObject(o.additionalProperties)));
    if (!shape) return out;
    /** @type {Record<string, any>} */
    const next = {};
    for (const [k, x] of Object.entries(out)) {
      const named = isObject(shape.properties) && Object.hasOwn(shape.properties, k) ? shape.properties[k] : undefined;
      const patterned = named ?? Object.entries(isObject(shape.patternProperties) ? shape.patternProperties : {}).find(([p]) => matches(p, k))?.[1];
      const sub = patterned ?? (isObject(shape.additionalProperties) ? shape.additionalProperties : undefined);
      next[k] = sub ? walk(sub, x, root, leaf, depth + 1) : x;
    }
    return next;
  }
  return out;
}

/** Whether a key matches a patternProperties pattern; a pattern annai can't read matches nothing. @param {string} pattern @param {string} key */
function matches(pattern, key) {
  try {
    return new RegExp(pattern, 'u').test(key);
  } catch {
    return false;
  }
}
