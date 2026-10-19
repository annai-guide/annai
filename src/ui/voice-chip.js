import { h } from './dom.js';
import { chipText } from '../core/voice/mode.js';

const SETTINGS = /** @type {const} */ ([['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]);

/**
 * The voice chip (spec §10.5): what voice is now ("Voice auto · off", "Voice on · car audio"),
 * always one tap away; a tap shows Auto, On and Off. The three are drawn only while shown, so
 * the dock adds no words to the screens it sits on. While a live session's microphone is open it
 * says so plainly, "Listening live" (K5: what is said goes to the provider as it is said).
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
  const open = () => {
    menu.replaceChildren(...SETTINGS.map(([setting, label]) => h('button', {
      class: 'btn', type: 'button', 'aria-pressed': String(voice.mode.setting === setting),
      onclick: async () => {
        close();
        await voice.choose(setting);
      },
    }, label)));
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
  /** @type {string | null} 'listening': a live session's microphone is open; 'open': a session is open for typing */
  let live = ctx.agent?.live?.listening ? 'listening' : ctx.agent?.live?.state === 'open' ? 'open' : null;
  const say = () => {
    chip.textContent = live === 'listening' ? 'Listening live' : `${chipText(voice.mode)}${live ? ' · live' : ''}`;
    chip.classList.toggle('listening', live === 'listening');
  };
  say();
  const off = voice.onChange(say);
  const offLive = ctx.agent?.on?.('halves', (/** @type {{ live?: string | null }} */ x) => {
    live = x.live ?? null;
    say();
  });
  const el = h('div', { class: 'voice-chip-wrap' }, chip, menu);
  // dispose: the dock is remade; an open menu's listener for a tap elsewhere goes with it.
  return { el, dispose: () => { close(); off(); offLive?.(); } };
}
