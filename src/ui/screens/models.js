import { h, crumb, t, field, savedField, savedRadios, numberIn, queueSave } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { wantedTtl } from '../../core/agent/warmth.js';
import { providerOf, modelOf, abilityOf, saveRoles, SPEECH_ROLES, STAND_INS } from '../../core/llm/config.js';
import { LEVELS } from '../../core/llm/reasoning.js';
import { ROLE_KINDS } from '../../core/llm/provider-desc.js';
import { speechAdd } from '../../core/llm/providers.js';
import { renderProvider, renderNewProvider } from './provider.js';
import { renderModel } from './model.js';
import { featuredStart } from '../provider-setup.js';
import { numField } from '../format.js';

/** @type {Record<string, string>} */
const ROLE_NAMES = {
  main: 'Main: talks with you', 'koe-realtime': 'Koe · Realtime: hears you and speaks in one stream', 'koe-classic': 'Koe · Classic: a chat model, with Speech in and Speech out',
  utility: 'Utility: summaries and small jobs', decide: 'Quick decision: yes-or-no checks',
  'speech-in': 'Speech in: how Shiori hears you', 'speech-out': "Speech out: Shiori's voice",
};
/** The chat roles in the order they are shown: Koe's two lists right after Main. */
const CHAT_ORDER = ['main', 'koe-realtime', 'koe-classic', 'utility', 'decide'];
/** What each Koe list is for, in a line (the user, 2026-10-22: two lists and a switch on the voice chip). @type {Record<string, string>} */
const KOE_NOTES = {
  'koe-realtime': 'Koe uses it while voice is on and Realtime is chosen on the voice chip. When none here can answer, Classic does.',
  'koe-classic': 'Koe uses it when Classic is chosen, while voice is off, and when Realtime can\'t answer: Speech in hears you, and Speech out speaks.',
};
/** What each stand-in entry is (spec §10.1, §10.3). @type {Record<string, string>} */
/** Short notes on the stand-ins; Settings → Voice says where each sends your voice (spec §11.7). */
const STAND_IN_NOTES = { 'send-audio': 'when the model takes audio', dictation: "the phone's own; usually goes to Google or Apple", 'browser-voice': "the browser's own; some voices go online" };

/**
 * Settings → Models (spec §9.2, §9.6, §9.8): the providers annai calls, each with its abilities and
 * models, which models each role tries, in order, and what Shiori's requests may cost and how large
 * they grow (§6.4–6.6). A provider's page is #/models/provider?id=, a provider plugin's own Add flow
 * #/models/provider?new=, a model's #/models/model?id=.
 * @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderModels(ctx, route) {
  if (route.parts[1] === 'provider') return route.params.new ? renderNewProvider(ctx, route.params.new) : renderProvider(ctx, route.params.id ?? '');
  if (route.parts[1] === 'model') return renderModel(ctx, route.params.id ?? '');
  await ctx.llm.ready;
  const [cfg, app] = await Promise.all([ctx.llm.config(), readAppSettings(ctx.ws)]);
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/settings', t`Settings`)),
    h('h1', { class: 'title', text: 'Models' }),
    h('p', { class: 'sub', text: 'Where Shiori thinks: the providers annai calls, their models, which models each role tries, in order, and what her requests may cost.' }),
    // The one-tap start, while there is no provider (spec §9.8): the catalog's featured provider's own sign-in.
    Object.keys(cfg.providers).length ? null : featuredStart(ctx),
    providersSection(ctx, cfg),
    rolesSection(ctx, cfg),
    ...requestSections(ctx, app.shiori ?? {}));
}

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/**
 * What requests may cost and how large they grow, with the models (the user, 2026-10-18): a day's
 * spending (spec §6.6), the cache (§6.4), housekeeping (§6.5). Kept under shiori, where her loop reads them.
 * @param {any} ctx @param {Record<string, any>} s the app settings' shiori entry
 */
