// The conversations a realtime check runs, one realtime session each (the harness opens at most one more for a key that
// is out of quota). A step is one of:
//   { say: clip, gainDb? }          the clip plays into the microphone now
//   { answered: ms }                waits for her answer (a turnComplete after the last clip) to be heard out, and ms more
//   { sounding: ms }                waits until she sounds, then ms more (to speak over her)
//   { wait: ms }                    waits
// stage 5's card (card: true; read_trip; the stand-in Kokoro reads Testville for a question that names it):
//   { ask: ms }                     waits (at most ms) for annai's own card: an out.ask of its own
//   { asked: ms }                   waits until its question has been said (the page's player ended), and ms more; { asking: ms }: until it begins
//   { tap: label, afterHeard?: ms } taps that button on the card (afterHeard: ms after annai has the next heard line's words, at most 15 s)
//   { settled: ms }                 waits until read_trip's result is in, and annai and her sound have been quiet for ms
//   { shiori: true }                a tap on Shiori (classic voice: asleep, she hears nothing until tapped)
//   { type: line, lines?: n }       types the line in the box under the conversation and sends it (lines: the most lines of hers it may get, checked)
// a note being said (noteCut):
//   { noteSounding: ms }            waits until a note from Kokoro has gone in and her voice began after it, then ms more
// mode: 'classic' runs the same card in classic voice (no live session): speech in is the user's own server, the gate Gemini's small model, Kokoro alone.
// speechIn: 'default' (classic and chat): no transcription model, the speech-in list annai starts with (send audio, then phone dictation): no speech server is
// added, and the two that adding Gemini put last (Gemini 3.5 Transcribe, Gemini 3.5 Flash Lite (transcription)) are taken out.
// route: the audio the microphone stands for (speaker: the phone's own, half-duplex; headphones: she can be cut by speaking);
// echoDb: her voice mixed back into the microphone at that level (the phone's speaker), null for none.
/** @typedef {{ say: string, gainDb?: number } | { answered: number } | { sounding: number } | { wait: number } | { ask: number } | { asked: number } | { asking: number } | { tap: string, afterHeard?: number } | { settled: number } | { shiori: true } | { type: string, lines?: number } | { noteSounding: number }} Step */
/** @typedef {{ about: string, route: 'speaker' | 'headphones' | 'car', echoDb: number | null, echoDelayMs?: number, expectCut?: boolean, extra?: boolean, repeatNote?: boolean, card?: boolean, measure?: boolean, real?: boolean, mode?: 'live' | 'classic' | 'chat', speechIn?: 'default', asrDelayMs?: number, expect?: { grant: 'voice' | 'tap' | false | 'any', words?: boolean, open?: boolean, next?: boolean, declined?: boolean }, languages?: { spoken: string[], answer: string }, passOn?: boolean, acks?: string[], noteCut?: boolean, steps: Step[] }} Scenario
 *   repeatNote: the stand-in Kokoro sends its note again once Koe has said it; extra: not in a plain run, only by name (--only); languages (phase 2): the languages setting the run sets in Settings → Shiori before she listens (the browser's
 *   English is the list's first; the others are added), and the scenario is held to answering in the language each clip is spoken in; passOn: every line said is
 *   one Koe passes on (the checks "passed on" and "passed on as said"); acks: the clips that are only acknowledgements here (the check "acknowledgements left
 *   quiet"); noteCut: a noise cuts a note as she says it (the check "cut note said again") */

