import { h, field, twoStep, jsonField, messageOf, savedField, savedCheck, autosave, queueSave } from '../dom.js';
import { endpointOf, endpointBase, modelOf, newModel, saveEndpoint, saveModel, setKey, removeEndpoint, diffLayer } from '../../core/llm/config.js';
import { templateUpdates, applyTemplate, addListedModel, useSuggestion } from '../../core/llm/templates.js';
import { testPanel } from '../model-check.js';
import { speechTestPanel } from '../speech-check.js';

export { messageOf };

/** @param {string} text */
function gone(text) {
  return h('div', { class: 'screen' }, h('h1', { class: 'title', text }), h('p', {}, h('a', { href: '#/models' }, 'Back to Models')));
}

/** A model's prices in a line: tokens, minutes of speech, or characters. @param {import('../../core/llm/cost.js').Prices | null} prices */
export function priceLine(prices) {
  if (!prices) return null;
  if (typeof prices.perMinute === 'number') return `$${prices.perMinute} a minute of speech`;
  if (typeof prices.perMillionChars === 'number') return `$${prices.perMillionChars} per million characters`;
  if (!prices.input && !prices.output) return 'free';
  return `$${prices.input ?? '?'} in, $${prices.output ?? '?'} out per million tokens`;
}

/**
 * One endpoint: how annai talks to a server (spec §9.2), and its models.
 * @param {any} ctx @param {string} id
 */
