import { h, field, savedField, savedCheck, autosave, numberIn, queueSave, messageOf } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { shownSettings } from '../../core/shown.js';
import { ME } from '../../core/scopes.js';
import { PRESETS, PERSONALITY_MAX, resetPersonality, keepMine } from '../../core/agent/personalities.js';
import { LABELS } from '../../core/agent/loop.js';
import { createAvatar } from '../avatar.js';
import { languagesSection } from '../languages.js';

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/** Her states as spec §16.3 names them, in its order. */
const LOOKS = /** @type {const} */ ([['sleeping', 'Asleep'], ['listening', 'Listening'], ['hearing', 'Hearing you'], ['thinking', 'Thinking'],
  ['speaking', 'Talking'], ['waiting', 'Your turn'], ['away', 'Working'], ['offline', 'Offline']]);

/** Every way she can look, side by side, to check her art (the user, 2026-10-18). */
function looks() {
  return h('div', { class: 'looks' }, ...LOOKS.map(([state, name]) => {
    const a = createAvatar({ size: 'md', label: `Shiori, ${name.toLowerCase()}` });
    a.setState(state);
    if (state === 'speaking') a.setLevel(0.6, 'her');
    if (state === 'hearing') a.setLevel(0.6, 'you');
    return h('figure', { class: 'look', dataset: { state } }, a.el,
      h('figcaption', {}, h('strong', { text: name }), h('span', { class: 'sub', text: LABELS[state] })));
  }));
}