function requestSections(ctx, s) {
  const save = (/** @type {Record<string, any>} */ c) => updateAppSettings(ctx.ws, { shiori: c });
  const spend = h('input', { id: 'budget-spend', inputmode: 'decimal', placeholder: 'No limit', value: numField(s.budgets?.spendPerDay) });
  const c = { threshold: 0.7, maxRequestMiB: 8, ...(s.compaction ?? {}) };
  const share = h('input', { id: 'compaction-threshold', inputmode: 'numeric', placeholder: '70', value: numField(Math.round(c.threshold * 100)) });
  const mib = h('input', { id: 'compaction-max', inputmode: 'decimal', placeholder: '8', value: numField(c.maxRequestMiB) });
  return [
    section('Spend per day',
      h('p', { class: 'sub', text: "What Shiori's model calls may cost in a day, in all your trips. Once it is spent, her turn ends with a card, and she goes on the next day. Empty: no limit." }),
      savedField('Spend per day (USD)', spend, () => numberIn(spend, 0.01, Infinity, 'A day costs at least $0.01; leave it empty for no limit.'), (v) => save({ budgets: { spendPerDay: v } }))),
    section('Cache',
      h('p', { class: 'sub', text: 'Providers keep the start of the conversation for a while, so her next request costs less. An hour costs more to write than five minutes, and pays off when you talk less often than every few minutes. A model that keeps it only five minutes is asked for five.' }),
      savedRadios('Keep it for', [['1h', '1 hour'], ['5m', '5 minutes']], wantedTtl(s.cacheTtl), (v) => save({ cacheTtl: v }))),
    section('Housekeeping',
      h('p', { class: 'sub', text: "When a conversation gets long, Shiori summarizes its older part. She does it when it reaches this share of her model's context, or when a request would get this big. Empty: the usual." }),
      h('div', { class: 'row' },
        savedField('Summarize at (% of the context)', share, () => numberIn(share, 50, 90, 'Summarize at a share from 50 to 90%.', { whole: true }), (v) => save({ compaction: { threshold: v === null ? null : v / 100 } })),
        savedField('Largest request (MiB)', mib, () => numberIn(mib, 1, 64, 'The largest request is from 1 to 64 MiB.'), (v) => save({ compaction: { maxRequestMiB: v } })))),
  ];
}

/**
 * The providers, each with its abilities that are on and its models, and Add a provider, which opens
 * the catalog on model providers (spec §16.2). @param {any} ctx @param {import('../../core/llm/config.js').ModelConfig} cfg
 */
function providersSection(ctx, cfg) {
  const types = ctx.llm.types();
  const rows = Object.values(cfg.providers).sort((a, b) => a.created - b.created).map((rec) => {
    const p = providerOf(rec, (t) => types.get(t)?.tunables ?? {});
    const n = Object.values(cfg.models).filter((m) => m.provider === rec.id).length;
    const on = Object.values(p.abilities).filter((a) => a.on).map((a) => a.name);
    return h('li', {}, h('a', { class: 'card', href: `#/models/provider?id=${encodeURIComponent(rec.id)}` },
      h('span', { class: 'name', text: p.name }),
      h('span', { class: 'sub', text: [on.length ? on.join(', ') : 'Nothing switched on', `${n} model${n === 1 ? '' : 's'}`].join(' · ') })));
  });
  return h('section', { class: 'panel', 'aria-label': 'Providers' },
    h('h2', { class: 'section', text: 'Providers' }),
    rows.length ? h('ul', { class: 'cards' }, ...rows) : h('p', { class: 'empty', text: 'No providers yet. Add one below.' }),
    h('div', { class: 'acts' }, h('a', { class: 'btn pri', href: '#/add?kind=providers&from=models' }, 'Add a provider')));
}