export async function renderEndpoint(ctx, id) {
  await ctx.llm.ready;
  const [cfg, catalog] = await Promise.all([ctx.llm.config(), ctx.llm.templates()]);
  const rec = cfg.endpoints[id];
  if (!rec) return gone('This endpoint no longer exists');
  const type = ctx.llm.types().get(rec.type);
  const e = endpointOf(rec, type?.tunables);
  const base = endpointBase(rec, type?.tunables);
  const hasKey = Boolean(await ctx.llm.keyFor(id));
  const update = templateUpdates(cfg, catalog).find((u) => u.endpoint === id);
  const from = rec.template ? catalog.endpoints.find((t) => t.id === rec.template?.id) : undefined;
  const status = h('p', { class: 'sub', role: 'status' });
  const title = h('h1', { class: 'title', text: e.name });
  /**
   * Saves fields into the user's layer of the endpoint as it is now (a function works a value out
   * from it), and puts its models back in use: what failed may be fixed. Gives the endpoint.
   * @param {Record<string, any>} fields
   */
  const saveFields = async (fields) => {
    const now = (await ctx.llm.config()).endpoints[id];
    if (!now) throw new Error('This endpoint no longer exists.');
    const was = endpointOf(now, type?.tunables);
    const values = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'function' ? v(was) : v]));
    const user = { ...now.user };
    for (const k of Object.keys(values)) delete /** @type {any} */ (user)[k];
    const next = { ...now, user: { ...user, ...diffLayer(values, endpointBase(now, type?.tunables)) } };
    await saveEndpoint(ctx.ws, next);
    await ctx.llm.unbench(id);
    return endpointOf(next, type?.tunables);
  };
  const name = h('input', { id: 'endpoint-name', autocomplete: 'off', value: e.name });
  const url = h('input', { id: 'endpoint-url', autocomplete: 'off', autocapitalize: 'off', inputmode: 'url', value: e.baseUrl, placeholder: 'https://…' });
  const key = h('input', { id: 'endpoint-key', type: 'password', autocomplete: 'off', placeholder: hasKey ? 'saved (type a new one to replace it)' : 'not set' });
  const headers = jsonField('Extra headers (JSON)', 'endpoint-headers', e.headers);
  const tunables = jsonField('Tunables (JSON)', 'endpoint-tunables', e.tunables);
  const extra = jsonField('Extra request fields (JSON)', 'endpoint-extra', e.extraBody);
  // Where the endpoint type stores files, photos go there once, then by id (spec §4.8). The switch is a tunable.
  const uploads = type?.uploadRequest ? savedCheck('Upload photos to this provider (each expires after 48 hours)', e.tunables?.uploads !== false,
    async (on) => tunables.show((await saveFields({ tunables: (/** @type {any} */ was) => ({ ...was.tunables, uploads: on }) })).tunables)) : null;
  // The address, key and extra headers (often a credential too) are saved together with a button, so a half-typed connection is never used.
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: () => queueSave(async () => {
      try {
        await saveFields({ baseUrl: url.value.trim(), headers: headers.read() });
        if (key.value.trim()) await setKey(ctx.store, id, key.value.trim());
        ctx.notices.toast('Saved');
        if (title.isConnected) ctx.render();
      } catch (err) {
        status.textContent = messageOf(err);
      }
    }),
  }, 'Save');
  const models = Object.values(cfg.models).filter((m) => m.endpoint === id).map(modelOf);
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/models' }, '← Models')),
    title,
    h('p', { class: 'sub', text: [type?.name ?? rec.type, rec.template ? `from annai's ${rec.template.values.name ?? rec.template.id} template` : null].filter(Boolean).join(' · ') }),
    type ? null : installPanel(ctx, rec.type),
    update ? updatePanel(ctx, id, update.template) : null,
    h('section', { class: 'panel', 'aria-label': 'Endpoint' },
      savedField('Name', name, () => name.value.trim() || base.name, async (v) => { title.textContent = (await saveFields({ name: v })).name; }),
      h('h3', { text: 'Connection' }),
      field('Base URL', url), field('API key', key),
      from?.note || from?.keyUrl
        ? h('p', { class: 'sub' }, from.note ?? '', from.note && from.keyUrl ? ' ' : '', from.keyUrl ? h('a', { href: from.keyUrl, target: '_blank', rel: 'noopener' }, 'Get a key') : null)
        : null,
      headers.el,
      h('div', { class: 'acts' }, save,
        hasKey ? h('button', { class: 'btn', type: 'button', onclick: async () => { await setKey(ctx.store, id, null); await ctx.llm.unbench(id); ctx.notices.toast('Key removed'); ctx.render(); } }, 'Remove key') : null),
      status,
      h('h3', { text: 'How annai asks it' }),
      h('p', { class: 'sub', text: 'These are saved as you change them.' }),
      uploads?.el ?? null,
      h('div', { class: 'saving' }, tunables.el, ...autosave(tunables.area, tunables.read, async (t) => {
        tunables.show((await saveFields({ tunables: uploads ? { ...t, uploads: uploads.input.checked } : t })).tunables);
      })),
      h('div', { class: 'saving' }, extra.el, ...autosave(extra.area, extra.read, async (x) => extra.show((await saveFields({ extraBody: x })).extraBody)))),
    from?.roles ? suggestionsPanel(ctx, id, from) : null,
    modelsSection(ctx, id, models),
    models[0] && type?.speech ? speechTestPanel(ctx, models[0], type.speech, cfg.models[models[0].id].verified, `Test ${models[0].name}`) : null,
    models[0] && !type?.speech ? testPanel(ctx, models[0].id, cfg.models[models[0].id].verified, `Test ${models[0].name}`) : null,
    h('div', { class: 'acts' }, twoStep('Remove endpoint', 'Tap again to remove it', async () => {
      await removeEndpoint(ctx.ws, ctx.store, id);
      ctx.go('#/models');
    })));
}

/** @param {any} ctx @param {string} typeId */
function installPanel(ctx, typeId) {
  const status = h('p', { class: 'sub', role: 'status', text: `This endpoint needs the plugin for "${typeId}", which isn't running.` });
  const btn = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      btn.disabled = true;
      status.textContent = 'Installing…';
      try {
        await ctx.llm.ensureType(typeId);
        ctx.render();
      } catch (e) {
        status.textContent = messageOf(e);
        btn.disabled = false;
      }
    },
  }, 'Install it');
  return h('section', { class: 'panel', 'aria-label': 'Plugin' }, status, h('div', { class: 'acts' }, btn));
}

/** @param {any} ctx @param {string} id @param {import('../../core/llm/templates.js').EndpointTemplate} tpl */
function updatePanel(ctx, id, tpl) {
  return h('section', { class: 'panel', 'aria-label': 'Template update' },
    h('p', { text: `annai's ${tpl.name} template has changed. Applying it keeps your own changes.` }),
    h('div', { class: 'acts' }, h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        await applyTemplate(ctx, id, tpl);
        ctx.notices.toast('Template applied');
        ctx.render();
      },
    }, 'Apply update')));
}

