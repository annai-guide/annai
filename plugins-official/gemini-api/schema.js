/**
 * annai's tool schemas as Gemini fills them, and its calls' arguments back as the tools take them. Pure.
 *
 * Gemini's Interactions API takes a tool's parameters as JSON Schema, and fills them by its schema, as measured on
 * 2026-10-22 (gemini-3.5-flash-lite, and gemini-3.5-flash for keys):
 * - an object with no properties is filled only as {}: `type: object`, `type: [string, object]` and an anyOf of
 *   the two alike, so Shiori wrote a booking as `content: {}` three times over;
 * - an open object (additionalProperties: true) is filled, but only with keys like names: a merge patch's "notes+"
 *   came back "notes__append", and "Content-Type" as "Content".
 * So an object whose keys aren't all named (no properties, or extra keys allowed by additionalProperties or
 * patternProperties) goes as JSON text, which takes any key, and its description says so; it comes back as the object
 * when the text is one, and as the text otherwise, for the tool to refuse in words. One that may also be text (write's
 * content) goes as text: the tool takes text as it is, a .json file's text too. The input as a whole stays an object,
 * and so does a combinator's branch (allOf, anyOf, oneOf) of an object that does: it is part of that object.
 *
 * Schemas can come from MCP servers, and arguments from the model, so neither is trusted: every walk has a budget and
 * a depth, and stops at a schema already being walked for the same value. A schema that runs out of either is sent as
 * it is and its calls come back as they came, never half-translated. Schema patterns are never run, and keys are only
 * ever defined, never assigned, so "__proto__" stays a key.
 */

/** What a free-form object's description says, after its own. */
export const OBJECT_TEXT = 'Give it as JSON text: an object, such as {"key": "value"}.';
/** What a string-or-object's description says, after its own. */
export const TEXT_OR_OBJECT = 'Text; an object goes as its JSON text, such as {"key": "value"}.';

/** Visits each translation or walk may make, and how deep it may go. */
const BUDGET = 20_000;
const DEPTH = 500;
/** Thrown when a walk runs out: the whole of it is given up. */
const SPENT = Symbol('spent');
/** What a text schema made from an object stands for: an object only, or text or an object. @type {WeakMap<object, 'object' | 'union'>} */
const made = new WeakMap();
/** Each tool's input schema, translated once. @type {WeakMap<object, { tree: any, ok: boolean }>} */
const plans = new WeakMap();

/** @param {unknown} x @returns {x is Record<string, any>} */
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
/** @param {unknown} x @returns {any[]} */
const list = (x) => (Array.isArray(x) ? x : []);
/** @param {unknown} x */
const named = (x) => isObject(x) && Object.keys(x).length > 0;
/** @param {Record<string, any>} s @returns {unknown[]} */
const typesOf = (s) => (typeof s.type === 'string' ? [s.type] : list(s.type));
/** A key defined, never assigned, so "__proto__" is a key like any other. @param {Record<string, any>} o @param {string} k @param {unknown} value */
const put = (o, k, value) => Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });

/**
 * The schema a local $ref names ("#/$defs/Filter", "#/prefixItems/0"), or undefined: own keys only, and list indexes
 * as JSON Pointer writes them. @param {any} root @param {string} ref
 */
function lookUp(root, ref) {
  if (ref !== '#' && !ref.startsWith('#/')) return undefined;
  let at = root;
  for (const raw of ref === '#' ? [] : ref.slice(2).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(at)) at = /^(0|[1-9]\d*)$/.test(part) && Number(part) < at.length ? at[Number(part)] : undefined;
    else at = isObject(at) && Object.hasOwn(at, part) ? at[part] : undefined;
  }
  return isObject(at) ? at : undefined;
}

/** A budget's step, at a depth. @param {{ left: number }} ctx @param {number} depth */
function step(ctx, depth) {
  if (--ctx.left < 0 || depth > DEPTH) throw SPENT;
}

/** Whether a walk ran out (or the stack did, on a schema deeper than a budget ever lets it go). @param {unknown} e */
const spent = (e) => e === SPENT || e instanceof RangeError;

/**
 * What a schema says of objects, its allOf parts and $ref included: whether it allows an object, text, has named
 * properties, or lets in keys it doesn't name. @param {any} s @param {{ left: number, root: any }} ctx @param {number} depth
 */
