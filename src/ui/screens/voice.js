import { h, savedField, savedRadios, savedCheck, numberIn } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { voiceSettings } from '../../core/voice/settings.js';
import { modelOf, abilityOf, providerOf, KOE_ROLES } from '../../core/llm/config.js';
import { SAMPLE, speechProblem } from '../speech-check.js';
import { whereHeard, whereSaid } from '../../core/voice/where.js';

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
  const cfg = await ctx.llm.config();
  const dictation = { available: Boolean(voice.platform?.dictation.available()), local: await voice.dictationLocal() };
  // What this phone makes and plays (spec §10.6), for the device checks.
  const records = (voice.platform?.encoder?.records?.() ?? []).map((/** @type {any} */ r) => r.format);
  const formats = `Speech leaves this phone in the smallest format each service takes. Made here: ${(await voice.makes()).join(', ')}${records.length ? ` (recorded: ${records.join(', ')})` : ''}. Played here: ${voice.plays().join(', ')}.`;
  /** Where your voice goes (spec §11.7), one entry a row. @param {import('../../core/voice/where.js').Where[]} rows */
  const whereRows = (rows) => rows.map((r) => h('li', {}, h('strong', { text: r.name }), h('p', { class: 'sub', text: r.where })));
  const heardWhere = h('ol', { class: 'where' }, ...whereRows(whereHeard(cfg, { dictation })));
  const saidWhere = h('ol', { class: 'where' });
  /** Saves a voice setting and works out the voice again. @param {Record<string, any>} change */
  const save = async (change) => {
    await updateAppSettings(ctx.ws, { voice: change });
    await voice.refresh();
  };
  const modeStatus = h('p', { class: 'sub', role: 'status', text: voice.on ? 'Voice is on.' : 'Voice is off.' });
  const mode = savedRadios('Voice', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], s.mode, async (m) => {
    // A choice here teaches Auto, as one on the chip does (spec §10.5).
    await voice.choose(m);
    modeStatus.textContent = voice.on ? 'Voice is on.' : 'Voice is off.';
  });
  const silence = h('input', { id: 'voice-silence', type: 'number', min: '2', max: '60', step: '1', value: String(s.silenceSeconds) });
  const firstWords = h('input', { id: 'voice-first-words', type: 'number', min: '5', max: '120', step: '1', value: String(s.firstWordsSeconds) });
  const clips = savedCheck('Keep voice clips', s.keepClips, (on) => save({ keepClips: on }));
  // Koe live (K5): where a live session's audio goes, said plainly; its quiet spell, and whether speaking cuts her off.
  const live = [...new Set(KOE_ROLES.flatMap((r) => cfg.roles[r]?.models ?? []).filter((/** @type {string} */ id) => abilityOf(cfg, id)?.kind === 'realtime')
    .map((/** @type {string} */ id) => providerOf(cfg.providers[cfg.models[id].provider]).name))];
  const closeAfter = h('input', { id: 'voice-close-after', type: 'number', min: '10', max: '300', step: '1', value: String(s.closeAfterSeconds) });
  const bargeIn = savedCheck('Cut her off by speaking', s.bargeIn, (on) => save({ bargeIn: on }));

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
  // Her voice's row says whether the voice picked speaks on this phone (spec §11.7).
  const drawSaid = () => saidWhere.replaceChildren(...whereRows(whereSaid(cfg, { browser: Boolean(synth?.available()), voice: voice.browserVoice(pick.value) })));
  const fill = () => {
    const chosen = pick.value || s.browserVoice;
    pick.replaceChildren(h('option', { value: '', text: 'Automatic: one on this phone when there is one' }),
      ...(synth?.voices() ?? []).map((/** @type {any} */ v) => h('option', { value: v.id, text: `${v.name} (${v.lang}${v.local ? '' : ', online'})` })));
    pick.value = chosen;
    drawSaid();
  };
  fill();
  pick.addEventListener('change', drawSaid);
  // The browser loads its voices a moment after the page opens.
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', fill, { once: true });
  const rate = h('input', { id: 'voice-rate', type: 'number', min: '0.5', max: '2', step: '0.1', value: String(s.rate) });
  const pause = h('input', { id: 'voice-pause', type: 'number', min: '300', max: '3000', step: '50', value: String(s.pauseMs) });
  const meter = h('meter', { min: '0', max: '1', value: '0', 'aria-label': 'How loud the microphone hears you' });
  const micStatus = h('p', { class: 'sub', role: 'status' });
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
    section('On or off',
      h('p', { class: 'sub', text: 'Auto: on in the car, with headphones, or when moving fast; off on the phone speaker; and where annai can’t tell, what you chose last time. On: Shiori speaks aloud and listens for your answer. Off: she writes, and you type. The chip on the dock changes it too.' }),
      mode, modeStatus,
      h('div', { class: 'row' },
        savedField('Listen for an answer (seconds)', silence, () => numberIn(silence, 2, 60, 'Listen for 2 to 60 seconds.', { whole: true, need: true }), (n) => save({ silenceSeconds: n })),
        savedField('Wait for her first words (seconds)', firstWords, () => numberIn(firstWords, 5, 120, 'Wait 5 to 120 seconds.', { whole: true, need: true }), (n) => save({ firstWordsSeconds: n })))),
    section("Shiori's voice",
      h('p', { class: 'sub', text: `Voices, tried in order: ${entries.map((/** @type {any} */ e) => e.name).join(', ') || 'none'}.` }),
      h('div', { class: 'acts' }, sayButton), sayStatus),
    section('Browser voice',
      h('p', { class: 'sub', text: synth?.available() ? 'The browser’s own voice. Some of its voices speak on this phone; those marked online send her words to their service.' : 'This browser has no voice of its own.' }),
      h('div', { class: 'row' },
        savedField('Voice', pick, () => pick.value, (v) => save({ browserVoice: v })),
        savedField('Speed (0.5 to 2)', rate, () => numberIn(rate, 0.5, 2, 'The speed goes from 0.5 (slow) to 2 (fast); 1 is normal.', { need: true }), (r) => save({ rate: r })))),
    section('Listening',
      h('p', { class: 'sub', text: 'annai hears that you finished a sentence when you pause. A longer pause lets you think mid-sentence; a shorter one answers sooner.' }),
      savedField('Pause that ends a sentence (ms)', pause, () => numberIn(pause, 300, 3000, 'The pause goes from 300 to 3000 milliseconds; 700 is the usual.', { whole: true, need: true }), (ms) => save({ pauseMs: ms })),
      meter, h('div', { class: 'acts' }, micButton), micStatus,
      clips.el,
      h('p', { class: 'sub', text: 'Off: what the microphone hears is sent to be written down, then let go. On: each clip is kept with the conversation, and in backups.' }),
      h('p', { class: 'sub', text: formats })),
    section('Live voice',
      h('p', { class: 'sub', text: `While a live session is open, what you say goes straight to ${live.join(' or ') || 'the live model\u2019s provider'} as audio, only while someone speaks; the chip says "Listening live". A session opens when you tap Shiori or type, or when a reminder or Kokoro's note needs saying, and closes after the quiet below, when voice goes off, or when annai leaves the screen.${live.length ? '' : ' Put a live voice model, such as Gemini Live, in Koe for talking (Settings → Models) to use one.'}` }),
      savedField('Close a live session after (seconds of quiet)', closeAfter, () => numberIn(closeAfter, 10, 300, 'Close after 10 to 300 seconds of quiet.', { whole: true, need: true }), (n) => save({ closeAfterSeconds: n })),
      bargeIn.el,
      h('p', { class: 'sub', text: 'Off: only a tap cuts her off, for a car whose speakers echo her voice back.' })),
    section('Where your voice goes',
      h('p', { class: 'sub' }, 'What you say goes to the first of these that can hear it; what she says, to the first voice that works. To change the order, go to ', h('a', { href: '#/models' }, 'Settings → Models'), '.'),
      h('h3', { class: 'section', text: 'What you say' }), heardWhere,
      // A page can't start keyboard dictation, but what it types arrives as a typed message.
      h('p', { class: 'sub', text: "To keep your voice on the phone, type with your keyboard's microphone key: iPhone and most Android keyboards can dictate on the phone itself." }),
      h('h3', { class: 'section', text: 'What she says' }), saidWhere));
}
