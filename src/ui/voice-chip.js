import { h, t } from './dom.js';
import { chipText } from '../core/voice/mode.js';

/**
 * The voice chip and the Live chip (spec §10.5), side by side: each is one tap on or off. Voice reads "Voice on" or "Voice off", and
 * "Voice on · driving" while driving is why it's on. While a live session's microphone is open it says so plainly, "Listening live"
 * (K5: what is said goes to the provider as it is said). Live reads "Live" or "Live off", shown only when a live model exists; it
 * chooses which of Koe's lists talks while voice is on (koeMode).
 * @param {any} ctx
 */
export function voiceChip(ctx) {
  const voice = ctx.voice;
  const chip = h('button', { class: 'chip voice-chip', type: 'button', onclick: () => voice.choose(voice.on ? 'off' : 'on') });
  const liveChip = h('button', {
    class: 'chip koe-live-chip', type: 'button', hidden: true,
    onclick: () => {
      voice.unlock(); // a choice is a tap (spec §10.1)
      return ctx.agent.chooseKoe(way?.mode === 'realtime' ? 'classic' : 'realtime');
    },
  });
  /** @type {{ mode: string, live: boolean } | null} Koe's way, as Halves gives it: the mode chosen, and whether a live model exists */
  let way = ctx.agent?.way ?? null;
  let listening = Boolean(ctx.agent?.live?.listening);
  const say = () => {
    chip.textContent = listening ? t`Listening live` : chipText(voice.mode);
    chip.setAttribute('aria-pressed', String(voice.on));
    chip.classList.toggle('listening', listening);
    const on = way?.mode === 'realtime';
    liveChip.hidden = !way?.live;
    liveChip.textContent = on ? t`Live` : t`Live off`;
    liveChip.setAttribute('aria-pressed', String(on));
  };
  say();
  const off = voice.onChange(say);
  // Shiori as two halves (Halves) has live sessions and Koe's way; one half never does.
  const offLive = ctx.agent?.live ? ctx.agent.on('halves', (/** @type {{ live?: string | null, way?: { mode: string, live: boolean } | null }} */ x) => {
    listening = x.live === 'listening';
    way = x.way ?? null;
    say();
  }) : null;
  const el = h('div', { class: 'voice-chip-wrap' }, chip, liveChip);
  return { el, dispose: () => { off(); offLive?.(); } };
}
