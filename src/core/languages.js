/**
 * The languages you speak (phase 2; spec §10.9): the list the setting picks from, the setting read from the app settings, and the
 * words and codes every model that hears or speaks is given, so a short reply is not taken for another language (the user,
 * 2026-10-23). The setting's own words are all here, as messages (LANGUAGE_WORDS).
 * @typedef {{ id: string, name: string, locale: string, iso: string, live: string | null, google: string | null }} Language
 *   id: annai's; locale: a BCP-47 tag a browser's dictation and voice take; iso: Whisper-style models (ISO 639-1, or -3 where OpenAI
 *   takes it); live: Gemini Live's own code for it; google: Gemini's transcription model's tag (null: it has none; Cantonese has none for Live,
 *   whose zh-Hant is not Cantonese)
 * @typedef {{ explicit: boolean, spoken: Language[], answer: Language | null }} LanguageSettings
 *   explicit: the user chose the list (else it is the browser's language); answer: the one language she answers in, null to follow the user
 */
import { t } from './l10n.js';

/* en: the names of the languages, until the formatting helpers name them */
/**
 * id, name, locale, then only what differs: iso (else the id), live (else the id; null: none), google (else the locale; null: none). Chinese is
 * Mandarin (Gemini Live: Simplified); Cantonese is its own. A language's name for itself comes from the browser (nativeName).
 * @type {[string, string, string, string?, (string | null)?, (string | null)?][]}
 */
