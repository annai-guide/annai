import { h, crumb, linkIn, t, tc, settled, savedField, savedRadios, savedCheck, numberIn } from '../dom.js';
import { seconds, numField, list, sentences, speaksScreens } from '../format.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { shownSettings } from '../../core/shown.js';
import { voiceSettings } from '../../core/voice/settings.js';
import { modelOf, abilityOf, providerOf, KOE_REALTIME } from '../../core/llm/config.js';
import { sample, speechProblem } from '../speech-check.js';
import { withoutSecrets } from '../../core/agent/net.js';
import { whereHeard, whereSaid } from '../../core/voice/where.js';

/** A voice's name as the speaker gives it, the browser's own in the screens' words. @param {string} name */
const voiceName = (name) => (name === /* en */ 'Browser voice' ? t`Browser voice` : name);

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
  const app = await readAppSettings(ctx.ws);
  const s = voiceSettings(app);
  const entries = await voice.outEntries();
  const synth = voice.platform?.synth;
  const cfg = await ctx.llm.config();
  const dictation = { available: Boolean(voice.platform?.dictation.available()), local: await voice.dictationLocal() };
  // What this phone makes and plays (spec §10.6), for the device checks.
  const records = (voice.platform?.encoder?.records?.() ?? []).map((/** @type {any} */ r) => r.format);
  // The formats' names are codes, a developer's words.
  const [made, played] = [list(await voice.makes(), 'plain'), list(voice.plays(), 'plain')];
  const formats = records.length
    ? t`Speech leaves this phone in the smallest format each service takes. Made here: ${made} (recorded: ${list(records, 'plain')}). Played here: ${played}.`
    : t`Speech leaves this phone in the smallest format each service takes. Made here: ${made}. Played here: ${played}.`;
  /** Where your voice goes (spec §11.7), one entry a row. @param {import('../../core/voice/where.js').Where[]} rows */
  const whereRows = (rows) => rows.map((r) => h('li', {}, h('strong', { text: r.name }), h('p', { class: 'sub', text: r.where })));
  const heardWhere = h('ol', { class: 'where' }, ...whereRows(whereHeard(cfg, { dictation })));
  const saidWhere = h('ol', { class: 'where' });
  /** Saves a voice setting and works out the voice again. @param {Record<string, any>} change */
  const save = async (change) => {
    await updateAppSettings(ctx.ws, { voice: change });
    await voice.refresh();
  };
  const modeStatus = h('p', { class: 'sub', role: 'status', text: voice.on ? t`Voice is on.` : t`Voice is off.` });
  const mode = savedRadios(tc('voice mode')`Voice`, [['auto', t`Auto`], ['on', t`On`], ['off', t`Off`]], s.mode, async (m) => {
    // A choice here teaches Auto, as one on the chip does (spec §10.5).
    await voice.choose(m);
    modeStatus.textContent = voice.on ? t`Voice is on.` : t`Voice is off.`;
  });
  const silence = h('input', { id: 'voice-silence', inputmode: 'numeric', value: numField(s.silenceSeconds) });
  const firstWords = h('input', { id: 'voice-first-words', inputmode: 'numeric', value: numField(s.firstWordsSeconds) });
  // What she says shows on the screen unless switched off here (the user, 2026-10-23); it lives with the Shiori settings.
  const showWords = savedCheck(t`Show what she says`, shownSettings(app).showWords, (on) => updateAppSettings(ctx.ws, { shiori: { showWords: on } }));
  const clips = savedCheck(t`Keep voice clips`, s.keepClips, (on) => save({ keepClips: on }));
  // Koe live (K5): where a live session's audio goes, said plainly; its quiet spell, and whether speaking cuts her off.
  const live = [...new Set((cfg.roles[KOE_REALTIME]?.models ?? []).filter((/** @type {string} */ id) => abilityOf(cfg, id)?.kind === 'realtime')
    .map((/** @type {string} */ id) => providerOf(cfg.providers[cfg.models[id].provider]).name))];
  const closeAfter = h('input', { id: 'voice-close-after', inputmode: 'numeric', value: numField(s.closeAfterSeconds) });
  const bargeIn = savedCheck(t`Cut her off by speaking`, s.bargeIn, (on) => save({ bargeIn: on }));

  const sayStatus = h('p', { class: 'sub', role: 'status' });
  const sayButton = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      voice.unlock(); // inside the tap, before any await: an iPhone plays sound only from a tap (spec §10.1)
      sayButton.disabled = true;
      sayStatus.textContent = t`Speaking…`;
      await settled(); // the speed or pause just typed is saved first
      try {
        const r = await voice.say(sample(speaksScreens(await readAppSettings(ctx.ws))));
        sayStatus.textContent = r.failed === 'blocked' ? t`This browser didn't let annai play sound yet. Tap anywhere on the page, then try again.`
          : r.failed ? t`No voice could speak. The Trace shows what each voice answered; check them in Settings → Models.`
            // A provider's own words may hold a key (spec §9.9), as in a model's Test.
            : await withoutSecrets(ctx.store, sentences(...r.failedVoices.map((/** @type {any} */ f) => t`${voiceName(f.name)} couldn't speak: ${speechProblem(f.error)}`),
              r.voices.length ? t`Spoken by ${r.voices.map(voiceName).reduce((/** @type {string} */ a, /** @type {string} */ b) => tc('one voice, then the next')`${a}, then ${b}`)}.` : ''));
      } catch (e) {
        sayStatus.textContent = speechProblem(e);
      } finally {
        sayButton.disabled = false;
      }
    },
  }, t`Test the voice`);

  const pick = h('select', { id: 'voice-browser' });
  // Her voice's row says whether the voice picked speaks on this phone (spec §11.7).
  const drawSaid = () => saidWhere.replaceChildren(...whereRows(whereSaid(cfg, { browser: Boolean(synth?.available()), voice: voice.browserVoice(pick.value) })));
  const fill = () => {
    const chosen = pick.value || s.browserVoice;
    pick.replaceChildren(h('option', { value: '', text: t`Automatic: one on this phone when there is one` }),
      ...(synth?.voices() ?? []).map((/** @type {any} */ v) => h('option', { value: v.id, text: v.local ? t`${v.name} (${v.lang})` : t`${v.name} (${v.lang}, online)` })));
    pick.value = chosen;
    drawSaid();
  };
  fill();
  pick.addEventListener('change', drawSaid);
  // The browser loads its voices a moment after the page opens.
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', fill, { once: true });
  const rate = h('input', { id: 'voice-rate', inputmode: 'decimal', value: numField(s.rate) });
  const pause = h('input', { id: 'voice-pause', inputmode: 'numeric', value: numField(s.pauseMs) });
  const meter = h('meter', { min: '0', max: '1', value: '0', 'aria-label': t`How loud the microphone hears you` });
  const micStatus = h('p', { class: 'sub', role: 'status' });
  const micButton = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      micButton.disabled = true;
      micStatus.textContent = t`Say something…`;
      await settled();
      const off = voice.onLevel((/** @type {number} */ x, /** @type {string} */ who) => { if (who === 'you') meter.value = x; });
      try {
        const seg = await voice.listenOnce({ seconds: 15, onSpeech: () => { micStatus.textContent = t`Hearing you…`; } });
        if (!seg) {
          micStatus.textContent = t`Nothing was heard in 15 seconds. Check that the microphone is on and that no other app is using it, then try again.`;
          return;
        }
        const lines = [t`Heard ${seconds(seg.ms, 'long')} of speech.`];
        const [first] = await voice.transcribers();
        if (first) {
          micStatus.textContent = sentences(lines[0], t`Writing it down…`);
          const text = await voice.transcribe(seg, first);
          const rec = (await ctx.llm.config()).models[first];
          const name = rec ? modelOf(rec).name : first;
          lines.push(text ? t`${name} heard: "${text}"` : t`${name} heard speech but wrote nothing down.`);
        } else {
          lines.push(t`Add a transcription model in Settings → Models to see the words.`);
        }
        micStatus.textContent = sentences(...lines);
      } catch (e) {
        micStatus.textContent = speechProblem(e);
      } finally {
        off();
        meter.value = 0;
        micButton.disabled = false;
      }
    },
  }, t`Test the microphone`);

  const models = t`Settings → Models`;
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/settings', t`Settings`)),
    h('h1', { class: 'title', text: tc('screen')`Voice` }),
    h('p', { class: 'sub', text: t`How Shiori speaks and hears you. Which voices and which transcription models she uses, and in what order, is in Settings → Models.` }),
    section(t`On or off`,
      h('p', { class: 'sub', text: t`Auto: on in the car, with headphones, or when moving fast; off on the phone speaker; and where annai can’t tell, what you chose last time. On: Shiori speaks aloud and listens for your answer. Off: she writes, and you type. The chip on the dock changes it too.` }),
      mode, modeStatus,
      h('div', { class: 'row' },
        savedField(t`Listen for an answer (seconds)`, silence, () => numberIn(silence, 2, 60, t`Listen for 2 to 60 seconds.`, { whole: true, need: true }), (n) => save({ silenceSeconds: n })),
        savedField(t`Wait for her first words (seconds)`, firstWords, () => numberIn(firstWords, 5, 120, t`Wait 5 to 120 seconds.`, { whole: true, need: true }), (n) => save({ firstWordsSeconds: n })))),
    section(t`On the screen`,
      showWords.el,
      h('p', { class: 'sub', text: t`On: the words of what she says aloud show in the conversation, marked "said aloud", and in a bubble above her while she speaks. Off: a quiet screen. Her spoken lines fold away in the conversation until you tap "Show what she said".` })),
    section(t`Shiori's voice`,
      h('p', { class: 'sub', text: entries.length ? t`Voices, tried in order: ${list(entries.map((/** @type {any} */ e) => (e.kind === 'browser' ? t`Browser voice` : e.name)), 'plain')}.` : t`Voices, tried in order: none.` }),
      h('div', { class: 'acts' }, sayButton), sayStatus),
    section(t`Browser voice`,
      h('p', { class: 'sub', text: synth?.available() ? t`The browser’s own voice. Some of its voices speak on this phone; those marked online send her words to their service.` : t`This browser has no voice of its own.` }),
      h('div', { class: 'row' },
        savedField(t`Voice`, pick, () => pick.value, (v) => save({ browserVoice: v })),
        savedField(t`Speed (0.5 to 2)`, rate, () => numberIn(rate, 0.5, 2, t`The speed goes from 0.5 (slow) to 2 (fast); 1 is normal.`, { need: true }), (r) => save({ rate: r })))),
    section(tc('section')`Listening`,
      h('p', { class: 'sub', text: t`annai hears that you finished a sentence when you pause. A longer pause lets you think mid-sentence; a shorter one answers sooner.` }),
      savedField(t`Pause that ends a sentence (ms)`, pause, () => numberIn(pause, 300, 3000, t`The pause goes from 300 to 3000 milliseconds; 700 is the usual.`, { whole: true, need: true }), (ms) => save({ pauseMs: ms })),
      meter, h('div', { class: 'acts' }, micButton), micStatus,
      clips.el,
      h('p', { class: 'sub', text: t`Off: what the microphone hears is sent to be written down, then let go. On: each clip is kept with the conversation, and in backups.` }),
      h('p', { class: 'sub', text: formats })),
    section(t`Live voice`,
      h('p', { class: 'sub', text: live.length
        ? t`While a live session listens, what you say goes straight to ${list(live, 'or')} as audio, only while someone speaks, and the chip says "Listening live". It closes after the quiet below, on voice off, or when annai leaves the screen.`
        : t`While a live session listens, what you say goes straight to its provider as audio, only while someone speaks, and the chip says "Listening live". It closes after the quiet below, on voice off, or when annai leaves the screen.` }),
      savedField(t`Close a live session after (seconds of quiet)`, closeAfter, () => numberIn(closeAfter, 10, 300, t`Close after 10 to 300 seconds of quiet.`, { whole: true, need: true }), (n) => save({ closeAfterSeconds: n })),
      bargeIn.el,
      h('p', { class: 'sub', text: t`Only with headphones or car audio: on the phone's own speaker the microphone hears her, so there only a tap cuts her off. Off: only a tap, everywhere, for a car whose speakers echo her voice back.` })),
    section(t`Where your voice goes`,
      h('p', { class: 'sub' }, ...linkIn(t`What you say goes to the first of these that can hear it; what she says, to the first voice that works. To change the order, go to ${models}.`, h('a', { href: '#/models' }, models))),
      h('h3', { class: 'section', text: t`What you say` }), heardWhere,
      // A page can't start keyboard dictation, but what it types arrives as a typed message.
      h('p', { class: 'sub', text: t`To keep your voice on the phone, type with your keyboard's microphone key: iPhone and most Android keyboards can dictate on the phone itself.` }),
      h('h3', { class: 'section', text: t`What she says` }), saidWhere));
}
