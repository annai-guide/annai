/**
 * annai's tool schemas as Gemini fills them, and its calls' arguments back as the tools take them. Pure.
 *
 * Gemini's Interactions API takes a tool's parameters as JSON Schema, and fills them by its schema, as measured on
 * 2026-10-22 (gemini-3.5-flash-lite, and gemini-3.5-flash for keys):
 * - an object with no properties is filled only as {}: `type: object`, `type: [string, object]` and an anyOf of
 *   the two alike, so Shiori wrote a booking as `content: {}` three times over;
 * - an open object (additionalProperties: true) is filled, but only with keys like names: a merge patch's "notes+"
 *   came back "notes__append", and "Content-Type" as "Content".
 * So a free-form object below the top (typed object, with no `properties`, or with extra keys let in by
 * additionalProperties, true or a schema) goes as JSON text, which takes any key, and its description says so; it comes
 * back as the object when the text is one, and as the text otherwise, for the tool to refuse in words. One that may also
 * be text (write's content) goes as text both ways: the tool takes text as it is, a .json file's text too.
 *
 * Only `properties`, `items` and `prefixItems` are walked, from the top down, once each. A $ref is never followed, and
 * $defs, allOf, anyOf, oneOf, not, if/then/else and patternProperties go as they are, with all that is in them: Gemini
 * may fill a free-form object there as {}, as it did before. A schema (an MCP server's) whose walked paths are too big
 * or too deep is sent as it is, and its calls come back and go back as they came. Keys are only ever defined, never
 * assigned, so "__proto__" stays a key.
 */

/** What a free-form object's description says, after its own. */
export const OBJECT_TEXT = 'Give it as JSON text: an object, such as {"key": "value"}.';
/** What a string-or-object's description says, after its own. */
export const TEXT_OR_OBJECT = 'Text; an object goes as its JSON text, such as {"key": "value"}.';

/** How many nodes and property keys the walked paths may have, and how deep they may go: far past any real tool's. */
const BUDGET = 50_000;
const DEPTH = 100;

/** @param {unknown} x @returns {x is Record<string, any>} */
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
/** A schema's types. JSON Schema has seven, so a longer list isn't one. @param {Record<string, any>} s @returns {unknown[]} */
const typesOf = (s) => (typeof s.type === 'string' ? [s.type] : Array.isArray(s.type) && s.type.length <= 7 ? s.type : []);
/** The schemas a list's items take by place: prefixItems, or an older schema's items list. @param {Record<string, any>} s @returns {unknown[]} */
const byPlace = (s) => (Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : []);

/**
 * What a schema below the top goes as: 'text' (a free-form object), 'union' (text or an object) or 'walk' (as it is,
 * its properties and items walked). The top is always walked: the input as a whole stays an object.
 * @param {unknown} s @returns {'text' | 'union' | 'walk'}
 */
function kind(s) {
  if (!isObject(s) || !typesOf(s).includes('object')) return 'walk';
  if (typesOf(s).includes('string')) return 'union';
  return !isObject(s.properties) || s.additionalProperties === true || isObject(s.additionalProperties) ? 'text' : 'walk';
}

/** Whether the paths walked fit the budget and the depth, counted as they are walked, and given up at once when they don't. @param {Record<string, any>} schema */
function fits(schema) {
  let left = BUDGET;
  /** @param {unknown} s @param {number} depth @returns {boolean} */
  const count = (s, depth) => {
    if (--left < 0 || depth > DEPTH) return false;
    if (!isObject(s) || (depth > 0 && kind(s) !== 'walk')) return true;
    const props = isObject(s.properties) ? s.properties : {};
    const names = Object.keys(props);
    if ((left -= names.length) < 0) return false;
    const next = (/** @type {unknown} */ x) => count(x, depth + 1);
    return names.every((name) => next(props[name])) && byPlace(s).every(next) && (!isObject(s.items) || next(s.items));
  };
  return count(schema, 0);
}

/**
 * A tool's input schema as Gemini is sent it: each free-form object below the top as JSON text, the rest as it is.
 * @param {unknown} schema @returns {any}
 */
export function forGemini(schema) {
  return isObject(schema) && fits(schema) ? translate(schema, true) : schema;
}

/** @param {unknown} s @param {boolean} top @returns {unknown} */
function translate(s, top) {
  const as = top ? 'walk' : kind(s);
  if (!isObject(s)) return s;
  if (as !== 'walk') {
    const types = [...new Set(typesOf(s).map((t) => (t === 'object' ? 'string' : t)))];
    const note = as === 'union' ? TEXT_OR_OBJECT : OBJECT_TEXT;
    return { ...(typeof s.title === 'string' ? { title: s.title } : {}), type: types.length === 1 ? types[0] : types, description: typeof s.description === 'string' && s.description ? `${s.description} ${note}` : note };
  }
  const out = { ...s };
  /** @param {unknown} x */
  const each = (x) => translate(x, false);
  if (isObject(s.properties)) out.properties = Object.fromEntries(Object.entries(s.properties).map(([name, x]) => [name, each(x)]));
  if (Array.isArray(s.prefixItems)) out.prefixItems = s.prefixItems.map(each);
  else if (Array.isArray(s.items)) out.items = s.items.map(each);
  if (isObject(s.items)) out.items = each(s.items);
  return out;
}

/**
 * A call's arguments as the tool takes them: each free-form object Gemini gave as JSON text, as the object when the
 * text is one. A union's text stays text. Arguments that weren't JSON (kept as text) stay as they are.
 * @param {unknown} schema the tool's own input schema @param {unknown} args @returns {any}
 */
export function fromGemini(schema, args) {
  return walk(schema, args, (as, v) => (as === 'text' && typeof v === 'string' ? parsed(v) : v));
}

/** Text that is a JSON object, as the object, else the text. @param {string} v */
function parsed(v) {
  try {
    const value = JSON.parse(v);
    return isObject(value) ? value : v;
  } catch {
    return v;
  }
}

/**
 * A call's arguments as Gemini fills them, for a call that goes back to it: each free-form object, and a union's
 * object, as its JSON text. fromGemini takes them back to what they were.
 * @param {unknown} schema the tool's own input schema @param {unknown} input @returns {any}
 */
export function toGeminiArgs(schema, input) {
  return walk(schema, input, (_as, v) => {
    if (!isObject(v)) return v;
    try {
      return JSON.stringify(v);
    } catch {
      return v;
    }
  });
}

/**
 * The value walked down the paths forGemini walks, each key and item once; where it made text, at gives the value.
 * New objects are made with Object.fromEntries, which defines their keys. Nothing is changed in place.
 * @param {unknown} schema @param {unknown} value @param {(as: 'text' | 'union', v: unknown) => unknown} at
 */
function walk(schema, value, at) {
  if (!isObject(schema) || !fits(schema)) return value;
  /** @param {unknown} s @param {unknown} v @param {boolean} top @returns {unknown} */
  const visit = (s, v, top) => {
    const as = top ? 'walk' : kind(s);
    if (as !== 'walk') return at(as, v);
    if (!isObject(s)) return v;
    if (Array.isArray(v)) {
      const first = byPlace(s);
      const rest = isObject(s.items) ? s.items : undefined;
      return first.length || rest ? v.map((x, i) => (i < first.length ? visit(first[i], x, false) : rest ? visit(rest, x, false) : x)) : v;
    }
    if (!isObject(v) || !isObject(s.properties)) return v;
    const props = s.properties;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Object.hasOwn(props, k) ? visit(props[k], x, false) : x]));
  };
  return visit(schema, value, true);
}