/** Settings → Shiori (spec §14.1, §6.6): how she looks, her personality, and how often she acts on her own. @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderShiori(ctx, route) {
  const app = await readAppSettings(ctx.ws);
  const active = app.shiori?.personality ?? 'shiori';
  const names = (await ctx.ws.list(ME, '/personalities/')).map((/** @type {any} */ f) => f.path.replace(/^\/personalities\/|\.md$/g, ''));
  let editing = route.params.edit ?? active;
  let loaded = (await ctx.ws.readText(ME, `/personalities/${editing}.md`)) ?? '';
  const text = h('textarea', { id: 'personality-text', rows: 12, maxlength: PERSONALITY_MAX, value: loaded });
  const editor = field(`"${editing}"`, text);
  const reset = h('button', { class: 'btn', type: 'button', hidden: !(PRESETS.includes(editing) && ctx.presets), onclick: async () => { await resetPersonality(ctx.ws, editing, ctx.presets); ctx.render(); } }, 'Reset to original');
  /** The editor follows the choice, so Save and Reset act on it, unless opened on one or holding unsaved words. @param {string} n */
  const follow = async (n) => {
    if (route.params.edit || text.value !== loaded) return;
    editing = n;
    text.value = loaded = (await ctx.ws.readText(ME, `/personalities/${n}.md`)) ?? '';
    editor.firstChild.textContent = `"${n}"`;
    reset.hidden = !(PRESETS.includes(n) && ctx.presets);
  };
  const compare = route.params.compare;
  const newName = h('input', { id: 'new-personality', autocomplete: 'off', spellcheck: 'false', placeholder: 'my-shiori' });
  const nameError = h('p', { class: 'error', role: 'alert', hidden: true });
  const askFirst = savedCheck('Ask me before Shiori changes her personality', Boolean(app.shiori?.askBeforeTuning), (on) => updateAppSettings(ctx.ws, { shiori: { askBeforeTuning: on } }));
  const chosen = h('ul', { class: 'file-list' }, ...names.map((n) => h('li', {},
    h('label', { class: 'check' }, h('input', { type: 'radio', name: 'personality', value: n, checked: n === active }), h('span', { text: n })),
    h('a', { href: `#/shiori?edit=${encodeURIComponent(n)}`, text: 'Edit' }))));
  const showHalves = savedCheck('Show what the halves tell each other', shownSettings(app).showHalves, (on) => updateAppSettings(ctx.ws, { shiori: { showHalves: on } }));
  const b = app.shiori?.budgets ?? {};
  const budgets = (/** @type {Record<string, any>} */ c) => updateAppSettings(ctx.ws, { shiori: { budgets: c } });
  const num = (/** @type {string} */ id, /** @type {any} */ value) => h('input', { id, type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder: 'No limit', value: value ?? '' });
  const steps = num('budget-steps', b.stepsPerWake);
  const wakes = num('budget-wakes', b.wakesPerHour);
  const quietFrom = h('input', { id: 'quiet-from', type: 'time', value: b.quietHours?.from ?? '' });
  const quietTo = h('input', { id: 'quiet-to', type: 'time', value: b.quietHours?.to ?? '' });
  const quiet = h('div', { class: 'row' }, field('Quiet from', quietFrom), field('Quiet until', quietTo));
  const quietNote = h('span', { class: 'saved', role: 'status' });
  const quietHint = h('p', { class: 'sub', role: 'status', hidden: true });
  const quietError = h('p', { class: 'error', role: 'alert', hidden: true });
  const half = () => !quietFrom.value !== !quietTo.value;
  const hint = (/** @type {boolean} */ on) => { quietHint.hidden = !on; quietHint.textContent = on ? 'Set the other time too.' : ''; };
  // Saved once both are set, or both cleared. Halfway, a hint (an iPhone's wheel changes at each tick); left halfway, an alert.
  quiet.addEventListener('change', () => {
    quietNote.textContent = '';
    hint(half());
    if (half()) return;
    quietError.hidden = true;
    for (const i of [quietFrom, quietTo]) i.removeAttribute('aria-invalid');
    queueSave(async () => {
      try {
        await budgets({ quietHours: quietFrom.value ? { from: quietFrom.value, to: quietTo.value } : null });
        quietNote.textContent = 'Saved';
      } catch (e) {
        quietError.textContent = messageOf(e);
        quietError.hidden = false;
      }
    });
  });
  quiet.addEventListener('focusout', (/** @type {FocusEvent} */ e) => {
    if (quiet.contains(/** @type {Node | null} */ (e.relatedTarget)) || !half()) return;
    hint(false);
    quietError.textContent = 'Quiet hours need both times. Clear both for none.';
    quietError.hidden = false;
    for (const i of [quietFrom, quietTo]) if (!i.value) i.setAttribute('aria-invalid', 'true');
  });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Shiori' }),
    section('How she looks',
      h('p', { class: 'sub', text: 'Each state, as the dock shows her, with the words under her.' }),
      looks()),
    section('Personality',
      h('p', { class: 'sub', text: 'How Shiori behaves. She can adjust it herself through a reviewed change, and you can always undo it. A change applies at her next wake.' }),
      h('div', { class: 'saving' }, chosen, ...autosave(chosen, () => /** @type {HTMLInputElement} */ (chosen.querySelector('input:checked')).value, async (n) => {
        await updateAppSettings(ctx.ws, { shiori: { personality: n } });
        await follow(n);
      })),
      fromPlugins(ctx, names),
      compare && ctx.presets?.[compare] ? h('div', { class: 'compare' },
        h('h3', { text: `The new original of "${compare}"` }), h('pre', { class: 'mono', text: ctx.presets[compare] }),
        h('div', { class: 'acts' },
          h('button', { class: 'btn', type: 'button', onclick: async () => { await keepMine(ctx.ws, compare, ctx.presets[compare]); ctx.go('#/shiori'); } }, 'Keep mine'),
          h('button', { class: 'btn', type: 'button', onclick: async () => { await resetPersonality(ctx.ws, compare, ctx.presets); ctx.go('#/shiori'); } }, 'Use the new original'))) : null,
      editor,
      h('div', { class: 'acts' },
        h('button', {
          class: 'btn pri', type: 'button',
          onclick: async () => {
            const words = text.value;
            await ctx.ws.write(ME, `/personalities/${editing}.md`, words, { author: 'user' });
            loaded = words;
            ctx.notices.toast('Saved. It applies at her next wake.');
          },
        }, 'Save'),
        reset,
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const name = newName.value.trim();
          nameError.hidden = /^[a-z0-9][a-z0-9-]{0,39}$/.test(name) && !names.includes(name);
          if (!nameError.hidden) {
            nameError.textContent = names.includes(name) ? `There is already a personality called "${name}".` : 'A name is lowercase letters, digits and dashes, like my-shiori.';
            return;
          }
          await ctx.ws.write(ME, `/personalities/${name}.md`, text.value, { author: 'user' });
          ctx.go(`#/shiori?edit=${encodeURIComponent(name)}`);
        } }, 'New from this one')),
      field('Name for a new one', newName),
      nameError,
      askFirst.el),
    section('Her two halves',
      h('p', { class: 'sub', text: 'Koe talks with you and answers at once; Kokoro thinks things through and does the work. They pass each other short notes. On: the notes show in the conversation as quiet lines. Off: they stay in the Trace.' }),
      showHalves.el),
    languagesSection(ctx, app),
    // Spend per day, the cache and housekeeping are on Settings → Models, with the requests they shape (the user, 2026-10-18).
    section('How often she acts on her own',
      h('p', { class: 'sub', text: 'Plugins, reminders and GPS wake her as well as you. None of these is set unless you set it: more wakes in an hour are skipped, quiet hours hold her until they end (reminders still come), and past the steps of one wake she stops, with a card.' }),
      savedField('Wakes per hour, not counting yours', wakes, () => numberIn(wakes, 1, 10_000, 'Wakes per hour is a whole number from 1; leave it empty for no limit.', { whole: true }), (v) => budgets({ wakesPerHour: v })),
      h('div', { class: 'saving' }, quiet, quietNote, quietHint, quietError),
      savedField('Steps per wake', steps, () => numberIn(steps, 1, 10_000, 'Steps per wake is a whole number from 1; leave it empty for no limit on what you ask; what she does on her own stops after 50.', { whole: true }), (v) => budgets({ stepsPerWake: v }))));
}

/**
 * Personalities that installed packages bring (spec §5.2), not yet among the user's: Add copies one
 * into /me/personalities/, where it is the user's own file (milestone 8a, choice 12).
 * @param {any} ctx @param {string[]} names the user's personalities
 */
function fromPlugins(ctx, names) {
  const offered = (ctx.registry?.list('personality') ?? []).filter((/** @type {any} */ p) => typeof p?.name === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(p.name) && !names.includes(p.name));
  if (!offered.length) return null;
  return h('div', {},
    h('h3', { text: 'From plugins' }),
    h('ul', { class: 'file-list' }, ...offered.map((/** @type {any} */ p) => h('li', {},
      h('span', { text: `${p.name} (from ${p.plugin ?? 'a plugin'})` }),
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          if (await ctx.ws.read(ME, `/personalities/${p.name}.md`)) {
            ctx.notices.toast(`You already have a personality called "${p.name}".`);
            return;
          }
          await ctx.ws.write(ME, `/personalities/${p.name}.md`, String(p.text ?? ''), { author: 'user' });
          ctx.notices.toast(`Added the personality "${p.name}". Choose it above.`);
          ctx.render();
        },
      }, 'Add')))));
}
