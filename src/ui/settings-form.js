import { h, t, field, savedField, savedCheck, savingNote, otherLang, messageOf } from './dom.js';
import { numField, parseNum } from './format.js';
import { validate } from '../core/schema.js';
import { SYS_SETTINGS } from '../core/scopes.js';

/**
 * The keypad a number field asks for: digits only when nothing below zero is allowed, since the iPhone's digit keypads have no minus;
 * otherwise the plain keyboard (the schema's range is checked on saving). @param {{ kind: string, min?: number, max?: number }} f @returns {'numeric' | 'decimal' | undefined}
 */
export const keypad = (f) => ((f.kind === 'number' || f.kind === 'integer') && typeof f.min === 'number' && f.min >= 0 ? (f.kind === 'integer' ? 'numeric' : 'decimal') : undefined);

/**
 * A plugin's settings form, from the JSON Schema in its manifest (spec §5.2: "a JSON Schema, from
 * which we render a settings form automatically"; milestone 8b choice 12). Values go where
 * annai.settings.get() reads them; writeOnly ones go to the plugin's secrets, never into files.
 * @typedef {{ key: string, kind: 'text' | 'select' | 'secret' | 'number' | 'integer' | 'boolean' | 'unsupported', label: string,
 *   hint?: string, options?: [string, string][], min?: number, max?: number, default?: any }} Field
 *   options: [value, words]: a oneOf's consts with their titles (localization design, section 8), or an enum's values
 */

/** The fields a settings schema asks for, one per top-level property. @param {any} schema @returns {Field[]} */
export function formFields(schema) {
  const props = schema?.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
  return Object.entries(props).map(([key, p]) => {
    const base = {
      key, label: typeof p?.title === 'string' && p.title.trim() ? p.title : key,
      ...(typeof p?.description === 'string' && p.description ? { hint: p.description } : {}),
      ...(p?.default !== undefined ? { default: p.default } : {}),
    };
    // A writeOnly field is a secret when it is a string; annai keeps no other kind of secret, and never
    // puts one into a file (fix pass 8b-5).
    if (p?.writeOnly) return { ...base, kind: /** @type {'secret' | 'unsupported'} */ (p.type === 'string' ? 'secret' : 'unsupported') };
    /** @type {any[] | null} */
    const choices = p?.type !== 'string' ? null : Array.isArray(p.oneOf) && p.oneOf.every((/** @type {any} */ o) => o && 'const' in o) ? p.oneOf
      : Array.isArray(p.enum) ? p.enum.map((/** @type {unknown} */ v) => ({ const: v })) : null;
    if (choices) return { ...base, kind: /** @type {const} */ ('select'), options: choices.map((o) => /** @type {[string, string]} */ ([String(o?.const), String(o?.title || o?.const)])) };
    if (p?.type === 'string') return { ...base, kind: /** @type {const} */ ('text') };
    if (p?.type === 'number' || p?.type === 'integer') {
      return { ...base, kind: /** @type {'number' | 'integer'} */ (p.type), ...(typeof p.minimum === 'number' ? { min: p.minimum } : {}), ...(typeof p.maximum === 'number' ? { max: p.maximum } : {}) };
    }
    if (p?.type === 'boolean') return { ...base, kind: /** @type {const} */ ('boolean') };
    return { ...base, kind: /** @type {const} */ ('unsupported') };
  });
}

/**
 * What the form holds, read and checked: values (null clears one), secrets apart (an empty secret
 * field leaves the saved one), and what is wrong: annai's plain words for a number that isn't one, else the schema's refusals,
 * in its English (schema: true).
 * @param {any} schema @param {Record<string, string | boolean>} raw
 * @returns {{ values: Record<string, any>, secrets: Record<string, string>, errors: string[], schema?: boolean }}
 */
export function readForm(schema, raw) {
  /** @type {Record<string, any>} */
  const values = {};
  /** @type {Record<string, string>} */
  const secrets = {};
  /** @type {string[]} */
  const errors = [];
  for (const f of formFields(schema)) {
    const v = raw[f.key];
    if (f.kind === 'unsupported') continue;
    if (f.kind === 'secret') {
      if (typeof v === 'string' && v !== '') secrets[f.key] = v;
      continue;
    }
    if (f.kind === 'boolean') {
      values[f.key] = Boolean(v);
      continue;
    }
    const text = String(v ?? '').trim();
    if (f.kind === 'number' || f.kind === 'integer') {
      if (!text) {
        values[f.key] = null;
        continue;
      }
      const n = parseNum(text);
      if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) {
        errors.push(f.kind === 'integer' ? t`${f.label} is a whole number.` : t`${f.label} is a number.`);
        continue;
      }
      values[f.key] = n;
      continue;
    }
    values[f.key] = text === '' ? null : String(v);
  }
  // Checked against the schema without its secrets, and without required: an empty field is allowed.
  const { required: _r, ...rest } = schema ?? {};
  const properties = Object.fromEntries(Object.entries(rest.properties ?? {}).filter(([, p]) => !(/** @type {any} */ (p)?.writeOnly)));
  const set = Object.fromEntries(Object.entries(values).filter(([, x]) => x !== null));
  if (errors.length) return { values, secrets, errors };
  const refused = validate({ ...rest, properties }, set);
  return { values, secrets, errors: refused, ...(refused.length ? { schema: true } : {}) };
}