const ROWS = [
  ['en', 'English', 'en-US'], ['zh', 'Chinese (Mandarin)', 'zh-CN', 'zh', 'zh-Hans', 'cmn-Hans-CN'], ['yue', 'Cantonese', 'yue-Hant-HK', 'yue', null],
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

/** A language's name in a language, as the browser knows it (Intl.DisplayNames), else the fallback. @param {string} in_ @param {string} code @param {string} fallback */
const display = (in_, code, fallback) => {
  try {
    return new Intl.DisplayNames([in_], { type: 'language' }).of(code) ?? fallback;
  } catch {
    return fallback;
  }
};
/** A language's name for itself ("日本語"). @param {Language} l */
export const nativeName = (l) => display(l.id, l.id, l.name);

/** What a browser's language tag is, as a language: the browser's own tag stays the locale (zh-Hant-TW, nb-NO, et-EE), as it was before this branch. @param {unknown} locale @returns {Language} */
function browserLanguage(locale) {
  const tag = String(locale ?? '').trim().replace(/_/g, '-');
  const raw = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/i.test(tag) ? tag : 'en-US';
  const code = raw.split('-')[0].toLowerCase();
  const id = BY_ID.has(code) ? code : ({ nb: 'no', nn: 'no', iw: 'he', tl: 'fil' }[/** @type {'nb'} */ (code)] ?? null);
  const known = id ? BY_ID.get(id) : null;
  // A language annai has no codes for is still named, and still the browser's own tag: no hint is ever sent for it.
  return known ? { ...known, locale: raw } : { id: code, name: display('en', code, code), locale: raw, iso: code, live: code, google: null };
}

/**
 * The setting (Settings → Shiori): app.json's `languages` — spoken, in order (picked from LANGUAGES), and answer ('follow', or one id) —
 * or, with none chosen, the browser's language (explicit: false), which is only what the phone is set to.
 * @param {Record<string, any>} app the app settings @param {string} [locale] the browser's language @returns {LanguageSettings}
 */
export function languageSettings(app, locale) {
  const saved = app?.languages && typeof app.languages === 'object' ? app.languages : {};
  const ids = [...new Set(Array.isArray(saved.spoken) ? saved.spoken : [])].filter((id) => BY_ID.has(id));
  const answer = BY_ID.get(saved.answer) ?? null;
  if (ids.length) return { explicit: true, spoken: ids.map((id) => /** @type {Language} */ (BY_ID.get(id))), answer };
  return { explicit: false, spoken: [browserLanguage(locale)], answer };
}

/** "English", "English and Japanese", "English, Chinese (Mandarin) and Japanese" (or with "or"). @param {Language[]} list @param {string} [and] */
export const named = (list, and = 'and') => list.map((l) => l.name).reduce((s, n, i, a) => (i ? `${s}${i === a.length - 1 ? ` ${and} ` : ', '}${n}` : n), '');

/** What a model that writes speech down is told (phase 2), after its own instruction: who may speak, and that nothing is translated. @param {LanguageSettings} s */
export const speakerLine = (s) => /* en */ (!s.explicit ? '' : `The speaker uses ${named(s.spoken, 'or')}: write ${s.spoken.length > 1 ? 'each' : 'it'} in the language spoken and never translate.`);

/**
 * What every model that hears or speaks is told (the user, 2026-10-23), once, in the same words: Shiori's and Kokoro's system text,
 * Koe's, and a live session's. OpenAI's own prompting guide warns against "reply in the user's language" (the model takes an
 * accent, a filler or one foreign word for a change of language): so the languages are named, and one unsure word changes nothing.
 * @param {LanguageSettings} s
 */
export function languagesText(s) {
  const list = named(s.spoken);
  /* en */
  const rest = "Never switch to another language because of one word you're unsure of; if you can't make out what they said, ask them to say it again.";
  // Until the user picks, all annai knows is what the phone is set to: not that they speak it, and not that they speak nothing else.
  /* en */
  if (!s.explicit) return `The user's phone is set to ${list}${s.answer ? `. Always answer in ${s.answer.name}, whatever language they use` : ', and they may speak other languages. Answer in the language they used'}. ${rest}`;
  /* en */
  if (s.answer) return `The user speaks ${list}. Always answer in ${s.answer.name}, whatever language they use. ${rest}`;
  /* en */
  return `The user speaks ${list}${s.spoken.length > 1 ? '; they may switch between these' : ''}. Answer in the language they used. ${rest}`;
}

/**
 * What a protocol plugin is given: the languages as data, nothing else. Until the user has chosen, no language is given as a hint (the
 * browser's language is told to models in words only): a hint that forces a Whisper-style model to English would garble a Japanese
 * speaker whose browser is in English.
 * @param {LanguageSettings} s @returns {{ spoken: Language[], answer: Language | null }}
 */
export const modelLanguages = (s) => ({ spoken: s.explicit ? s.spoken.map((l) => ({ ...l })) : [], answer: s.answer ? { ...s.answer } : null });

/** Han, kana and Hangul by script (so Extension A, 々, half-width katakana and jamo count), and the prolonged sound mark. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc]/gu;
/** How many words a text has, counting each Chinese, Japanese or Korean character as one (they have no spaces between words). @param {string} text */
const units = (text) => (text.match(CJK)?.length ?? 0) + (text.replace(CJK, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0);

/* en */
/**
 * Writing systems that name their language when they make up most of a text's letters (review A6: a place name in kanji in an
 * English line is no Chinese): Chinese characters with kana are Japanese, without, Chinese (the Han alone of a short Japanese reply is
 * Chinese here: listedFor places it with Japanese when only that is listed); Cyrillic with і, ї, є or ґ is Ukrainian.
 */
const SCRIPTS = /** @type {const} */ ([[/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, 'Chinese'], [/\p{Script=Hangul}/gu, 'Korean'], [/\p{Script=Thai}/gu, 'Thai'],
  [/\p{Script=Arabic}/gu, 'Arabic'], [/\p{Script=Hebrew}/gu, 'Hebrew'], [/\p{Script=Greek}/gu, 'Greek'], [/\p{Script=Devanagari}/gu, 'Hindi'], [/\p{Script=Cyrillic}/gu, 'Russian']]);
/* en */
/**
 * The commonest small words of languages written in Latin letters, without the words another of them (or English) shares: the one with
 * the most of them, alone at the top, is it.
 */
const COMMON = Object.entries({
  English: 'the and is are was you we our to of it what where when how for this that please with can my near still open not have there any tonight today yes thanks thank',
  Spanish: 'el los las qué dónde cómo gracias somos estamos hay muy está también hola',
  French: 'le les et est sont des avec nous vous je pas où merci aux sur bonjour beaucoup',
  German: 'der das und ist sind nicht ich wir sie ein eine mit für auf bitte danke dem',
  Italian: 'il gli è non sono siamo cosa grazie della ciao buongiorno',
  Portuguese: 'os são não onde obrigado obrigada estamos você muito é',
  Dutch: 'het een zijn niet ik wij met voor waar wat bedankt hallo',
}).map(([name, list]) => /** @type {const} */ ([name, new Set(list.split(' '))]));
/** A mark only one of them has counts as a word: ¿ ¡ ñ (Spanish), ß (German), ã õ (Portuguese). */
const MARKS = /** @type {Record<string, RegExp>} */ ({ Spanish: /[¿¡ñ]/u, German: /ß/u, Portuguese: /[ãõ]/u });

/**
 * The language a text is written in, by name, or '' when it can't be told. min: how many words of one language's list (a mark counts as
 * one) a Latin text needs, alone at the top: 1 for a long text (a summary's language); 2 for a word or two, where one hit is a name or a
 * word English has too ("Per se", "Des Moines"). @param {string} text @param {number} [min]
 */
export function languageOf(text, min = 1) {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  for (const [re, name] of SCRIPTS) {
    if ((text.match(re) ?? []).length * 2 <= letters) continue;
    /* en */
    if (name === 'Chinese') return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? 'Japanese' : name;
    /* en */
    return name === 'Russian' && /[іїєґ]/i.test(text) ? 'Ukrainian' : name;
  }
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const scores = COMMON.map(([name, set]) => /** @type {const} */ ([name, words.filter((w) => set.has(w)).length + (MARKS[name]?.test(text) ? 1 : 0)])).sort((a, b) => b[1] - a[1]);
  return scores[0][1] >= min && scores[0][1] > scores[1][1] ? scores[0][0] : '';
}

/** Vietnamese's own marks (its tones, ơ, ư), and those it shares with French, Portuguese and the like (â ê ô đ). No ă: that is Romanian's. */
const VIETNAMESE = /[ơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu;
const SHARED_MARKS = /[âêôđ]/iu;
/** Listed languages that use â ê ô or đ themselves: with one listed, those marks alone say nothing of Vietnamese. */
const USES_SHARED = ['fr', 'pt', 'ro', 'tr', 'sk', 'hr'];

/**
 * 'Vietnamese' when a text has its marks. spoken: the listed languages, which keep â ê ô đ from meaning Vietnamese when one of them uses
 * those letters. @param {string} text @param {Language[]} [spoken]
 */
export function vietnameseMarks(text, spoken = []) {
  /* en */
  return VIETNAMESE.test(text) || (SHARED_MARKS.test(text) && !spoken.some((l) => USES_SHARED.includes(l.id))) ? 'Vietnamese' : '';
}

/** Which of ours a name from languageOf may be: a script is shared by several languages. */
const SHARED = /** @type {Record<string, string[]>} */ ({ Chinese: ['zh', 'yue'], Arabic: ['ar', 'fa'], Russian: ['ru', 'uk', 'bg', 'sr'], Ukrainian: ['uk'] });

/**
 * The listed language a name from languageOf is, or null. Han characters alone are Chinese's, and Japanese's too when Chinese isn't
 * listed (a short Japanese reply may be kanji only). @param {string} guess @param {Language[]} spoken
 */
export function listedFor(guess, spoken) {
  const same = spoken.find((l) => guess === l.name || (SHARED[guess] ?? []).includes(l.id));
  return same ?? (guess === 'Chinese' ? spoken.find((l) => l.id === 'ja') ?? null : null);
}

/** A language's BCP 47 tag, for `lang`: Chinese by script (a Traditional Chinese phone's is Traditional), Norwegian as Bokmål. @param {Language} l */
export const tagFor = (l) => (l.id === 'zh' ? (/Hant|-(?:TW|HK|MO)\b/i.test(l.locale) ? 'zh-Hant' : 'zh-Hans') : l.id === 'yue' ? 'yue-Hant' : l.id === 'no' ? 'nb' : l.id);
/** What a script says when no listed language is its own (Han alone, with neither Chinese nor Japanese listed, is Chinese). */
const SCRIPT_TAGS = /** @type {Record<string, string>} */ ({ Chinese: 'zh-Hans', Japanese: 'ja', Korean: 'ko', Thai: 'th', Arabic: 'ar', Hebrew: 'he', Greek: 'el', Hindi: 'hi', Russian: 'ru', Ukrainian: 'uk' });

/** Characters only Simplified Chinese uses, all but the last 3 of them unused in Japanese too; and their Traditional forms. */
const HANS = '这们个说时门东车马鸟书见长问间对开关现过还点发实经动样乐国会来';
const HANT = '這們個說時門東車馬鳥書見長問間對開關現過還點發實經動樣樂國會來';
/** How many of a text's characters are in a set. @param {string} text @param {string} set */
const count = (text, set) => [...text].filter((c) => set.includes(c)).length;

/**
 * The writing system a text is mostly in, by the name languageOf gives it, or '': Chinese, Japanese and Korean when their characters outnumber
 * the Latin words (a place name or a loan word in an English line is no Chinese); another script when it makes up most of the letters.
 * @param {string} text
 */
function scriptOf(text) {
  const n = (/** @type {RegExp} */ re) => text.match(re)?.length ?? 0;
  const kana = n(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = n(/\p{Script=Hangul}/gu);
  const han = n(/\p{Script=Han}/gu);
  if (han + kana + hangul > (text.replace(CJK, ' ').match(/\p{L}+/gu)?.length ?? 0)) return hangul > han + kana ? 'Korean' : kana ? 'Japanese' : 'Chinese';
  const other = han + kana + hangul ? '' : languageOf(text);
  return SCRIPT_TAGS[other] ? other : '';
}

/**
 * The tag of Han characters with no kana: Japanese when that is the language and the characters are ones Chinese does not use; else
 * Chinese, Simplified or Traditional by the characters, and by the language (the phone's, or the list's) when they do not tell.
 * @param {string} text @param {Language | null} l the language they are taken to be
 */
function hanTag(text, l) {
  const [hans, hant] = [count(text, HANS), count(text, HANT)];
  if (l?.id === 'ja' && !count(text, HANS.slice(0, -3))) return 'ja';
  if (hans > hant) return 'zh-Hans';
  if (l?.id === 'yue') return 'yue-Hant';
  return hant > hans ? 'zh-Hant' : l && l.id !== 'ja' ? tagFor(l) : 'zh-Hans';
}

/** What tagOf says for a line that must not take the screens' language and whose own can't be told (shown as `lang=""`, HTML's "unknown"). */
export const NO_LANGUAGE = 'und';
/** Whether a language is written in Latin letters, by its likeliest script; Bengali, Tamil and the like are not. @param {string} tag */
function latinTag(tag) {
  try { return new Intl.Locale(tag).maximize().script === 'Latn'; } catch { return false; }
}

/**
 * A line's BCP 47 tag, for its `lang`: a browser draws Han characters and a screen reader reads them by it (localization L3). From the
 * writing system (scriptOf) and the listed languages (listedFor); an address is no language. Latin text is never guessed (a wrong tag gives
 * it a wrong voice): it and any unsure text get '' and inherit the screens'. byShiori: the language she is set to answer in, where the
 * text agrees with it (its script, or Latin when hers is written in Latin); Han alone is taken for hers, if she answers in Japanese.
 * ui: the screens' language. Under screens not in Latin letters, a Latin line is the one listed Latin-script language if exactly one is
 * (usually English), else the one languageOf names from two of its words, else NO_LANGUAGE: it never takes the screens'.
 * @param {string} text @param {LanguageSettings} s @param {boolean} [byShiori] @param {string} [ui]
 */
export function tagOf(text, s, byShiori = false, ui = 'en') {
  const said = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  const kind = scriptOf(said);
  const answer = byShiori ? s.answer : null;
  if (!kind) {
    const letters = said.match(/\p{L}/gu)?.length ?? 0;
    if (!letters) return '';
    const latin = (said.match(/\p{Script=Latin}/gu)?.length ?? 0) * 2 > letters;
    // Hers, in a Latin-script language: her answer language.
    if (answer && latin && latinTag(tagFor(answer))) return tagFor(answer);
    if (latinTag(ui)) return '';
    if (!latin) return NO_LANGUAGE;
    const listed = s.spoken.filter((l) => latinTag(tagFor(l)));
    if (listed.length === 1) return tagFor(listed[0]);
    const guess = languageOf(said, 2);
    const named = guess ? LANGUAGES.find((l) => l.name === guess) : undefined;
    return named ? tagFor(named) : NO_LANGUAGE;
  }
  const l = (answer && listedFor(kind, [answer])) || listedFor(kind, s.spoken);
  return kind === 'Chinese' ? hanTag(said, l) : l ? tagFor(l) : SCRIPT_TAGS[kind];
}

/**
 * The locale browser voice uses: the answer language if she answers in one; else the listed language the sentence itself is written
 * in (kana: Japanese, Han: Chinese or Japanese...); else the first listed. @param {LanguageSettings} s @param {string} [text]
 */
export function speechLocale(s, text = '') {
  const guess = languageOf(text);
  return (s.answer ?? (guess ? listedFor(guess, s.spoken) : null) ?? s.spoken[0]).locale;
}

/** The locale phone dictation listens in: Web Speech takes one tag, the first language listed, whatever Shiori answers in. @param {LanguageSettings} s */
export const dictationLocale = (s) => s.spoken[0].locale;

/**
 * A transcript of a user turn of fewer than 3 words (a Chinese, Japanese or Korean character counts as a word) that is plainly in a
 * language not listed ("¿Qué?" for a short English reply, on 2026-10-22): that language's name, else ''. annai never treats it as the user
 * changing language: it is flagged in the trace, and the model's own instruction (languagesText) covers its side. Plainly: a script, a
 * mark only that language has, or two of its small words; one word could be a name or English's own ("Per se.", "Um.").
 * @param {string} text @param {LanguageSettings} s
 */
export function strayLanguage(text, s) {
  const said = String(text).trim();
  if (!said || units(said) >= 3) return '';
  const guess = languageOf(said, 2) || vietnameseMarks(said, s.spoken);
  return guess && !listedFor(guess, s.spoken) ? guess : '';
}

/** What the model that reads a flagged heard line is told beside it (review: Kokoro should know a line may be a mishearing). @param {string} language */
export const strayNote = (language) => /* en */ ` (heard; may be misheard as ${language})`;

/**
 * The setting's own words, in one place: each a message (localization L1), so the screen draws them in the language of the day. A
 * status is a pair, what the line says while the change is written and what it says once it has been, each whole so each can be
 * translated whole.
 */
export const LANGUAGE_WORDS = {
  heading: t`Languages`,
  intro: t`The languages you speak, and the language Shiori answers in, are told to every model that hears or speaks, so a short reply is not taken for another language.`,
  spokenLabel: t`Languages you speak`,
  spokenHint: t`In order of use. Phone dictation listens in the first one only; models that take several are given all of them.`,
  add: t`Add a language`,
  addButton: t`Add`,
  remove: t`Remove`,
  moveUpText: '↑',
  moveDownText: '↓',
  removeLabel: (/** @type {string} */ name) => t`Remove ${name}`,
  moveUpLabel: (/** @type {string} */ name) => t`Move ${name} up`,
  moveDownLabel: (/** @type {string} */ name) => t`Move ${name} down`,
  /** A language as the pickers show it: its English name, then its own. */
  option: (/** @type {string} */ name, /** @type {string} */ own) => t`${name} · ${own}`,
  added: (/** @type {string} */ name) => [t`Added ${name}`, t`Added ${name}. Saved`],
  moved: (/** @type {string} */ name, /** @type {number} */ place) => [t`${name} moved to ${place}`, t`${name} moved to ${place}. Saved`],
  removed: (/** @type {string} */ name) => [t`${name} removed`, t`${name} removed. Saved`],
  removedAnswer: (/** @type {string} */ name) => [
    t`${name} removed; Shiori answers in the language you speak to her again`,
    t`${name} removed; Shiori answers in the language you speak to her again. Saved`,
  ],
  answered: (/** @type {string} */ name) => [t`Shiori answers in ${name}`, t`Shiori answers in ${name}. Saved`],
  answeredFollow: () => [t`Shiori answers in the language you speak to her`, t`Shiori answers in the language you speak to her. Saved`],
  answerLabel: t`Shiori answers in`,
  follow: t`The language you speak to her`,
  emptyHint: t`None picked: annai uses the browser’s language. In order of use. Phone dictation listens in the first one only; models that take several are given all of them.`,
};
