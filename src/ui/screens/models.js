import { h, field } from '../dom.js';
import { endpointOf, modelOf, saveRoles, CHAT_ROLES, SPEECH_ROLES, STAND_INS, speechKind } from '../../core/llm/config.js';
import { LEVELS } from '../../core/llm/reasoning.js';
import { addFromTemplate, templateUpdates, speechAdd } from '../../core/llm/templates.js';
import { renderEndpoint, messageOf } from './endpoint.js';
import { renderModel } from './model.js';
import { talkPanel } from '../talk-panel.js';
import { needsCode, signInUrl, exchange, connectOpenRouter } from '../openrouter.js';

/** @type {Record<string, string>} */
const ROLE_NAMES = {
  main: 'Main: talks with you', utility: 'Utility: summaries and small jobs', decide: 'Quick decision: yes-or-no checks',
  'speech-in': 'Speech in: how Shiori hears you', 'speech-out': "Speech out: Shiori's voice",
};
/** What each stand-in entry is (spec §10.1, §10.3). @type {Record<string, string>} */
/** Short notes on the stand-ins; Settings → Voice says where each sends your voice (spec §11.7). */
const STAND_IN_NOTES = { 'send-audio': 'when the model takes audio', dictation: "the phone's own; usually goes to Google or Apple", 'browser-voice': "the browser's own; some voices go online" };

/**
 * Settings → Models (spec §9.2, §9.6, §9.8): the endpoints annai calls, their models, and which
 * models each role tries, in order.
 * @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderModels(ctx, route) {
  if (route.parts[1] === 'endpoint') return renderEndpoint(ctx, route.params.id ?? '');
  if (route.parts[1] === 'model') return renderModel(ctx, route.params.id ?? '');
  await ctx.llm.ready;
  const [cfg, catalog] = await Promise.all([ctx.llm.config(), ctx.llm.templates()]);
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Models' }),
    h('p', { class: 'sub', text: 'Where Shiori thinks: the endpoints annai calls, their models, and which models each role tries, in order.' }),
    signInSection(ctx, cfg),
    endpointsSection(ctx, cfg, catalog),
    rolesSection(ctx, cfg),
    talkPanel(ctx));
}

/** @param {any} ctx @param {import('../../core/llm/config.js').ModelConfig} cfg @param {import('../../core/llm/templates.js').TemplateCatalog} catalog */
function endpointsSection(ctx, cfg, catalog) {
  const types = ctx.llm.types();
  const updates = new Set(templateUpdates(cfg, catalog).map((u) => u.endpoint));
  const rows = Object.values(cfg.endpoints).sort((a, b) => a.created - b.created).map((rec) => {
    const e = endpointOf(rec, types.get(rec.type)?.tunables);
    const n = Object.values(cfg.models).filter((m) => m.endpoint === rec.id).length;
    const sub = [types.get(rec.type)?.name ?? rec.type, `${n} model${n === 1 ? '' : 's'}`, updates.has(rec.id) ? 'template update available' : null];
    return h('li', {}, h('a', { class: 'card', href: `#/models/endpoint?id=${encodeURIComponent(rec.id)}` },
      h('span', { class: 'name', text: e.name }),
      h('span', { class: 'sub', text: sub.filter(Boolean).join(' · ') })));
  });
  const status = h('p', { class: 'sub', role: 'status' });
  const pick = h('select', { id: 'endpoint-template' }, ...catalog.endpoints.map((t) => h('option', { value: t.id, text: t.from ? `${t.name} (from ${t.from})` : t.name })));
  const add = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      const tpl = catalog.endpoints.find((t) => t.id === pick.value);
      if (!tpl) return;
      add.disabled = true;
      try {
        if (!types.has(tpl.type)) status.textContent = 'Installing the plugin for this endpoint…';
        await ctx.llm.ensureType(tpl.type);
        const id = await addFromTemplate(ctx, tpl, { roles: 'recommended' });
        ctx.go(`#/models/endpoint?id=${encodeURIComponent(id)}`);
      } catch (e) {
        status.textContent = messageOf(e);
      } finally {
        add.disabled = false;
      }
    },
  }, 'Add');
  return h('section', { class: 'panel', 'aria-label': 'Endpoints' },
    h('h2', { class: 'section', text: 'Endpoints' }),
    rows.length ? h('ul', { class: 'cards' }, ...rows) : h('p', { class: 'empty', text: 'No endpoints yet. Add one below.' }),
    catalog.endpoints.length
      ? h('div', { class: 'row' }, field('Add an endpoint', pick), h('div', { class: 'acts' }, add))
      : h('p', { class: 'sub', text: "annai's list of endpoints hasn't been loaded yet. Connect to the internet and open this screen again." }),
    status);
}