function facts(s, ctx, depth) {
  /** @type {Set<object>} */
  const seen = new Set();
  /** @param {any} x @param {number} d @returns {{ object: boolean, text: boolean, props: boolean, open: boolean }} */
  const of = (x, d) => {
    step(ctx, d);
    if (!isObject(x) || seen.has(x)) return { object: false, text: false, props: false, open: false };
    seen.add(x);
    const parts = [...list(x.allOf), ...(typeof x.$ref === 'string' ? [lookUp(ctx.root, x.$ref)] : [])].map((p) => of(p, d + 1));
    const types = typesOf(x);
    return {
      object: types.includes('object') || (!types.length && parts.some((p) => p.object)),
      text: types.includes('string') || (!types.length && parts.some((p) => p.text)),
      props: named(x.properties) || parts.some((p) => p.props),
      open: x.additionalProperties === true || isObject(x.additionalProperties) || named(x.patternProperties) || parts.some((p) => p.open),
    };
  };
  return of(s, depth);
}

/** Whether a schema goes as text: an object whose keys aren't all named, never one kept as an object. @param {ReturnType<typeof facts>} f @param {boolean} keep */
const asText = (f, keep) => !keep && f.object && (!f.props || f.open);

/** A tool's input schema translated, or as it is when it is too big to walk. @param {any} schema */
function plan(schema) {
  const had = isObject(schema) ? plans.get(schema) : undefined;
  if (had) return had;
  const ctx = { left: BUDGET, root: schema, inlining: new Set() };
  let p;
  try {
    p = { tree: isObject(schema) ? translate(schema, true, ctx, 0) : schema, ok: true };
  } catch (e) {
    if (!spent(e)) throw e;
    p = { tree: schema, ok: false };
  }
  if (isObject(schema)) plans.set(schema, p);
  return p;
}

/**
 * A tool's input schema as Gemini is sent it: each free-form object below the top as JSON text, the rest as it is.
 * @param {unknown} schema @returns {any}
 */
export function forGemini(schema) {
  return plan(schema).tree;
}

/**
 * keep: the schema is an object that stays one (the top, or a branch of an object that does).
 * @param {any} s @param {boolean} keep @param {{ left: number, root: any, inlining: Set<object> }} ctx @param {number} depth @returns {any}
 */
function translate(s, keep, ctx, depth) {
  step(ctx, depth);
  if (!isObject(s)) return s;
  // A $ref where the object is kept: what it names is put in its place when that would go as text where it is defined.
  if (keep && typeof s.$ref === 'string') {
    const target = lookUp(ctx.root, s.$ref);
    const f = target && facts(target, ctx, depth);
    if (target && f && (!f.props || f.open) && !ctx.inlining.has(target)) {
      ctx.inlining.add(target);
      try {
        const { $ref, ...rest } = s;
        return translate({ ...rest, allOf: [...list(rest.allOf), target] }, true, ctx, depth + 1);
      } finally {
        ctx.inlining.delete(target);
      }
    }
  }
  const f = facts(s, ctx, depth);
  if (asText(f, keep)) {
    const types = typesOf(s).includes('object') ? [...new Set(typesOf(s).map((t) => (t === 'object' ? 'string' : t)))] : ['string'];
    const note = f.text ? TEXT_OR_OBJECT : OBJECT_TEXT;
    const out = { ...(typeof s.title === 'string' ? { title: s.title } : {}), type: types.length === 1 ? types[0] : types, description: typeof s.description === 'string' && s.description ? `${s.description} ${note}` : note };
    made.set(out, f.text ? 'union' : 'object');
    return out;
  }
  const inner = keep || f.props; // a branch of an object with named properties is part of it
  /** @type {Record<string, any>} */
  const out = { ...s };
  /** @param {any} x */
  const each = (x) => translate(x, false, ctx, depth + 1);
  for (const k of ['properties', '$defs', 'definitions']) if (isObject(s[k])) out[k] = Object.fromEntries(Object.entries(s[k]).map(([n, x]) => [n, each(x)]));
  for (const k of ['additionalProperties', 'items']) if (isObject(s[k])) out[k] = each(s[k]);
  for (const k of ['items', 'prefixItems']) if (Array.isArray(s[k])) out[k] = s[k].map(each);
  for (const k of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(s[k])) out[k] = s[k].map((x) => translate(x, inner, ctx, depth + 1));
  return out;
}

/**
 * A call's arguments as the tool takes them: each free-form object Gemini gave as JSON text, as the object when the
 * text is one. Text in a place that takes text stays text. Arguments that weren't JSON (kept as text) stay as they are.
 * @param {unknown} schema the tool's own input schema @param {unknown} args
 */