/** @param {any} ctx @param {import('../../core/llm/config.js').ModelConfig} cfg */
function rolesSection(ctx, cfg) {
  const models = Object.values(cfg.models).map(modelOf);
  /** The ability kind a model belongs to: a role takes models of its own kind. @param {string} id */
  const kind = (id) => abilityOf(cfg, id)?.kind;
  const nameOf = (/** @type {string} */ id) => STAND_INS[id]?.name ?? models.find((m) => m.id === id)?.name ?? id;
  /**
   * Changes one role as it is saved now, read fresh so no other change is lost.
   * @param {string} role @param {(r: import('../../core/llm/config.js').Roles[string]) => import('../../core/llm/config.js').Roles[string]} change
   */
  const edit = async (role, change) => {
    const roles = (await ctx.llm.config()).roles;
    await saveRoles(ctx.ws, { ...roles, [role]: change(roles[role]) });
  };
  /** A button's change to a role's list, after the saves waiting; Models is drawn again unless another screen was opened meanwhile. @param {string} role @param {(models: string[]) => string[]} change */
  const list = async (role, change) => {
    const here = location.hash;
    await queueSave(() => edit(role, (r) => ({ ...r, models: change(r.models) })));
    if (location.hash === here) await ctx.render();
  };
  /** A speech list can take its own stand-ins and the models of its kind: transcription, or voices. @param {string} role */
  const speechChoices = (role) => [
    ...Object.entries(STAND_INS).filter(([, s]) => s.role === role).map(([id, s]) => ({ id, name: s.name })),
    ...models.filter((m) => ROLE_KINDS[role].includes(kind(m.id) ?? '')),
  ];
  return h('section', { class: 'panel', 'aria-label': 'Roles' },
    h('h2', { class: 'section', text: 'Roles' }),
    h('p', { class: 'sub', text: "Each role tries its models from the top. When one fails, the next one answers. An empty role uses the main list, except Koe's." }),
    ...CHAT_ORDER.map((role) => roleBlock(role, cfg.roles, models.filter((m) => ROLE_KINDS[role].includes(kind(m.id) ?? '')), nameOf, list, edit,
      { known: new Set(Object.keys(cfg.models)) })),
    h('p', { class: 'sub', text: 'The speech lists are tried from the top too: the first entry that works for the model hearing you, and the first voice that answers.' }),
    ...SPEECH_ROLES.map((role) => roleBlock(role, cfg.roles, speechChoices(role), nameOf, list, edit, { speech: true, known: new Set(Object.keys(cfg.models)) })));
}

/**
 * One role: its list, which buttons change, and its reasoning level and wait, which save as they change.
 * @param {string} role @param {import('../../core/llm/config.js').Roles} roles @param {{ id: string, name: string }[]} choices what can be added
 * @param {(id: string) => string} nameOf @param {(role: string, change: (models: string[]) => string[]) => Promise<void>} list
 * @param {(role: string, change: (r: any) => any) => Promise<void>} edit @param {{ speech?: boolean, known?: Set<string> }} [o] known: the models that have a page
 */
