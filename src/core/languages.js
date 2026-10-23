/**
 * The languages you speak (phase 2; spec §10.9): the list the setting picks from, the setting read from the app settings, and the
 * words and codes every model that hears or speaks is given, so a short reply is not taken for another language (the user,
 * 2026-10-23). The user-facing words (names, the setting's labels) are all here, for a later pass that localizes the interface.
 * @typedef {{ id: string, name: string, locale: string, iso: string, live: string, google: string | null }} Language
 *   id: annai's; locale: a BCP-47 tag a browser's dictation and voice take; iso: Whisper-style models (ISO 639-1, or -3 where OpenAI
 *   takes it); live: Gemini Live's own code for it; google: Gemini's transcription model's tag (null: it has none)
 * @typedef {{ explicit: boolean, spoken: Language[], answer: Language | null }} LanguageSettings
 *   explicit: the user chose the list (else it is the browser's language); answer: the one language she answers in, null to follow the user
 */

/**
 * id, name, locale, then only what differs: iso (else the id), live (else the id), google (else the locale; null: none). Chinese is
 * Mandarin (Gemini Live: Simplified); Cantonese is its own. A language's name for itself comes from the browser (nativeName).
 * @type {[string, string, string, string?, string?, (string | null)?][]}
 */
const ROWS = [
  ['en', 'English', 'en-US'], ['zh', 'Chinese (Mandarin)', 'zh-CN', 'zh', 'zh-Hans', 'cmn-Hans-CN'], ['yue', 'Cantonese', 'yue-Hant-HK', 'yue', 'zh-Hant'],
  ['ja', 'Japanese', 'ja-JP'], ['ko', 'Korean', 'ko-KR'], ['es', 'Spanish', 'es-ES', 'es', 'es', 'es-419'], ['fr', 'French', 'fr-FR'],
  ['de', 'German', 'de-DE'], ['it', 'Italian', 'it-IT'], ['pt', 'Portuguese', 'pt-BR', 'pt', 'pt-BR'], ['nl', 'Dutch', 'nl-NL'],
  ['ru', 'Russian', 'ru-RU'], ['uk', 'Ukrainian', 'uk-UA'], ['pl', 'Polish', 'pl-PL'], ['cs', 'Czech', 'cs-CZ'],
  ['sk', 'Slovak', 'sk-SK'], ['hu', 'Hungarian', 'hu-HU'], ['ro', 'Romanian', 'ro-RO'], ['bg', 'Bulgarian', 'bg-BG'],
  ['hr', 'Croatian', 'hr-HR'], ['sr', 'Serbian', 'sr-RS'], ['sl', 'Slovenian', 'sl-SI'], ['el', 'Greek', 'el-GR'],
  ['tr', 'Turkish', 'tr-TR'], ['ar', 'Arabic', 'ar-SA', 'ar', 'ar', 'ar-EG'], ['he', 'Hebrew', 'he-IL'], ['fa', 'Persian', 'fa-IR'],
  ['hi', 'Hindi', 'hi-IN'], ['bn', 'Bengali', 'bn-IN'], ['ta', 'Tamil', 'ta-IN', 'ta', 'ta', null], ['th', 'Thai', 'th-TH'],
  ['vi', 'Vietnamese', 'vi-VN'], ['id', 'Indonesian', 'id-ID'], ['ms', 'Malay', 'ms-MY'], ['fil', 'Filipino', 'fil-PH', 'tl', 'fil'],
  ['sv', 'Swedish', 'sv-SE'], ['no', 'Norwegian', 'nb-NO', 'no', 'no'], ['da', 'Danish', 'da-DK'], ['fi', 'Finnish', 'fi-FI'],
  ['ca', 'Catalan', 'ca-ES'], ['sw', 'Swahili', 'sw-KE'],
];

/** @type {Language[]} */
export const LANGUAGES = ROWS.map(([id, name, locale, iso = id, live = id, google = locale]) => ({ id, name, locale, iso, live, google }));
const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

/** A language's name for itself, which the browser knows (Intl.DisplayNames); its English one where it doesn't. @param {Language} l */
export const nativeName = (l) => {
  try {
    return new Intl.DisplayNames([l.id], { type: 'language' }).of(l.id) ?? l.name;
  } catch {
    return l.name;
  }
};