/** @param {any} ctx @param {string} endpointId @param {import('../../core/llm/config.js').Model[]} models */
function modelsSection(ctx, endpointId, models) {
  const status = h('p', { class: 'sub', role: 'status' });
  const listSlot = h('div', {});
  const providerId = h('input', { id: 'model-id', autocomplete: 'off', autocapitalize: 'off', placeholder: "the provider's model id" });
  const add = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const value = providerId.value.trim();
      if (!value) return;
      try {
        await saveModel(ctx.ws, newModel(endpointId, { user: { providerId: value } }));
        ctx.render();
      } catch (e) {
        status.textContent = messageOf(e);
      }
    },
  }, 'Add model');
  const fetchList = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      fetchList.disabled = true;
      status.textContent = 'Asking the endpoint for its models…';
      try {
        const listed = await ctx.llm.listModels(endpointId);
        status.textContent = `${listed.length} model${listed.length === 1 ? '' : 's'}.`;
        listSlot.replaceChildren(listedModels(ctx, endpointId, listed, models));
      } catch (e) {
        status.textContent = messageOf(e);
      } finally {
        fetchList.disabled = false;
      }
    },
  }, 'Fetch model list');
  const rows = models.map((m) => h('li', {}, h('a', { class: 'card', href: `#/models/model?id=${encodeURIComponent(m.id)}` },
    h('span', { class: 'name', text: m.name }),
    h('span', { class: 'sub', text: [m.providerId !== m.name ? m.providerId : null, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : null, priceLine(m.prices)].filter(Boolean).join(' · ') }))));
  return h('section', { class: 'panel', 'aria-label': 'Models' },
    h('h2', { class: 'section', text: 'Models' }),
    rows.length ? h('ul', { class: 'cards' }, ...rows) : h('p', { class: 'empty', text: 'No models yet.' }),
    h('div', { class: 'row' }, field('Add a model by id', providerId), h('div', { class: 'acts' }, add, fetchList)),
    status,
    listSlot);
}

/**
 * The models an endpoint listed, minus those already added, with a filter.
 * @param {any} ctx @param {string} endpointId @param {import('../../core/llm/contract.js').ListedModel[]} listed @param {import('../../core/llm/config.js').Model[]} have
 */
function listedModels(ctx, endpointId, listed, have) {
  const owned = new Set(have.map((m) => m.providerId));
  const filter = h('input', { id: 'model-filter', autocomplete: 'off', placeholder: 'for example: haiku' });
  const list = h('ul', { class: 'listed' });
  const show = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = listed.filter((m) => !owned.has(m.providerId) && (!q || `${m.providerId} ${m.name ?? ''}`.toLowerCase().includes(q))).slice(0, 50);
    list.replaceChildren(...rows.map((m) => h('li', { class: 'acts' },
      h('span', { text: m.name && m.name !== m.providerId ? `${m.name} (${m.providerId})` : m.providerId }),
      h('button', {
        class: 'btn', type: 'button', 'aria-label': `Add ${m.providerId}`,
        onclick: async () => {
          await addListedModel(ctx, endpointId, m);
          ctx.render();
        },
      }, 'Add'))));
  };
  filter.addEventListener('input', show);
  show();
  return h('div', {}, field('Filter the list', filter), list);
}

/** Buttons that put a template's suggested models in the roles ("free", "recommended"). @param {any} ctx @param {string} id @param {import('../../core/llm/templates.js').EndpointTemplate} tpl */
function suggestionsPanel(ctx, id, tpl) {
  /** @type {Record<string, string>} */
  const labels = { free: 'Use the free models', recommended: 'Use the recommended models' };
  return h('section', { class: 'panel', 'aria-label': 'Suggested models' },
    h('p', { class: 'sub', text: `annai's ${tpl.name} template suggests a model for each role.` }),
    h('div', { class: 'acts' }, ...Object.keys(tpl.roles ?? {}).map((which) => h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        await useSuggestion(ctx, id, tpl, which);
        ctx.notices.toast('Roles updated');
        ctx.render();
      },
    }, labels[which] ?? `Use the ${which} models`))));
}