/**
 * The form on a plugin's page, with what is saved now. Each plain field saves as it changes, alone,
 * once it is valid (spec §16.1); a secret has a Save button of its own, and is never shown again. Its words are the plugin's, marked
 * with their language (o.lang) when it isn't the screens'.
 * @param {any} ctx @param {string} pluginId @param {any} schema @param {{ lang?: string }} [o] @returns {Promise<HTMLElement>}
 */
export async function settingsForm(ctx, pluginId, schema, o = {}) {
  const lang = otherLang(o.lang);
  /** @param {HTMLElement} el */
  const mark = (el) => {
    if (lang) for (const x of el.querySelectorAll('.field-label, .check > span')) x.setAttribute('lang', lang);
    return el;
  };
  const path = /* en */ `/plugin-settings/${pluginId}.json`;
  const saved = (await ctx.ws.readJSON(SYS_SETTINGS, path).catch(() => null)) ?? {};
  const rows = [];
  for (const f of formFields(schema)) {
    const id = `setting-${pluginId}-${f.key}`;
    const now = saved[f.key] ?? f.default;
    const hint = f.hint ? h('p', { class: 'sub', text: f.hint, lang }) : null;
    if (f.kind === 'unsupported') {
      rows.push(h('p', { class: 'sub', text: t`${f.label}: annai can't show this setting.` }));
      continue;
    }
    if (f.kind === 'secret') {
      const has = await ctx.store.tx(['secrets'], 'readonly', (/** @type {any} */ tx) => tx.getSecret(`plugin:${pluginId}:${f.key}`)).catch(() => undefined);
      const input = h('input', { id, type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: has === undefined ? '' : t`saved` });
      const note = h('span', { class: 'sub', role: 'status' });
      const error = h('p', { class: 'error', role: 'alert', hidden: true });
      const save = h('button', {
        class: 'btn', type: 'button',
        onclick: () => input.value && savingNote(note, async () => {
          try {
            await ctx.store.tx(['secrets'], 'readwrite', (/** @type {any} */ tx) => tx.putSecret(`plugin:${pluginId}:${f.key}`, input.value));
          } catch (e) {
            error.textContent = t`${f.label} wasn't saved: ${messageOf(e)}`;
            error.hidden = false;
            return;
          }
          error.hidden = true;
          input.value = '';
          input.placeholder = t`saved`;
          note.textContent = t`Saved`;
        }),
      }, t`Save`);
      rows.push(mark(field(f.label, input)), hint, h('div', { class: 'acts' }, save, note), error);
      continue;
    }
    // One field's own schema: an empty field is allowed, and clears it.
    const one = { type: 'object', properties: { [f.key]: schema.properties[f.key] } };
    /** @param {string | boolean} raw */
    const value = (raw) => {
      const { values, errors, schema: refused } = readForm(one, { [f.key]: raw });
      // A schema's refusal is shown in its English, marked so (showError, decision 11).
      if (errors.length) throw Object.assign(new Error(errors.join(' ')), refused ? { errors } : {});
      return values[f.key];
    };
    /** @param {any} v */
    const write = (v) => ctx.ws.patch(SYS_SETTINGS, path, { [f.key]: v }, { author: 'user', create: true });
    if (f.kind === 'boolean') {
      const c = savedCheck(f.label, Boolean(now), (on) => write(value(on)));
      c.input.id = id;
      rows.push(mark(c.el), hint);
      continue;
    }
    /** @type {any} */
    let input;
    if (f.kind === 'select') {
      input = h('select', { id }, h('option', { value: '', text: '—' }), ...(f.options ?? []).map(([v, words]) => h('option', { value: v, text: words, lang })));
      input.value = now === undefined || now === null ? '' : String(now);
    } else {
      input = h('input', {
        id, autocomplete: 'off', value: now === undefined || now === null ? '' : typeof now === 'number' ? numField(now) : String(now),
        ...(keypad(f) ? { inputmode: keypad(f) } : {}),
      });
    }
    rows.push(mark(savedField(f.label, input, () => {
      return value(input.value);
    }, write)), hint);
  }
  return h('div', { class: 'settings-form' }, ...rows);
}