/** A browser language tag's primary subtag, as a language of ours (nb, nn and no are one; iw is he; tl is fil). @param {unknown} tag */
const idOfLocale = (tag) => {
  const base = String(tag ?? '').toLowerCase().split(/[-_]/)[0];
  return BY_ID.has(base) ? base : ({ nb: 'no', nn: 'no', iw: 'he', tl: 'fil' }[/** @type {'nb'} */ (base)] ?? 'en');
};

/**
 * The setting (Settings → Shiori): app.json's `languages` — spoken, in order (picked from LANGUAGES), and answer ('follow', or one id) —
 * or, with none chosen, the browser's language.
 * @param {Record<string, any>} app the app settings @param {string} [locale] the browser's language @returns {LanguageSettings}
 */
export function languageSettings(app, locale) {
  const saved = app?.languages && typeof app.languages === 'object' ? app.languages : {};
  const ids = [...new Set(Array.isArray(saved.spoken) ? saved.spoken : [])].filter((id) => BY_ID.has(id));
  const answer = BY_ID.get(saved.answer) ?? null;
  if (ids.length) return { explicit: true, spoken: ids.map((id) => /** @type {Language} */ (BY_ID.get(id))), answer };
  const id = idOfLocale(locale);
  const here = String(locale ?? '').replace('_', '-');
  // The browser's own region ("en-GB") speaks for it where it names the same language.
  const base = /** @type {Language} */ (BY_ID.get(id));
  return { explicit: false, spoken: [/^[a-z]{2,3}-[A-Za-z0-9]+$/i.test(here) && here.split('-')[0].toLowerCase() === id ? { ...base, locale: here } : base], answer };
}

/** "English", "English and Japanese", "English, Chinese (Mandarin) and Japanese" (or with "or"). @param {Language[]} list @param {string} [and] */
export const named = (list, and = 'and') => list.map((l) => l.name).reduce((s, n, i, a) => (i ? `${s}${i === a.length - 1 ? ` ${and} ` : ', '}${n}` : n), '');

/** What a model that writes speech down is told (phase 2), after its own instruction: who may speak, and that nothing is translated. @param {LanguageSettings} s */
export const speakerLine = (s) => `The speaker uses ${named(s.spoken, 'or')}: write ${s.spoken.length > 1 ? 'each' : 'it'} in the language spoken and never translate.`;

/**
 * What every model that hears or speaks is told (the user, 2026-10-23), once, in the same words: Shiori's and Kokoro's system text,
 * Koe's, and a live session's. OpenAI's own prompting guide warns against "reply in the user's language" (the model takes an
 * accent, a filler or one foreign word for a change of language): so the languages are named, and one unsure word changes nothing.
 * @param {LanguageSettings} s
 */
export function languagesText(s) {
  const list = named(s.spoken);
  const rest = "Never switch to another language because of one word you're unsure of; if you can't make out what they said, ask them to say it again.";
  if (s.answer) return `The user speaks ${list}. Always answer in ${s.answer.name}, whatever language they use. ${rest}`;
  return `The user speaks ${list}${s.spoken.length > 1 ? '; they may switch between these' : ''}. Answer in the language they used. ${rest}`;
}

/**
 * What a protocol plugin is given: the languages as data, nothing else. Until the user has chosen, no language is given as a hint (the
 * browser's language is told to models in words only): a hint that forces a Whisper-style model to English would garble a Japanese
 * speaker whose browser is in English.
 * @param {LanguageSettings} s @returns {{ spoken: Language[], answer: Language | null }}
 */
export const modelLanguages = (s) => ({ spoken: s.explicit ? s.spoken.map((l) => ({ ...l })) : [], answer: s.answer ? { ...s.answer } : null });

/**
 * Writing systems that name their language when they make up most of a text's letters (review A6: a place name in kanji in an
 * English line is no Chinese): Chinese characters with kana are Japanese, without, Chinese; Cyrillic with і, ї, є or ґ is Ukrainian.
 */
const SCRIPTS = /** @type {const} */ ([[/[぀-ヿ一-鿿]/g, 'Chinese'], [/[가-힯]/g, 'Korean'], [/[฀-๿]/g, 'Thai'],
  [/[؀-ۿ]/g, 'Arabic'], [/[֐-׿]/g, 'Hebrew'], [/[Ͱ-Ͽ]/g, 'Greek'], [/[ऀ-ॿ]/g, 'Hindi'], [/[Ѐ-ӿ]/g, 'Russian']]);