/** @type {Record<string, Scenario>} */
export const SCENARIOS = {
  'questions-a': {
    about: 'three questions in a row on the phone speaker, the room quiet',
    route: 'speaker', echoDb: null,
    steps: [{ say: 'lunch' }, { answered: 600 }, { say: 'bixby' }, { answered: 600 }, { say: 'gas' }, { answered: 600 }],
  },
  'questions-b': {
    about: 'three more questions, the same way',
    route: 'speaker', echoDb: null,
    steps: [{ say: 'beach' }, { answered: 600 }, { say: 'sunset' }, { answered: 600 }, { say: 'hike' }, { answered: 600 }, { say: 'restroom' }, { answered: 600 }],
  },
  'quick-yes': {
    about: 'a question, then a quick "yes" 150 ms after she stops, as a reply to what she asked',
    route: 'speaker', echoDb: null,
    steps: [{ say: 'lunch' }, { answered: 150 }, { say: 'yes' }, { answered: 600 }],
  },
  'pause': {
    about: 'a sentence with a 1.5 s thinking pause inside it, then a question',
    route: 'speaker', echoDb: null,
    steps: [{ say: 'pause' }, { answered: 600 }, { say: 'bixby' }, { answered: 600 }],
  },
  'long': {
    about: 'one long question (about 13 s)',
    route: 'speaker', echoDb: null,
    steps: [{ say: 'long' }, { answered: 600 }],
  },
  'silence': {
    about: 'a quiet room for 22 s (nothing should be sent, nothing should fail), then a question',
    route: 'speaker', echoDb: null,
    steps: [{ say: 'silence' }, { wait: 14_000 }, { say: 'lunch' }, { answered: 600 }],
  },
  'echo-quiet': {
    about: 'the phone speaker heard by its own microphone at -12 dB, 60 ms late: two questions',
    route: 'speaker', echoDb: -12, echoDelayMs: 60,
    steps: [{ say: 'lunch' }, { answered: 1500 }, { say: 'bixby' }, { answered: 1500 }],
  },
  'echo-loud': {
    about: 'the phone speaker heard by its own microphone as loud as it plays (0 dB), 60 ms late: two questions',
    route: 'speaker', echoDb: 0, echoDelayMs: 60,
    steps: [{ say: 'lunch' }, { answered: 1500 }, { say: 'bixby' }, { answered: 1500 }],
  },
  'barge-in': {
    about: 'headphones: the user speaks over her answer, which should be cut, and the new question answered',
    route: 'headphones', echoDb: null, expectCut: true,
    steps: [{ say: 'hike' }, { sounding: 1200 }, { say: 'beach' }, { answered: 600 }],
  },
  'talk-over': {
    about: 'the phone speaker: the user speaks over her answer, which annai does not hear by design; then a question once she is done',
    route: 'speaker', echoDb: null,
    steps: [{ say: 'hike' }, { sounding: 1200 }, { say: 'beach' }, { answered: 2500 }, { say: 'bixby' }, { answered: 600 }],
  },
  'short-replies': {
    about: 'the languages setting English: a question, then five short replies ("Yes.", "Sure.", "What?", "Alright.", "No."), each after her answer; each should be heard and answered in English (on 2026-10-22 such replies came back as "¿Qué?" and "chưa", answered in Spanish)',
    route: 'speaker', echoDb: null, extra: true, languages: { spoken: ['en'], answer: 'follow' },
    steps: [{ say: 'lunch' }, { answered: 600 }, { say: 'yes' }, { answered: 600 }, { say: 'sure' }, { answered: 600 }, { say: 'what' }, { answered: 600 }, { say: 'alright' }, { answered: 600 }, { say: 'no' }, { answered: 600 }],
  },
  'multilingual': {
    about: 'the languages setting English, Chinese and Japanese: a Japanese sentence, a Chinese one and an English question, each after her answer; each should be answered in kind',
    route: 'speaker', echoDb: null, extra: true, languages: { spoken: ['en', 'zh', 'ja'], answer: 'follow' },
    steps: [{ say: 'ja' }, { answered: 600 }, { say: 'zh' }, { answered: 600 }, { say: 'lunch' }, { answered: 600 }],
  },
  'relay-fact': {
    about: 'Koe is a relay (the second drive): a question about annai and a general fact, neither of which it was told. It should say "One moment." and pass it on to Kokoro, stating neither',
    route: 'speaker', echoDb: null, extra: true,
    steps: [{ say: 'auto-gps' }, { answered: 1500 }, { say: 'built' }, { answered: 1500 }],
  },
  'relay-filler': {
    about: "the filler trap: a question, then being told off for apologising. Silence is right; no apology, no \"I understand\", no \"I'll make sure\", no \"I will stop\", in what she says (the check \"no filler\")",
    route: 'speaker', echoDb: null, extra: true,
    steps: [{ say: 'lunch' }, { answered: 1500 }, { say: 'annoyed' }, { wait: 9000 }],
  },
  'relay-greet': {
    about: "a greeting (\"Good morning, Shiori.\") gets a greeting, and \"What?\" after her answer gets her last words again, without a trip to Kokoro (fix pass 1)",
    route: 'speaker', echoDb: null, extra: true,
    steps: [{ say: 'hello' }, { answered: 1500 }, { say: 'lunch' }, { answered: 1500 }, { say: 'what' }, { answered: 1500 }],
  },
  'relay-stray': {
    about: 'the languages setting English and Japanese: a stray word in Korean and song lyrics, left alone, in English throughout; then a question',
    route: 'speaker', echoDb: null, extra: true, languages: { spoken: ['en', 'ja'], answer: 'follow' },
    steps: [{ say: 'ko-word' }, { wait: 9000 }, { say: 'lyric' }, { wait: 9000 }, { say: 'lunch' }, { answered: 1500 }],
  },
  'relay-unset-ja': {
    about: 'no languages set (the browser\'s English only): a Japanese sentence, which is a language the user may speak, so it is answered, in Japanese (fix pass 2: the stay-silent rule must not catch it)',
    route: 'speaker', echoDb: null, extra: true,
    steps: [{ say: 'ja' }, { answered: 1500 }],
  },
  'relay-note': {
    about: "a note it must say, then Kokoro's same note again (item 11): the first is said with nothing added, the second settled with already_told",
    route: 'speaker', echoDb: null, extra: true, repeatNote: true,
    steps: [{ say: 'bixby' }, { answered: 1500 }, { wait: 12_000 }],
  },
  'echo-late': {
    about: 'a late echo (a slow speaker, a car): her voice back into the microphone at -6 dB, 400 ms late, two questions',
    route: 'speaker', echoDb: -6, echoDelayMs: 400, extra: true,
    steps: [{ say: 'lunch' }, { answered: 1500 }, { say: 'bixby' }, { answered: 1500 }],
  },
  ...relayScenarios(),
  ...cardScenarios(),
  ...classicScenarios(),
  ...realScenarios(),
  ...lineScenarios(),
};