/** @param {any} ctx @param {import('../../core/llm/config.js').ModelConfig} cfg */
function rolesSection(ctx, cfg) {
  const types = ctx.llm.types();
  const models = Object.values(cfg.models).map(modelOf);
  const kind = (/** @type {string} */ id) => speechKind(cfg, types, id);
  const nameOf = (/** @type {string} */ id) => STAND_INS[id]?.name ?? models.find((m) => m.id === id)?.name ?? id;
  const save = async (/** @type {import('../../core/llm/config.js').Roles} */ roles) => {
    await saveRoles(ctx.ws, roles);
    ctx.render();
  };
  /** A speech list can take its own stand-ins and the models of its direction. @param {string} role */
  const speechChoices = (role) => [
    ...Object.entries(STAND_INS).filter(([, s]) => s.role === role).map(([id, s]) => ({ id, name: s.name })),
    ...models.filter((m) => kind(m.id) === (role === 'speech-in' ? 'in' : 'out')),
  ];
  return h('section', { class: 'panel', 'aria-label': 'Roles' },
    h('h2', { class: 'section', text: 'Roles' }),
    h('p', { class: 'sub', text: 'Each role tries its models from the top. When one fails, the next one answers. An empty role uses the main list.' }),
    ...CHAT_ROLES.map((role) => roleBlock(role, cfg.roles, models.filter((m) => !kind(m.id)), nameOf, save)),
    h('p', { class: 'sub', text: 'The speech lists are tried from the top too: the first entry that works for the model hearing you, and the first voice that answers.' }),
    ...SPEECH_ROLES.map((role) => roleBlock(role, cfg.roles, speechChoices(role), nameOf, save, { speech: true })));
}

/**
 * @param {string} role @param {import('../../core/llm/config.js').Roles} roles @param {{ id: string, name: string }[]} choices what can be added
 * @param {(id: string) => string} nameOf @param {(roles: any) => Promise<void>} save @param {{ speech?: boolean }} [o]
 */
