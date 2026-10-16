import { h, field } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { voiceSettings } from '../../core/voice/settings.js';
import { modelOf } from '../../core/llm/config.js';
import { SAMPLE, speechProblem } from '../speech-check.js';

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/**
 * Settings → Voice (spec §10, §16.2): Shiori's voices and the browser voice, and listening, each
 * with a test. The speech lists themselves are on the Models screen.
 * @param {any} ctx
 */
export async function renderVoice(ctx) {
  await ctx.llm.ready;
  const voice = ctx.voice;
  const s = voiceSettings(await readAppSettings(ctx.ws));
  const entries = await voice.outEntries();
  const synth = voice.platform?.synth;

  const sayStatus = h('p', { class: 'sub', role: 'status' });
  const sayButton = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      sayButton.disabled = true;
      sayStatus.textContent = 'Speaking…';
      try {
        const r = await voice.say(SAMPLE);
        sayStatus.textContent = r.failed === 'blocked' ? "This browser didn't let annai play sound yet. Tap anywhere on the page, then try again."
          : r.failed ? 'No voice could speak. The Trace shows what each voice answered; check them in Settings → Models.'
            : `Spoken by ${r.voices.join(', then ')}.`;
      } catch (e) {
        sayStatus.textContent = speechProblem(e);
      } finally {
        sayButton.disabled = false;
      }
    },
  }, 'Test the voice');

  const pick = h('select', { id: 'voice-browser' });
  const fill = () => {
    const chosen = pick.value || s.browserVoice;
    pick.replaceChildren(h('option', { value: '', text: "The browser's choice" }), ...(synth?.voices() ?? []).map((/** @type {any} */ v) => h('option', { value: v.id, text: `${v.name} (${v.lang})` })));
    pick.value = chosen;
  };
  fill();
  // The browser loads its voices a moment after the page opens.
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', fill, { once: true });
  const rate = h('input', { id: 'voice-rate', type: 'number', min: '0.5', max: '2', step: '0.1', value: String(s.rate) });
  const browserStatus = h('p', { class: 'sub', role: 'status' });
  const saveBrowser = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const r = Number(rate.value);
      if (!(r >= 0.5 && r <= 2)) {
        browserStatus.textContent = 'The speed goes from 0.5 (slow) to 2 (fast); 1 is normal.';
        return;
      }
      browserStatus.textContent = '';
      await updateAppSettings(ctx.ws, { voice: { browserVoice: pick.value, rate: r } });
      ctx.notices.toast('Saved');
    },
  }, 'Save the browser voice');

  const pause = h('input', { id: 'voice-pause', type: 'number', min: '300', max: '3000', step: '50', value: String(s.pauseMs) });
  const meter = h('meter', { min: '0', max: '1', value: '0', 'aria-label': 'How loud the microphone hears you' });
  const micStatus = h('p', { class: 'sub', role: 'status' });
  const savePause = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const ms = Math.round(Number(pause.value));
      if (!(ms >= 300 && ms <= 3000)) {
        micStatus.textContent = 'The pause goes from 300 to 3000 milliseconds; 700 is the usual.';
        return;
      }
      await updateAppSettings(ctx.ws, { voice: { pauseMs: ms } });
      ctx.notices.toast('Saved');
    },
  }, 'Save the pause');
  const micButton = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      micButton.disabled = true;
      micStatus.textContent = 'Say something…';
      const off = voice.onLevel((/** @type {number} */ x, /** @type {string} */ who) => { if (who === 'you') meter.value = x; });
      try {
        const seg = await voice.listenOnce({ seconds: 15, onSpeech: () => { micStatus.textContent = 'Hearing you…'; } });
        if (!seg) {
          micStatus.textContent = 'Nothing was heard in 15 seconds. Check that the microphone is on and that no other app is using it, then try again.';
          return;
        }
        const lines = [`Heard ${(seg.ms / 1000).toFixed(1)} seconds of speech.`];
        const [first] = await voice.transcribers();
        if (first) {
          micStatus.textContent = `${lines[0]} Writing it down…`;
          const text = await voice.transcribe(seg, first);
          const rec = (await ctx.llm.config()).models[first];
          const name = rec ? modelOf(rec).name : first;
          lines.push(text ? `${name} heard: "${text}"` : `${name} heard speech but wrote nothing down.`);
        } else {
          lines.push('Add a transcription model in Settings → Models to see the words.');
        }
        micStatus.textContent = lines.join(' ');
      } catch (e) {
        micStatus.textContent = speechProblem(e);
      } finally {
        off();
        meter.value = 0;
        micButton.disabled = false;
      }
    },
  }, 'Test the microphone');

  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Voice' }),
    h('p', { class: 'sub', text: 'How Shiori speaks and hears you. Which voices and which transcription models she uses, and in what order, is in Settings → Models.' }),
    section("Shiori's voice",
      h('p', { class: 'sub', text: `Voices, tried in order: ${entries.map((/** @type {any} */ e) => e.name).join(', ') || 'none'}.` }),
      h('div', { class: 'acts' }, sayButton), sayStatus),
    section('Browser voice',
      h('p', { class: 'sub', text: synth?.available() ? "This phone's own voice. It works offline." : 'This browser has no voice of its own.' }),
      h('div', { class: 'row' }, field('Voice', pick), field('Speed (0.5 to 2)', rate)),
      h('div', { class: 'acts' }, saveBrowser), browserStatus),
    section('Listening',
      h('p', { class: 'sub', text: 'annai hears that you finished a sentence when you pause. A longer pause lets you think mid-sentence; a shorter one answers sooner.' }),
      field('Pause that ends a sentence (ms)', pause), h('div', { class: 'acts' }, savePause),
      meter, h('div', { class: 'acts' }, micButton), micStatus));
}