/**
 * One answer, and the right half's: Koe passes on what it can't answer, as said, and asks nothing of its own; an acknowledgement gets no reply; a note cut
 * as she says it is said again from its start; and a typed line in live voice gets one answer. By name only; the pass bars are in docs/testing/realtime-check.md.
 * @returns {Record<string, Scenario>}
 */
function relayScenarios() {
  /** Each line, her answer heard out (with Kokoro's note), and 1.5 s more. @param {string[]} clips @returns {Step[]} */
  const each = (clips) => clips.flatMap((c) => [{ say: c }, { answered: 1500 }]);
  /** Ten questions, each answered (her note said), then an acknowledgement, "Sure." or "Alright." in turn; 8 s for a reply to it: Koe's own live answers in a
   * recorded drive came 2.6 to 5.8 s after the user's turn ended. @type {Step[]} */
  const acked = ['lunch', 'bixby', 'gas', 'beach', 'sunset', 'hike', 'restroom', 'built', 'tomorrow', 'favour'].flatMap((q, i) => [{ say: q }, { answered: 1500 }, { say: i % 2 ? 'alright' : 'sure' }, { wait: 8000 }]);
  /** A typed greeting, then a typed request, each with the most lines of hers it needs (the greeting one, Koe's; the request two: Koe's "One moment." and the
   * result), and 90 s after each for a note that comes late: a note from Gemini's chat model on a free key took 30 to 80 s. @type {Step[]} */
  const typed = [
    { type: 'Hello?', lines: 1 }, { answered: 1500 }, { wait: 90_000 },
    { type: 'Add to my notes that we parked on level three.', lines: 2 }, { answered: 1500 }, { wait: 90_000 },
  ];
  const speaker = /** @type {const} */ ({ route: 'speaker', echoDb: null, extra: true });
  return {
    'relay-pass': { ...speaker, passOn: true, about: "five requests Koe could ask the user about or say it can't do, whose answer is Kokoro's: each passed on (tell_kokoro), no question back, as said", steps: each(['do-all', 'carry-on', 'second-one', 'note-parking', 'plan-beach']) },
    'relay-annai': { ...speaker, passOn: true, about: "five questions about annai Koe can't know: each passed on (tell_kokoro), no question back, as said", steps: each(['auto-gps', 'why-quiet', 'app-louder', 'app-offline', 'app-new']) },
    'relay-ack': { ...speaker, acks: ['sure', 'alright'], about: 'ten questions, each answered, then "Sure." or "Alright.": no acknowledgement gets a reply with sound', steps: acked },
    'cut-note': { route: 'headphones', echoDb: null, extra: true, expectCut: true, noteCut: true, about: "headphones: a question, then a noise 100 ms into Kokoro's note as she says it: annai asks for it again once, and she says it again from its start", steps: [{ say: 'bixby' }, { noteSounding: 100 }, { say: 'bump' }, { answered: 1500 }] },
    'typed-live': { ...speaker, about: "live voice, typed: a greeting gets one line, Koe's, and a request two (\"One moment.\" and the result); with a real Kokoro (--kokoro gemini) it shows whether she adds a line to Koe's answer", steps: typed },
    'real-typed-live': { ...speaker, real: true, about: "a real Kokoro (Opus 5.5), live voice, typed: a greeting gets one line, Koe's, and a request two (\"One moment.\" and the result)", steps: typed },
  };
}

