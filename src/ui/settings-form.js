import { h, field } from './dom.js';
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
    if (p?.type === 'string' && p.writeOnly === true) return { ...base, kind: /** @type {const} */ ('secret') };
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
 * The form on a plugin's page: what is saved now, Save, and what is wrong under it.
 * @param {any} ctx @param {string} pluginId @param {any} schema @returns {Promise<HTMLElement>}
 */
export async function settingsForm(ctx, pluginId, schema) {
  const path = `/plugin-settings/${pluginId}.json`;
  const saved = (await ctx.ws.readJSON(SYS_SETTINGS, path).catch(() => null)) ?? {};
  const fields = formFields(schema);
  /** @type {Map<string, HTMLInputElement | HTMLSelectElement>} */
  const inputs = new Map();
  const rows = [];
  for (const f of fields) {
    const id = `setting-${pluginId}-${f.key}`;
    const now = saved[f.key] ?? f.default;
    /** @type {any} */
    let input;
    if (f.kind === 'unsupported') {
      rows.push(h('p', { class: 'sub', text: `${f.label}: annai can't show this setting.` }));
      continue;
    }
    if (f.kind === 'boolean') {
      input = h('input', { id, type: 'checkbox' });
      input.checked = Boolean(now);
      inputs.set(f.key, input);
      rows.push(h('label', { class: 'check' }, input, h('span', { text: f.label })), f.hint ? h('p', { class: 'sub', text: f.hint }) : null);
      continue;
    }
    if (f.kind === 'select') {
      input = h('select', { id }, h('option', { value: '', text: '—' }), ...(f.options ?? []).map((o) => h('option', { value: o, text: o })));
      input.value = now === undefined || now === null ? '' : String(now);
    } else if (f.kind === 'secret') {
      const has = await ctx.store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret(`plugin:${pluginId}:${f.key}`)).catch(() => undefined);
      input = h('input', { id, type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: has === undefined ? '' : 'saved' });
    } else {
      input = h('input', {
        id, type: f.kind === 'text' ? 'text' : 'number', autocomplete: 'off', value: now === undefined || now === null ? '' : String(now),
        ...(f.kind === 'integer' ? { step: '1' } : {}), ...(f.min !== undefined ? { min: String(f.min) } : {}), ...(f.max !== undefined ? { max: String(f.max) } : {}),
      });
    }
    inputs.set(f.key, input);
    rows.push(field(f.label, input), f.hint ? h('p', { class: 'sub', text: f.hint }) : null);
  }
  if (!inputs.size) return h('div', {}, ...rows);
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      /** @type {Record<string, string | boolean>} */
      const raw = {};
      for (const [key, input] of inputs) raw[key] = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value;
      const { values, secrets, errors } = readForm(schema, raw);
      error.hidden = !errors.length;
      error.textContent = errors.join(' ');
      if (errors.length) return;
      await ctx.ws.patch(SYS_SETTINGS, path, values, { author: 'user', create: true });
      await ctx.store.tx(['secrets'], 'readwrite', async (/** @type {any} */ t) => {
        for (const [key, value] of Object.entries(secrets)) await t.putSecret(`plugin:${pluginId}:${key}`, value);
      });
      ctx.notices.toast('Saved.');
      ctx.render();
    },
  }, 'Save');
  return h('div', { class: 'settings-form' }, ...rows, error, h('div', { class: 'acts' }, save));
}
