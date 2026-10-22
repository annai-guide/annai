import { h, field, savedField, savedCheck, savingNote, messageOf } from './dom.js';
import { validate } from '../core/schema.js';
import { SYS_SETTINGS } from '../core/scopes.js';

/**
 * A plugin's settings form, from the JSON Schema in its manifest (spec §5.2: "a JSON Schema, from
 * which we render a settings form automatically"; milestone 8b choice 12). Values go where
 * annai.settings.get() reads them; writeOnly ones go to the plugin's secrets, never into files.
 * @typedef {{ key: string, kind: 'text' | 'select' | 'secret' | 'number' | 'integer' | 'boolean' | 'unsupported', label: string,
 *   hint?: string, options?: string[], min?: number, max?: number, default?: any }} Field
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
    if (p?.type === 'string' && Array.isArray(p.enum)) return { ...base, kind: /** @type {const} */ ('select'), options: p.enum.map(String) };
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
 * field leaves the saved one), and what is wrong, in plain words.
 * @param {any} schema @param {Record<string, string | boolean>} raw
 * @returns {{ values: Record<string, any>, secrets: Record<string, string>, errors: string[] }}
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
    const t = String(v ?? '').trim();
    if (f.kind === 'number' || f.kind === 'integer') {
      if (!t) {
        values[f.key] = null;
        continue;
      }
      const n = Number(t);
      if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) {
        errors.push(`${f.label} is ${f.kind === 'integer' ? 'a whole number' : 'a number'}.`);
        continue;
      }
      values[f.key] = n;
      continue;
    }
    values[f.key] = t === '' ? null : String(v);
  }
  // Checked against the schema without its secrets, and without required: an empty field is allowed.
  const { required: _r, ...rest } = schema ?? {};
  const properties = Object.fromEntries(Object.entries(rest.properties ?? {}).filter(([, p]) => !(/** @type {any} */ (p)?.writeOnly)));
  const set = Object.fromEntries(Object.entries(values).filter(([, x]) => x !== null));
  if (!errors.length) errors.push(...validate({ ...rest, properties }, set));
  return { values, secrets, errors };
}

/**
 * The form on a plugin's page, with what is saved now. Each plain field saves as it changes, alone,
 * once it is valid (spec §16.1); a secret has a Save button of its own, and is never shown again.
 * @param {any} ctx @param {string} pluginId @param {any} schema @returns {Promise<HTMLElement>}
 */
export async function settingsForm(ctx, pluginId, schema) {
  const path = `/plugin-settings/${pluginId}.json`;
  const saved = (await ctx.ws.readJSON(SYS_SETTINGS, path).catch(() => null)) ?? {};
  const rows = [];
  for (const f of formFields(schema)) {
    const id = `setting-${pluginId}-${f.key}`;
    const now = saved[f.key] ?? f.default;
    const hint = f.hint ? h('p', { class: 'sub', text: f.hint }) : null;
    if (f.kind === 'unsupported') {
      rows.push(h('p', { class: 'sub', text: `${f.label}: annai can't show this setting.` }));
      continue;
    }
    if (f.kind === 'secret') {
      const has = await ctx.store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret(`plugin:${pluginId}:${f.key}`)).catch(() => undefined);
      const input = h('input', { id, type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: has === undefined ? '' : 'saved' });
      const note = h('span', { class: 'sub', role: 'status' });
      const error = h('p', { class: 'error', role: 'alert', hidden: true });
      const save = h('button', {
        class: 'btn', type: 'button',
        onclick: () => input.value && savingNote(note, async () => {
          try {
            await ctx.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.putSecret(`plugin:${pluginId}:${f.key}`, input.value));
          } catch (e) {
            error.textContent = `${f.label} wasn't saved: ${messageOf(e)}`;
            error.hidden = false;
            return;
          }
          error.hidden = true;
          input.value = '';
          input.placeholder = 'saved';
          note.textContent = 'Saved';
        }),
      }, 'Save');
      rows.push(field(f.label, input), hint, h('div', { class: 'acts' }, save, note), error);
      continue;
    }
    // One field's own schema: an empty field is allowed, and clears it.
    const one = { type: 'object', properties: { [f.key]: schema.properties[f.key] } };
    /** @param {string | boolean} raw */
    const value = (raw) => {
      const { values, errors } = readForm(one, { [f.key]: raw });
      if (errors.length) throw new Error(errors.join(' '));
      return values[f.key];
    };
    /** @param {any} v */
    const write = (v) => ctx.ws.patch(SYS_SETTINGS, path, { [f.key]: v }, { author: 'user', create: true });
    if (f.kind === 'boolean') {
      const c = savedCheck(f.label, Boolean(now), (on) => write(value(on)));
      c.input.id = id;
      rows.push(c.el, hint);
      continue;
    }
    /** @type {any} */
    let input;
    if (f.kind === 'select') {
      input = h('select', { id }, h('option', { value: '', text: '—' }), ...(f.options ?? []).map((o) => h('option', { value: o, text: o })));
      input.value = now === undefined || now === null ? '' : String(now);
    } else {
      input = h('input', {
        id, type: f.kind === 'text' ? 'text' : 'number', autocomplete: 'off', value: now === undefined || now === null ? '' : String(now),
        ...(f.kind === 'integer' ? { step: '1' } : {}), ...(f.min !== undefined ? { min: String(f.min) } : {}), ...(f.max !== undefined ? { max: String(f.max) } : {}),
      });
    }
    rows.push(savedField(f.label, input, () => {
      if (input.validity?.badInput) throw new Error(`${f.label} is ${f.kind === 'integer' ? 'a whole number' : 'a number'}.`);
      return value(input.value);
    }, write), hint);
  }
  return h('div', { class: 'settings-form' }, ...rows);
}