/**
 * Stage 5's card with real speech (Koe talking): the user asks about Testville, the stand-in Kokoro has Shiori call read_trip, annai's card goes up and its
 * question is said by a stand-in voice, and the scenario answers it. Each is by name only (--only card-yes,...). "Testville dated this week, the Always setting off."
 * @returns {Record<string, Scenario>}
 */
function cardScenarios() {
  /** The user's line, and annai's card up with its question said (ms: the wait after it, before the answer). @param {number} [ms] @returns {Step[]} */
  const go = (ms = 1000) => [{ say: 'tomorrow' }, { ask: 70_000 }, { asked: ms }];
  /** @param {string} about @param {Step[]} steps @param {Partial<Scenario>} [more] @returns {Scenario} */
  const card = (about, steps, more = {}) => ({ about, route: 'speaker', echoDb: null, extra: true, card: true, steps, ...more });
  /** @param {string} clip @param {string} what @param {Scenario['expect']} expect @returns {Scenario} */
  const alone = (clip, what, expect) => card(`the card, then ${what} (${clip}) alone`, [...go(), { say: clip }, { settled: 2500 }], { expect });
  const yes = /** @type {const} */ ({ grant: 'voice' });
  const no = /** @type {const} */ ({ grant: false, words: true });
  /** A spoken no (the voice-yes rule's no list): the card ends as Not now would; its words are the card's answer, as a tap's are. */
  const declined = /** @type {const} */ ({ grant: false, declined: true });
  return {
    'card-yes': alone('yes', '"Yes."', yes),
    'card-sure': alone('sure', '"Sure."', yes),
    'card-hai': alone('hai', '"はい。"', yes),
    'card-hao': alone('hao', '"好的。"', yes),
    'card-yes-but': alone('yes-but', '"Yes, but not that one. The Osaka trip."', no),
    'card-no-thanks': card('the card, "No thanks." (declines, as Not now), then a question that needs Kokoro (no card, no tap)', [...go(), { say: 'no-thanks' }, { settled: 2500 }, { say: 'bixby' }, { answered: 800 }], { expect: { ...declined, next: true } }),
    'card-yes-nowait': card('"Yes.", 1.3 s after its end "No, wait." (the newest listed word decides: declined)', [...go(), { say: 'yes' }, { wait: 840 + 1300 }, { say: 'no-wait' }, { settled: 2500 }], { expect: declined }),
    // The final review's F1: a take-back still being said when the settle would end (3.4 s, begun 1.3 s after the yes): the yes waits while they speak, their words drop it.
    'card-yes-longback': card('"Yes.", 1.3 s after its end "Yes, but not that one. The Osaka trip." (3.4 s: still being said when the settle would end)', [...go(), { say: 'yes' }, { wait: 840 + 1300 }, { say: 'yes-but' }, { settled: 2500 }], { expect: { grant: false, open: true } }),
    'card-no-yes': card('"No.", 1.3 s after its end "Yes." (the newest listed word decides: yes)', [...go(), { say: 'no' }, { wait: 600 + 1300 }, { say: 'yes' }, { settled: 2500 }], { expect: yes }),
    // The same with the languages setting a Japanese or Chinese speaker has (English, and the other): Gemini Live is given the language codes with the setup.
    'card-hai-ja': { ...alone('hai', '"はい。" with Japanese in Languages', yes), languages: { spoken: ['en', 'ja'], answer: 'follow' } },
    'card-hai-q-ja': { ...alone('hai-q', '"はい？" said as a question, with Japanese in Languages', no), languages: { spoken: ['en', 'ja'], answer: 'follow' } },
    'card-hao-zh': { ...alone('hao', '"好的。" with Chinese in Languages', yes), languages: { spoken: ['en', 'zh'], answer: 'follow' } },
    'card-mm-q-zh': { ...alone('mm-q', '"嗯？" said as a question (嗯 is on neither list), with Chinese in Languages', no), languages: { spoken: ['en', 'zh'], answer: 'follow' } },
    // A known gap, a question for the user: neither Gemini nor the speech-to-text writes a rising "Yes?" with its mark, so it is written "Yes." and grants.
    'card-yes-q': alone('yes-q', '"Yes?" said as a question (known gap: written "Yes.", it grants)', yes),
    'card-hai-q': alone('hai-q', '"はい？" said as a question', no),
    'card-mm-q': alone('mm-q', '"嗯？" said as a question (嗯 is on neither list: also the filled pause)', no),
    'card-what': alone('what', '"What?"', no),
    'card-passenger': card('the card, a passenger\'s line ("Turn left at the next light."), then "Yes." 4.5 s after it began', [...go(), { say: 'passenger' }, { wait: 4500 }, { say: 'yes' }, { settled: 2500 }], { expect: yes }),
    'card-lyric': card('the card, song lyrics (lyric.wav), then "Yes." 9 s after they began', [...go(), { say: 'lyric' }, { wait: 9000 }, { say: 'yes' }, { settled: 2500 }], { expect: yes }),
    'card-late-18': card('"Yes." begun 18 s after the question was said (judged by when it began)', [...go(18_000), { say: 'yes' }, { settled: 2500 }], { expect: yes }),
    // Outside the window it arms nothing: kept by Koe it ends the card unanswered, set aside it leaves the card waiting (a tap's). Either is right.
    'card-late-22': card('"Yes." begun 22 s after the question was said', [...go(22_000), { say: 'yes' }, { settled: 2500 }], { expect: { grant: false, open: true } }),
    'card-tap-settling': card('a spoken "No, wait." is settling; a tap on Allow 1 s after annai has its words (the tap wins)', [...go(), { say: 'no-wait' }, { tap: 'Allow', afterHeard: 1000 }, { settled: 2500 }], { expect: { grant: 'tap' } }),
    'card-tap-not-now': card('a spoken "Yes.", and a tap on Not now 1.5 s after annai has its words (the tap wins)', [...go(), { say: 'yes' }, { tap: 'Not now', afterHeard: 1500 }, { settled: 2500 }], { expect: { grant: false } }),
    'card-over': card('"Yes." begun 2 s into annai\'s question, which it ends 0.7 s before', [{ say: 'tomorrow' }, { ask: 70_000 }, { asking: 2000 }, { say: 'yes' }, { settled: 2500 }], { expect: { grant: 'any', open: true } }),
    'card-over-headphones': card('headphones (annai hears while she speaks): "Yes." begun 2 s into annai\'s question', [{ say: 'tomorrow' }, { ask: 70_000 }, { asking: 2000 }, { say: 'yes' }, { settled: 2500 }], { route: 'headphones', expect: { grant: 'any', open: true } }),
    'card-echo-loud': card("the card with her voice back into the microphone at 0 dB, 60 ms late: nobody answers (does the question, or Koe's own words, grant?)", [{ say: 'favour' }, { ask: 70_000 }, { asked: 25_000 }, { wait: 4000 }], { echoDb: 0, echoDelayMs: 60, expect: { grant: false, open: true } }),
    'card-echo-quiet': card('the same at -12 dB', [{ say: 'favour' }, { ask: 70_000 }, { asked: 25_000 }, { wait: 4000 }], { echoDb: -12, echoDelayMs: 60, expect: { grant: false, open: true } }),
    // A car's hands-free: annai hears while she speaks (full duplex), and her voice comes back 400 ms late at -6 dB. Her own question may be heard as the user's line.
    'card-echo-car': card("a car's hands-free (annai hears while she speaks), her voice back at -6 dB, 400 ms late: nobody answers (is her own question heard as a line, and does it end the card?)", [{ say: 'favour' }, { ask: 70_000 }, { asked: 25_000 }, { wait: 4000 }], { route: 'car', echoDb: -6, echoDelayMs: 400, expect: { grant: false, open: true } }),
    'card-echo-car-yes': card('the same, and the user says "Yes." as the question ends', [{ say: 'favour' }, { ask: 70_000 }, { asked: 600 }, { say: 'yes' }, { settled: 2500 }], { route: 'car', echoDb: -6, echoDelayMs: 400, expect: yes }),
    'card-echo-yes': card('echo at 0 dB, and the user says "Yes." as the question ends', [{ say: 'favour' }, { ask: 70_000 }, { asked: 600 }, { say: 'yes' }, { settled: 2500 }], { echoDb: 0, echoDelayMs: 60, expect: yes }),
  };
}

