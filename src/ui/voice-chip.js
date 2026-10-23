import { h } from './dom.js';
import { chipText, koeWords } from '../core/voice/mode.js';

const SETTINGS = /** @type {const} */ ([['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]);
const KOE_MODES = /** @type {const} */ ([['realtime', 'Realtime'], ['classic', 'Classic']]);

/**
 * @typedef {{ mode: 'realtime' | 'classic', using: 'realtime' | 'classic', why: string, koe: boolean, split: boolean, path: string | null }} Way
 *   Koe's way, as Halves gives it (koeWay): the mode chosen, the list in use, why Classic stands in, whether a Koe list holds a
 *   model, whether Shiori is two halves, and Koe's pathway (null: Koe is down)
 */

/**
 * The voice chip (spec §10.5): what voice is now ("Voice auto · off", "Voice on · car audio"),
 * always one tap away; a tap shows Auto, On and Off. The three are drawn only while shown, so
 * the dock adds no words to the screens it sits on. While a live session's microphone is open it
 * says so plainly, "Listening live" (K5: what is said goes to the provider as it is said). With a Koe
 * model, it also says which of Koe's lists talks, "Voice on · Realtime" (koeWords), and its menu switches
 * between Realtime and Classic (the user, 2026-10-22).
 * @param {any} ctx
 */
export function voiceChip(ctx) {
  const voice = ctx.voice;
  const chip = h('button', { class: 'chip voice-chip', type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'true', 'aria-controls': 'voice-menu', text: chipText(voice.mode) });
  const menu = h('div', { id: 'voice-menu', class: 'voice-menu', role: 'group', 'aria-label': 'Voice', hidden: true });
  /** A tap anywhere else closes it, as the live menu does. @param {Event} e */
  const outside = (e) => { if (!el.contains(/** @type {Node} */ (e.target))) close(); };
  const close = () => {
    menu.hidden = true;
    menu.replaceChildren();
    chip.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  /** @type {Way | null} */
  let way = ctx.agent?.way ? { ...ctx.agent.way, path: ctx.agent.way.path?.kind ?? null } : null;
  /** What the menu was drawn from: it is drawn again only when that changes, so a focused button isn't replaced for nothing. */
  let drawn = '';
  const what = () => JSON.stringify([way, voice.mode.setting, voice.mode.on]);
  /** The menu's buttons and Koe's sentence, as things are now: drawn again when they change while it is open. */
  const draw = () => {
    drawn = what();
    const row = (/** @type {Record<string, string>} */ a, /** @type {Node[]} */ ...buttons) => h('div', { class: 'voice-menu-row', ...a }, ...buttons);
    const voiceRow = row({}, ...SETTINGS.map(([setting, label]) => h('button', {
      class: 'btn', type: 'button', 'aria-pressed': String(voice.mode.setting === setting),
      onclick: async () => {
        close();
        await voice.choose(setting);
      },
    }, label)));
    // Koe's two lists (Settings → Models): which one talks while voice is on.
    const koe = way?.koe ? row({ role: 'group', 'aria-label': 'Koe' }, h('span', { class: 'voice-menu-label', text: 'Koe' }), ...KOE_MODES.map(([mode, label]) => h('button', {
      class: 'btn', type: 'button', 'aria-pressed': String(way?.mode === mode),
      onclick: async () => {
        close();
        await ctx.agent.chooseKoe(mode);
      },
    }, label))) : null;
    const { note } = koeWords(way, voice.mode.on);
    menu.replaceChildren(voiceRow, ...(koe ? [koe] : []), ...(note ? [h('p', { class: 'voice-menu-note', text: note })] : []));
  };
  const open = () => {
    draw();
    menu.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
  };
  chip.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') {
      close();
      chip.focus();
    }
  });
  /** @type {string | null} 'listening': a live session's microphone is open */
  let live = ctx.agent?.live?.listening ? 'listening' : null;
  const say = () => {
    const words = koeWords(way, voice.mode.on);
    // The reason stays on one line: a narrow phone wraps before it, never inside its parentheses.
    if (live === 'listening') chip.textContent = 'Listening live';
    else chip.replaceChildren(`${chipText(voice.mode)}${words.text}`, ...(words.reason ? [' ', h('span', { class: 'voice-chip-why', text: words.reason })] : []));
    chip.classList.toggle('listening', live === 'listening');
    if (!menu.hidden && what() !== drawn) draw();
  };
  say();
  const off = voice.onChange(say);
  // Shiori as two halves (Halves) has live sessions and Koe's way; one half never does.
  const offLive = ctx.agent?.live ? ctx.agent.on('halves', (/** @type {{ live?: string | null, way?: Way | null }} */ x) => {
    live = x.live === 'listening' ? 'listening' : null;
    way = x.way ?? null;
    say();
  }) : null;
  const el = h('div', { class: 'voice-chip-wrap' }, chip, menu);
  // dispose: the dock is remade; an open menu's listener for a tap elsewhere goes with it.
  return { el, dispose: () => { close(); off(); offLive?.(); } };
}
