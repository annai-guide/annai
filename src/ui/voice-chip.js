import { h } from './dom.js';
import { chipText } from '../core/voice/mode.js';

const SETTINGS = /** @type {const} */ ([['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]);

/**
 * The voice chip (spec §10.5): what voice is now ("Voice auto · off", "Voice on · car audio"),
 * always one tap away; a tap shows Auto, On and Off. The three are drawn only while shown, so
 * the dock adds no words to the screens it sits on.
 * @param {any} ctx
 */
export function voiceChip(ctx) {
  const voice = ctx.voice;
  const chip = h('button', { class: 'chip voice-chip', type: 'button', 'aria-expanded': 'false', text: chipText(voice.mode) });
  const menu = h('div', { class: 'voice-menu', role: 'group', 'aria-label': 'Voice', hidden: true });
  const close = () => {
    menu.hidden = true;
    menu.replaceChildren();
    chip.setAttribute('aria-expanded', 'false');
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
  };
  chip.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') {
      close();
      chip.focus();
    }
  });
  voice.onChange((/** @type {import('../core/voice/mode.js').VoiceMode} */ m) => { chip.textContent = chipText(m); });
  return { el: h('div', { class: 'voice-chip-wrap' }, chip, menu) };
}