/**
 * Stage 5's card in classic voice (no live session), with the user's own speech-to-text server: the same lines and timings as Koe talking (scenarios 1 to 8 and 10),
 * by name only (classic-yes, ...). Shiori is alone (the stand-in Kokoro is her one model, which reads a trip for a line that names Testville); each listening
 * window is a tap's, so a scenario that goes on after her answer taps Shiori first.
 * @returns {Record<string, Scenario>}
 */
function classicScenarios() {
  const live = cardScenarios();
  /** @type {Record<string, Scenario>} */
  const out = {};
  for (const name of ['yes', 'sure', 'hai', 'hao', 'yes-but', 'no-thanks', 'yes-nowait', 'yes-longback', 'no-yes', 'yes-q', 'hai-q', 'mm-q', 'what', 'passenger', 'lyric', 'late-18', 'late-22', 'tap-settling', 'tap-not-now']) {
    const sc = live[`card-${name}`];
    /** The next question after "No thanks.": Shiori asleep is tapped awake, and the answer is the note said aloud (the stand-in voice's request). @type {Step[]} */
    const steps = name === 'no-thanks'
      ? [...sc.steps.slice(0, -2), { shiori: true }, { say: 'bixby' }, { wait: 9000 }]
      : sc.steps;
    // The window shuts 20 s after the question: a yes begun later has no microphone to be heard by, and the card stays (it is a tap's).
    /** @type {Scenario['expect']} */
    const expect = name === 'late-22' ? { grant: false, open: true } : sc.expect;
    out[`classic-${name}`] = { ...sc, about: `classic voice: ${sc.about}`, mode: 'classic', steps, ...(expect ? { expect } : {}) };
  }
  // The last review's Finding 1, with real speech: each line written down slowly, as a model asked to write it down is (5.7 and 7.0 s measured):
  // the speech server's answer is held 6 s. "Yes." then "No, wait.": the yes waits for the take-back's words, however long, and is declined.
  out['classic-yes-nowait-slow'] = { ...out['classic-yes-nowait'], about: 'classic voice, each line written down 6 s late: "Yes.", 1.3 s after its end "No, wait." (declined, however long the words take)', asrDelayMs: 6000 };
  // The final review's F2: Koe on a chat model (Koe · Live off), classic voice: a "Sure." said to Koe before annai asks, whose entry comes after the
  // question (behind Koe's gate), arms nothing; a second one after the question grants. Koe's microphone is open after the question (a tap would close it).
  out['chat-sure-before'] = {
    ...live['card-yes'], about: 'Koe on a chat model: "Sure." said before annai\'s question arms nothing; "Sure." after it grants', mode: 'chat',
    steps: [{ say: 'tomorrow' }, { wait: 4000 }, { say: 'sure' }, { ask: 70_000 }, { asked: 1500 }, { say: 'sure' }, { settled: 2500 }],
    expect: { grant: 'voice' },
  };
  // The re-review's F3: Koe on a chat model again, with the speech-in list annai starts with (no transcription model). Kokoro's stand-in model takes no audio,
  // so only Koe · Chat's model (Gemini's takes audio) can write Koe's line down for the card: "Sure." after the question grants. With nothing to write
  // a spoken line down for Kokoro, a spoken question never reaches her ("Nothing in the speech-in list can hear it"): the question is typed.
  out['chat-sure-default'] = {
    ...live['card-yes'], about: 'Koe on a chat model, the default speech-in list, Kokoro\'s model taking no audio, the question typed: "Sure." after annai\'s question grants', mode: 'chat', speechIn: 'default',
    steps: [{ type: "What's on tomorrow in Testville?" }, { ask: 70_000 }, { asked: 1500 }, { say: 'sure' }, { settled: 2500 }],
    expect: { grant: 'voice' },
  };
  return out;
}

