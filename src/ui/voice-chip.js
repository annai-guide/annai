import { h } from './dom.js';
import { chipText } from '../core/voice/mode.js';

const SETTINGS = /** @type {const} */ ([['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]);

/**
 * The voice chip (spec §10.5): what voice is now ("Voice auto · off", "Voice on · car audio"),
 * always one tap away; a tap shows Auto, On and Off.
 * @param {any} ctx
 */
export function voiceChip(ctx) {
  const voice = ctx.voice;
  const chip = h('button', { class: 'chip voice-chip', type: 'button', 'aria-expanded': 'false', text: chipText(voice.mode) });
  const close = () => {
    menu.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
  };
  const choices = SETTINGS.map(([setting, label]) => h('button', {
    class: 'btn', type: 'button', 'aria-pressed': String(voice.mode.setting === setting),
    onclick: async () => {
      close();
      await voice.choose(setting);
    },
  }, label));
  const menu = h('div', { class: 'voice-menu', role: 'group', 'aria-label': 'Voice', hidden: true }, ...choices);
  chip.addEventListener('click', () => {
    const opening = menu.hidden;
    menu.hidden = !opening;
    chip.setAttribute('aria-expanded', String(opening));
  });
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') {
      close();
      chip.focus();
    }
  });
  voice.onChange((/** @type {import('../core/voice/mode.js').VoiceMode} */ m) => {
    chip.textContent = chipText(m);
    SETTINGS.forEach(([setting], i) => choices[i].setAttribute('aria-pressed', String(m.setting === setting)));
  });
  return { el: h('div', { class: 'voice-chip-wrap' }, chip, menu) };
}