export function fromGemini(schema, args) {
  return walk(schema, args, {
    text: (mark, v) => {
      if (mark !== 'object' || typeof v !== 'string') return v;
      return parsed(v);
    },
    options: (s, v, options) => {
      if (typeof v !== 'string' || typesOf(s).includes('string')) return undefined;
      const parse = options.some((o) => made.get(o) === 'object') && !options.some((o) => !made.has(o) && typesOf(o).includes('string'));
      return parse ? parsed(v) : undefined;
    },
  });
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
 * A call's arguments as Gemini fills them, for a call that goes back to it: each free-form object as its JSON text.
 * fromGemini takes them back to what they were.
 * @param {unknown} schema the tool's own input schema @param {unknown} input
 */
export function toGeminiArgs(schema, input) {
  return walk(schema, input, {
    text: (_mark, v) => (isObject(v) ? JSON.stringify(v) : v),
    options: (_s, v, options) => {
      if (!isObject(v) || !options.some((o) => made.has(o))) return undefined;
      return options.some((o) => !made.has(o) && (typesOf(o).includes('object') || isObject(o.properties))) ? undefined : JSON.stringify(v);
    },
  });
}

/**
 * The value walked alongside the schema Gemini was sent: at a text schema made from an object, at.text gives the value;
 * at an anyOf or oneOf, at.options may (undefined: walk on into it). Nothing is changed in place, and a walk that runs
 * out gives the value back as it came.
 * @param {unknown} schema the tool's own input schema @param {unknown} value
 * @param {{ text: (mark: 'object' | 'union', v: any) => any, options: (s: Record<string, any>, v: any, options: Record<string, any>[]) => any }} at
 */
function walk(schema, value, at) {
  const { tree, ok } = plan(schema);
  if (!ok) return value;
  const ctx = { left: BUDGET, root: tree };
  /** Schemas being walked, each for the values it is being walked for. @type {Map<object, Set<unknown>>} */
  const on = new Map();
  /** A $ref followed, a few in a row at most. @param {any} o */
  const follow = (o) => {
    for (let i = 0; i < 8 && isObject(o) && typeof o.$ref === 'string' && !made.has(o); i++) o = lookUp(tree, o.$ref) ?? o;
    return o;
  };
  /** @param {any} s @param {any} v @param {number} depth @returns {any} */
  const visit = (s, v, depth) => {
    step(ctx, depth);
    if (!isObject(s)) return v;
    const mark = made.get(s);
    if (mark) return at.text(mark, v);
    let walking = on.get(s);
    if (walking?.has(v)) return v;
    if (!walking) on.set(s, (walking = new Set()));
    walking.add(v);
    try {
      const options = [...list(s.anyOf), ...list(s.oneOf)].map(follow).filter(isObject);
      const done = options.length ? at.options(s, v, options) : undefined;
      if (done !== undefined) return done;
      let out = v;
      for (const part of [...list(s.allOf), ...(typeof s.$ref === 'string' ? [lookUp(tree, s.$ref)] : [])]) out = visit(part, out, depth + 1);
      const option = Array.isArray(out) ? options.find((o) => !made.has(o) && (o.items !== undefined || Array.isArray(o.prefixItems) || typesOf(o).includes('array')))
        : isObject(out) ? options.find((o) => !made.has(o) && (typesOf(o).includes('object') || isObject(o.properties))) : undefined;
      if (option) out = visit(option, out, depth + 1);
      if (Array.isArray(out) && (s.items !== undefined || Array.isArray(s.prefixItems))) {
        const first = Array.isArray(s.prefixItems) ? s.prefixItems : list(s.items);
        const rest = isObject(s.items) ? s.items : undefined;
        out = out.map((x, i) => {
          const sub = first[i] ?? rest;
          return sub ? visit(sub, x, depth + 1) : x;
        });
      } else if (isObject(out) && (isObject(s.properties) || isObject(s.additionalProperties))) {
        // patternProperties are never run: a key they'd match is walked as additionalProperties says, if at all.
        /** @type {Record<string, any>} */
        const next = {};
        for (const [k, x] of Object.entries(out)) {
          const sub = isObject(s.properties) && Object.hasOwn(s.properties, k) ? s.properties[k] : isObject(s.additionalProperties) ? s.additionalProperties : undefined;
          put(next, k, sub ? visit(sub, x, depth + 1) : x);
        }
        out = next;
      }
      return out;
    } finally {
      walking.delete(v);
    }
  };
  try {
    return visit(tree, value, 0);
  } catch (e) {
    if (!spent(e)) throw e;
    return value;
  }
}