/**
 * Stage 5's card end to end with a real Kokoro (Claude Opus 5.5 through the Anthropic provider, Claude Haiku 5.5 as the utility model; --anthropic-key), Koe on
 * Gemini Live, the user's line asked aloud ("What's on tomorrow in Testville?"): scenarios 1, 3 and 5. Each is held to 30 model requests. By name only.
 * @returns {Record<string, Scenario>}
 */
function realScenarios() {
  const live = cardScenarios();
  /** @type {Record<string, Scenario>} */
  const out = {};
  for (const name of ['yes', 'yes-but', 'no-thanks']) {
    const sc = live[`card-${name}`];
    /** A real model takes seconds to think: the card is waited for longer, and what follows the card until nothing has happened for 10 s. @type {Step[]} */
    const steps = sc.steps.map((st) => ('ask' in st ? { ask: 120_000 } : 'settled' in st ? { settled: 10_000 } : st));
    const expect = sc.expect ? { ...sc.expect, words: false } : undefined;
    out[`real-${name}`] = { ...sc, about: `a real Kokoro (Opus 5.5): ${sc.about}`, real: true, steps, ...(expect ? { expect } : {}) };
  }
  return out;
}

/**
 * Lines for the lateness measurement (stage 5, Part 1: how late the words of a live line arrive): many short lines in one session, a fixed 7 s apart (no wait for an
 * answer, which some of them never get), in English, Japanese and Chinese. measure: nothing is held to an answer; only errors fail it. By name only. The records are read by `node scripts/realtime-check.mjs lateness`.
 * @returns {Record<string, Scenario>}
 */
function lineScenarios() {
  /** @param {string[]} clips @returns {Step[]} */
  const spaced = (clips) => clips.flatMap((c) => [{ say: c }, { wait: 7000 }]);
  /** @param {string} about @param {string[]} clips @returns {Scenario} */
  const lines = (about, clips) => ({ about, route: 'speaker', echoDb: null, extra: true, measure: true, steps: spaced(clips) });
  return {
    'lines-en': lines('twelve English lines 7 s apart: replies, greetings and questions', ['yes', 'sure', 'no', 'what', 'alright', 'hello', 'lunch', 'bixby', 'no-wait', 'no-thanks', 'yes-q', 'yes-but']),
    'lines-ja': lines('twelve Japanese lines 7 s apart: a sentence, "はい。" and "はい？"', ['ja', 'hai', 'hai-q', 'ja', 'hai', 'hai-q', 'ja', 'hai-q', 'hai', 'ja', 'hai', 'hai-q']),
    'lines-zh': lines('twelve Chinese lines 7 s apart: a sentence, "好的。" and "嗯？"', ['zh', 'hao', 'mm-q', 'zh', 'hao', 'mm-q', 'zh', 'mm-q', 'hao', 'zh', 'hao', 'mm-q']),
  };
}