/** The commonest small words of languages written in Latin letters: the one with the most of them, alone at the top, is it. */
const COMMON = Object.entries({
  English: 'the and is are was you we our to of it what where when how for this that please with be can do my me i us in on at near still open not have there any tonight today',
  Spanish: 'el los las y es son que de en un una por para con no qué dónde cómo gracias somos estamos hay del al muy',
  French: 'le les et est sont que de des du un une pour avec nous vous je pas où merci au aux sur',
  German: 'der die das und ist sind nicht ich wir sie ein eine mit für auf wo was bitte danke zu dem den',
  Italian: 'il lo gli e è sono che di un una per con non siamo dove cosa grazie del della ci',
  Portuguese: 'o os as e é são que de um uma para com não onde obrigado obrigada somos estamos você do da',
  Dutch: 'de het een en is zijn niet ik wij we met voor waar wat bedankt van op',
}).map(([name, list]) => /** @type {const} */ ([name, new Set(list.split(' '))]));

/** The language a text is written in, by name, or '' when it can't be told (a word or two). @param {string} text */
export function languageOf(text) {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  for (const [re, name] of SCRIPTS) {
    if ((text.match(re) ?? []).length * 2 <= letters) continue;
    if (name === 'Chinese') return /[぀-ヿ]/.test(text) ? 'Japanese' : name;
    return name === 'Russian' && /[іїєґ]/i.test(text) ? 'Ukrainian' : name;
  }
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const scores = COMMON.map(([name, set]) => /** @type {const} */ ([name, words.filter((w) => set.has(w)).length])).sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 && scores[0][1] > scores[1][1] ? scores[0][0] : '';
}

/** Which of ours a name from languageOf may be: a script is shared by several languages. */
const SHARED = /** @type {Record<string, string[]>} */ ({ Chinese: ['zh', 'yue'], Arabic: ['ar', 'fa'], Russian: ['ru', 'uk', 'bg', 'sr'], Ukrainian: ['uk'] });
/** @param {string} guess a name from languageOf @param {Language} l */
const is = (guess, l) => guess === l.name || (SHARED[guess] ?? []).includes(l.id);

/**
 * The locale browser dictation and the browser's voice use: the answer language if she answers in one; else the listed language the
 * sentence itself is written in (kana: Japanese, Han: Chinese...); else the first listed. @param {LanguageSettings} s @param {string} [text]
 */
export function speechLocale(s, text = '') {
  const guess = languageOf(text);
  return (s.answer ?? (guess ? s.spoken.find((l) => is(guess, l)) : null) ?? s.spoken[0]).locale;
}

/**
 * A transcript of a user turn of fewer than 3 words that is plainly in a language not listed ("¿Qué?" for a short English reply, on
 * 2026-10-22): that language's name, else ''. annai never treats it as the user changing language: it is flagged in the trace, and the
 * model's own instruction (languagesText) covers its side. A word no small list can place is not called foreign.
 * @param {string} text @param {LanguageSettings} s
 */
export function strayLanguage(text, s) {
  const said = String(text).trim();
  if (!said || (said.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3) return '';
  const guess = languageOf(said) || (/[¿¡ñ]/.test(said) ? 'Spanish' : /[ơưăạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(said) ? 'Vietnamese' : '');
  return guess && !s.spoken.some((l) => is(guess, l)) ? guess : '';
}

/** The setting's own words, in one place for a later pass that localizes the interface. */
export const LANGUAGE_WORDS = {
  heading: 'Languages',
  intro: 'The languages you speak, and the language Shiori answers in, are told to every model that hears or speaks, so a short reply is not taken for another language.',
  spokenLabel: 'Languages you speak',
  spokenHint: 'In order of use. Phone dictation listens in the first one only; models that take several are given all of them.',
  add: 'Add a language',
  remove: (/** @type {string} */ name) => `Remove ${name}`,
  up: (/** @type {string} */ name) => `Move ${name} up`,
  answerLabel: 'Shiori answers in',
  follow: 'The language you speak to her',
  empty: 'None picked: annai uses the browser’s language.',
  browser: 'the browser’s language',
};