function roleBlock(role, roles, choices, nameOf, list, edit, { speech = false, known = new Set() } = {}) {
  const r = roles[role];
  const koe = role === 'koe-classic';
  // A live session takes no level, and has its own wait for an answer (spec §10.8): Realtime shows neither.
  const realtime = role === 'koe-realtime';
  const called = KOE_NOTES[role] ? ROLE_NAMES[role].split(':')[0] : role; // Koe's lists by name, the rest by id
  /** Moves an entry up or down the list as it is when saved. @param {string} id @param {number} by */
  const move = (id, by) => list(role, (ids) => {
    const next = ids.slice();
    const i = next.indexOf(id);
    if (i >= 0 && next[i + by]) [next[i], next[i + by]] = [next[i + by], next[i]];
    return next;
  });
  const items = r.models.map((id, i) => reorderable(role, id, i, r.models.length, nameOf(id), known.has(id), STAND_IN_NOTES[id], move, list,
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Remove ${nameOf(id)} from ${called}`, onclick: () => list(role, (ids) => ids.filter((x) => x !== id)) }, '✕')));
  const others = choices.filter((m) => !r.models.includes(m.id));
  const pick = h('select', { id: `role-${role}-add` }, ...others.map((m) => h('option', { value: m.id, text: m.name })));
  const level = speech || realtime ? null : h('select', { id: `role-${role}-level` }, ...LEVELS.map((l) => h('option', { value: l, text: l })));
  if (level) level.value = r.level;
  const wait = h('input', { id: `role-${role}-wait`, inputmode: 'numeric', placeholder: speech ? (role === 'speech-in' ? '15' : '10') : koe ? '8' : '30', value: numField(r.firstOutputSeconds) });
  const empty = role === 'main' ? 'No models yet. Add one.'
    : realtime ? 'Empty: Koe has no realtime voice, so Classic answers. Add one, such as Gemini Live, from a provider with live voice.'
    : koe ? 'Empty: in Classic, Shiori is one half, the main model. Add a fast model here to give her a quick voice in front.'
    : role === 'speech-in' ? "Nothing here, so annai can't hear you. Add an entry."
      : role === 'speech-out' ? "Nothing here, so Shiori can't speak aloud. Add a voice."
        : 'Uses the main list.';
  const waitLabel = role === 'speech-in' ? 'Wait for the words (seconds)' : role === 'speech-out' ? 'Wait for the voice (seconds)' : 'Wait for the first words (seconds)';
  return h('div', { class: 'role' },
    h('h3', { class: 'role-name', text: ROLE_NAMES[role] ?? role }),
    items.length ? h('ol', { class: 'role-list' }, ...items) : h('p', { class: 'sub', text: empty }),
    KOE_NOTES[role] ? h('p', { class: 'sub', text: KOE_NOTES[role] }) : null,
    role === 'utility' ? h('p', { class: 'sub', text: "A model that can't see photos or read PDFs gets each photo or PDF it reads described by a model here that can, else by Main's." }) : null,
    // The catalog, on providers that can hear you, or speak (spec §16.2).
    speech ? h('div', { class: 'acts' }, h('a', { class: 'btn', href: `#/add?ability=${ROLE_KINDS[role][0]}&from=models`, 'aria-label': `Add a provider for ${role}` }, 'Add a provider')) : null,
    h('div', { class: 'row' },
      others.length ? field(`Add a model to ${called}`, pick) : null,
      others.length ? h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          const id = pick.value; // as chosen at the tap
          list(role, (ids) => (ids.includes(id) ? ids : speech ? speechAdd(ids, id, role) : [...ids, id]));
        },
      }, `Add to ${called}`)) : null,
      level ? savedField(`Reasoning for ${called}`, level, () => level.value, (v) => edit(role, (x) => ({ ...x, level: v }))) : null,
      realtime ? null : savedField(waitLabel, wait, () => numberIn(wait, 1, 600, 'Wait from 1 to 600 seconds; leave it empty for the usual.', { whole: true }),
        (n) => edit(role, ({ firstOutputSeconds: _, ...x }) => (n === null ? x : { ...x, firstOutputSeconds: n })))));
}

/** The numbers and the handles' names, from the list's order as it stands: after a drag, kept or put back. @param {Element} ol */
function renumber(ol) {
  const n = ol.children.length;
  [...ol.children].forEach((x, k) => {
    const li = /** @type {HTMLElement} */ (x);
    const num = li.firstElementChild?.firstChild;
    if (num) num.textContent = `${k + 1}. `;
    li.querySelector('.grip')?.setAttribute('aria-label', `Reorder ${li.dataset.name}, ${k + 1} of ${n}`);
  });
}
/** Ids for the menus. */
let menus = 0;

/**
 * One entry of a role's list: its model's name, a link to the model's page where there is one (the user, 2026-10-22), a handle to
 * drag it by, and the remove button. Dragging uses pointer events, so a finger works as a mouse does (HTML5 drag and drop doesn't on
 * iOS); the handle also takes the arrow keys, and a tap on it shows Move up and Move down, so nothing needs a drag.
 * @param {string} role @param {string} id @param {number} i @param {number} n @param {string} name @param {boolean} page @param {string | undefined} note
 * @param {(id: string, by: number) => Promise<void>} move @param {(role: string, change: (models: string[]) => string[]) => Promise<void>} list @param {Node} remove
 */