function roleBlock(role, roles, choices, nameOf, save, { speech = false } = {}) {
  const r = roles[role];
  /** @param {number} i @param {number} by */
  const moved = (i, by) => {
    const list = r.models.slice();
    [list[i], list[i + by]] = [list[i + by], list[i]];
    return { ...roles, [role]: { ...r, models: list } };
  };
  const items = r.models.map((id, i) => h('li', { class: 'role-item' },
    h('span', { text: `${i + 1}. ${nameOf(id)}${STAND_IN_NOTES[id] ? ` (${STAND_IN_NOTES[id]})` : ''}` }),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Move ${nameOf(id)} up`, disabled: i === 0, onclick: () => save(moved(i, -1)) }, '↑'),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Move ${nameOf(id)} down`, disabled: i === r.models.length - 1, onclick: () => save(moved(i, 1)) }, '↓'),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Remove ${nameOf(id)} from ${role}`, onclick: () => save({ ...roles, [role]: { ...r, models: r.models.filter((_, j) => j !== i) } }) }, '✕')));
  const others = choices.filter((m) => !r.models.includes(m.id));
  const pick = h('select', { id: `role-${role}-add` }, ...others.map((m) => h('option', { value: m.id, text: m.name })));
  const level = speech ? null : h('select', { id: `role-${role}-level`, onchange: () => save({ ...roles, [role]: { ...r, level: level.value } }) }, ...LEVELS.map((l) => h('option', { value: l, text: l })));
  if (level) level.value = r.level;
  const wait = h('input', {
    id: `role-${role}-wait`, inputmode: 'numeric', placeholder: speech ? (role === 'speech-in' ? '15' : '10') : '30', value: r.firstOutputSeconds ?? '',
    onchange: () => {
      const n = Math.round(Number(wait.value));
      const { firstOutputSeconds: _, ...rest } = r;
      save({ ...roles, [role]: wait.value.trim() && n >= 1 && n <= 600 ? { ...rest, firstOutputSeconds: n } : rest });
    },
  });
  const empty = role === 'main' ? 'No models yet. Add one.'
    : role === 'speech-in' ? "Nothing here, so annai can't hear you. Add an entry."
      : role === 'speech-out' ? "Nothing here, so Shiori can't speak aloud. Add a voice."
        : 'Uses the main list.';
  const waitLabel = role === 'speech-in' ? 'Wait for the words (seconds)' : role === 'speech-out' ? 'Wait for the voice (seconds)' : 'Wait for the first words (seconds)';
  return h('div', { class: 'role' },
    h('h3', { class: 'role-name', text: ROLE_NAMES[role] ?? role }),
    items.length ? h('ol', { class: 'role-list' }, ...items) : h('p', { class: 'sub', text: empty }),
    h('div', { class: 'row' },
      others.length ? field(`Add a model to ${role}`, pick) : null,
      others.length ? h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => save({ ...roles, [role]: { ...r, models: speech ? speechAdd(r.models, pick.value, role) : [...r.models, pick.value] } }) }, `Add to ${role}`)) : null,
      level ? field(`Reasoning for ${role}`, level) : null,
      field(waitLabel, wait)));
}

/** The quickest start: Sign in with OpenRouter (spec §9.8), offered until an OpenRouter endpoint exists. @param {any} ctx @param {import('../../core/llm/config.js').ModelConfig} cfg */
function signInSection(ctx, cfg) {
  if (Object.values(cfg.endpoints).some((e) => e.template?.id === 'openrouter')) return null;
  const status = h('p', { class: 'sub', role: 'status' });
  const codeSlot = h('div', {});
  const btn = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      try {
        if (needsCode()) {
          window.open(await signInUrl({ callback: null }), '_blank', 'noopener');
          codeSlot.replaceChildren(pasteCode(ctx, status));
        } else {
          location.assign(await signInUrl({ callback: `${location.origin}/` }));
        }
      } catch (e) {
        status.textContent = messageOf(e);
      }
    },
  }, 'Sign in with OpenRouter');
  return h('section', { class: 'panel', 'aria-label': 'Sign in' },
    h('h2', { class: 'section', text: 'The quickest start' }),
    h('p', { text: 'Sign in with OpenRouter to get one key for many models. annai starts you on free models (50 requests a day), so trying it costs nothing.' }),
    h('div', { class: 'acts' }, btn),
    codeSlot,
    status);
}

/** On an iPhone Home Screen app: paste the code OpenRouter showed. @param {any} ctx @param {HTMLElement} status */
function pasteCode(ctx, status) {
  const code = h('input', { id: 'openrouter-code', autocomplete: 'off', autocapitalize: 'off' });
  const go = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      go.disabled = true;
      try {
        await connectOpenRouter(ctx, await exchange({ code: code.value, state: null, pasted: true }));
        ctx.notices.toast('Signed in with OpenRouter.');
        ctx.render();
      } catch (e) {
        status.textContent = messageOf(e);
        go.disabled = false;
      }
    },
  }, 'Connect');
  return h('div', { class: 'row' }, field('Paste the code OpenRouter showed you', code), h('div', { class: 'acts' }, go));
}
