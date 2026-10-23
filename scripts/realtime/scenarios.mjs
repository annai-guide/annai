// The conversations a realtime check runs, one realtime session each (the harness opens at most one more for a key that
// is out of quota). A step is one of:
//   { say: clip, gainDb? }          the clip plays into the microphone now
//   { answered: ms }                waits for her answer (a turnComplete after the last clip) to be heard out, and ms more
//   { sounding: ms }                waits until she sounds, then ms more (to speak over her)
//   { wait: ms }                    waits
// route: the audio the microphone stands for (speaker: the phone's own, half-duplex; headphones: she can be cut by speaking);
// echoDb: her voice mixed back into the microphone at that level (the phone's speaker), null for none.
/** @typedef {{ say: string, gainDb?: number } | { answered: number } | { sounding: number } | { wait: number }} Step */
/** @typedef {{ about: string, route: 'speaker' | 'headphones' | 'car', echoDb: number | null, echoDelayMs?: number, expectCut?: boolean, extra?: boolean, languages?: { spoken: string[], answer: string }, steps: Step[] }} Scenario
 *   extra: not in a plain run, only by name (--only); languages (phase 2): the languages setting the run sets in Settings → Shiori before she listens (the browser's
 *   English is the list's first; the others are added), and the scenario is held to answering in the language each clip is spoken in */

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
  'echo-late': {
    about: 'a late echo (a slow speaker, a car): her voice back into the microphone at -6 dB, 400 ms late, two questions',
    route: 'speaker', echoDb: -6, echoDelayMs: 400, extra: true,
    steps: [{ say: 'lunch' }, { answered: 1500 }, { say: 'bixby' }, { answered: 1500 }],
  },
};
