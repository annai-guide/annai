import { h } from './dom.js';
import { chipText } from '../core/voice/mode.js';

const SETTINGS = /** @type {const} */ ([['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]);
const KOE_MODES = /** @type {const} */ ([['realtime', 'Realtime'], ['classic', 'Classic']]);

/**
 * @typedef {{ mode: 'realtime' | 'classic', using: 'realtime' | 'classic', why: string, koe: boolean }} Way
 *   Koe's way, as Halves gives it (koeWay): the mode chosen, the list in use, why Classic stands in, whether a Koe list holds a model
 */

/**
 * What the chip adds for Koe while voice is on (the user, 2026-10-22: "how koe work or in which mode it is"): the list in use,
 * and when Classic stands in for a chosen Realtime, why. Nothing with no Koe model, or with voice off (Classic then, as always).
 * @param {Way | null} way @param {boolean} on
 */
export function koeWords(way, on) {
  if (!way?.koe || !on) return '';
  if (way.using === 'realtime') return ' · Realtime';
  return way.why === 'none' ? ' · Classic (no Realtime model)' : way.why === 'unavailable' ? ' · Classic (Realtime unavailable)' : ' · Classic';
}

/**
 * The voice chip (spec §10.5): what voice is now ("Voice auto · off", "Voice on · car audio"),
 * always one tap away; a tap shows Auto, On and Off. The three are drawn only while shown, so
 * the dock adds no words to the screens it sits on. While a live session's microphone is open it
 * says so plainly, "Listening live" (K5: what is said goes to the provider as it is said). With a Koe
 * model, it also says which of Koe's lists talks, "Voice on · Realtime", and its menu switches
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
  let way = ctx.agent?.way ?? null;
  const open = () => {
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
    const why = way?.koe && way.mode === 'realtime' && way.using === 'classic' && (way.why === 'none' || way.why === 'unavailable')
      ? h('p', { class: 'voice-menu-note', text: way.why === 'none' ? 'Realtime has no model: add one under Koe · Realtime in Settings → Models. Classic talks meanwhile.' : "Realtime can't answer now. Classic talks until it can." })
      : null;
    menu.replaceChildren(voiceRow, ...(koe ? [koe] : []), ...(why ? [why] : []));
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
    chip.textContent = live === 'listening' ? 'Listening live' : `${chipText(voice.mode)}${koeWords(way, voice.mode.on)}`;
    chip.classList.toggle('listening', live === 'listening');
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