export function reorderable(role, id, i, n, name, page, note, move, list, remove) {
  const label = h('span', {}, `${i + 1}. `, page ? h('a', { href: `#/models/model?id=${encodeURIComponent(id)}`, text: name }) : name, note ? ` (${note})` : '');
  const menuId = `reorder-menu-${++menus}`;
  const grip = h('button', {
    class: 'btn ghost grip', type: 'button', 'aria-label': `Reorder ${name}, ${i + 1} of ${n}`, 'aria-expanded': 'false', 'aria-controls': menuId, 'data-grip': `${role}\n${id}`,
    title: 'Drag, or use the arrow keys',
  }, '⠿');
  const menu = h('div', { id: menuId, class: 'reorder-menu', role: 'group', 'aria-label': `Move ${name}`, hidden: true, onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') shut(true); } },
    h('button', { class: 'btn', type: 'button', disabled: i === 0, onclick: () => again(move(id, -1)) }, 'Move up'),
    h('button', { class: 'btn', type: 'button', disabled: i === n - 1, onclick: () => again(move(id, 1)) }, 'Move down'));
  const li = h('li', { class: 'role-item', 'data-id': id, 'data-name': name }, label, grip, remove, menu);
  /** Once the list is drawn again, the handle takes the focus back, so arrow keys go on. @param {Promise<void>} moved */
  const again = (moved) => moved.then(() => {
    for (const g of document.querySelectorAll('.grip')) if (g instanceof HTMLElement && g.dataset.grip === `${role}\n${id}`) g.focus();
  });
  /** @param {boolean} [focus] the handle takes the focus back */
  const shut = (focus = false) => {
    menu.hidden = true;
    grip.setAttribute('aria-expanded', 'false');
    if (focus) grip.focus();
  };
  grip.addEventListener('click', () => {
    if (dragged) return;
    if (!menu.hidden) return shut();
    menu.hidden = false;
    grip.setAttribute('aria-expanded', 'true');
    /** @type {HTMLElement | null} */ (menu.querySelector('button:not(:disabled)'))?.focus();
  });
  grip.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) shut();
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      again(move(id, e.key === 'ArrowUp' ? -1 : 1));
    }
  });
  // Drag: the entry follows the pointer and the others make room, by the DOM's own order; the list is saved as it ends.
  let dragged = false;
  /** @type {{ id: number, y: number, top: number, gate: number, order: Element[] } | null} */
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary || drag) return;
    grip.setPointerCapture(e.pointerId);
    // A finger shakes: it needs to move further than a mouse before it is a drag, and less than that is a tap.
    drag = { id: e.pointerId, y: e.clientY, top: li.getBoundingClientRect().top, gate: e.pointerType === 'touch' ? 8 : 4, order: [.../** @type {HTMLElement} */ (li.parentElement).children] };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || !li.parentElement) return;
    if (!dragged && Math.abs(e.clientY - drag.y) < drag.gate) return;
    if (!dragged) {
      dragged = true;
      li.classList.add('dragging');
      shut();
    }
    li.style.transform = '';
    for (;;) {
      const before = li.previousElementSibling;
      const after = li.nextElementSibling;
      const at = (/** @type {Element} */ x) => { const b = x.getBoundingClientRect(); return b.top + b.height / 2; };
      const wantTop = e.clientY - (drag.y - drag.top);
      const mid = wantTop + li.getBoundingClientRect().height / 2;
      if (before && mid < at(before)) before.before(li);
      else if (after && mid > at(after)) after.after(li);
      else break;
    }
    if (!grip.hasPointerCapture(drag.id)) grip.setPointerCapture(drag.id); // moving the entry in the page let go of it
    li.style.transform = `translateY(${e.clientY - (drag.y - drag.top) - li.getBoundingClientRect().top}px)`;
    renumber(li.parentElement);
  });
  /** @param {PointerEvent} e @param {boolean} save */
  const drop = (e, save) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    if (!dragged) return;
    li.classList.remove('dragging');
    li.style.transform = '';
    const order = [...(li.parentElement?.children ?? [])].map((x) => /** @type {HTMLElement} */ (x).dataset.id ?? '');
    setTimeout(() => { dragged = false; }, 0); // the click that ends a drag opens nothing
    if (save && order.join() !== d.order.map((x) => /** @type {HTMLElement} */ (x).dataset.id).join()) list(role, (ids) => [...order.filter((x) => ids.includes(x)), ...ids.filter((x) => !order.includes(x))]);
    else if (li.parentElement) {
      li.parentElement.replaceChildren(...d.order);
      renumber(li.parentElement);
    }
  };
  grip.addEventListener('pointerup', (e) => drop(e, true));
  grip.addEventListener('pointercancel', (e) => drop(e, false));
  return li;
}
