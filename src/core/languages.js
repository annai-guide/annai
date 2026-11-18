/**
 * The languages you speak (spec §10.9): the list the setting picks from, the setting itself, and the words and codes every model that
 * hears or speaks is given, so a short reply is not taken for another language. The setting's own words are here too (LANGUAGE_WORDS).
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
 * Mandarin in two rows, Simplified (the mainland's codes) and Traditional (Taiwan's, so a Taiwan user's dictation and
 * transcription come back in Traditional); Cantonese is its own. A language's name for itself comes from the browser (nativeName).
 * @type {[string, string, string, string?, (string | null)?, (string | null)?][]}
 */
const ROWS = [
  ['en', 'English', 'en-US'], ['zh', 'Chinese (Simplified)', 'zh-CN', 'zh', 'zh-Hans', 'cmn-Hans-CN'], ['zh-Hant', 'Chinese (Traditional)', 'zh-TW', 'zh', 'zh-Hant', 'cmn-Hant-TW'],
  ['yue', 'Cantonese', 'yue-Hant-HK', 'yue', null],
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

/** The tag the browser names a language of ours by: the Chinese row is Simplified Chinese, apart from Traditional's. @param {string} id */
export const displayCode = (id) => (id === 'zh' ? 'zh-Hans' : id);
/** A language's name in a language, as the browser knows it (Intl.DisplayNames), else the fallback. @param {string} in_ @param {string} code @param {string} fallback */
const display = (in_, code, fallback) => {
  try {
    return new Intl.DisplayNames([in_], { type: 'language' }).of(code) ?? fallback;
  } catch {
    return fallback;
  }
};
/** Names for itself a browser may lack, answering with the English name or the code: Chromium's ICU has none for Cantonese. */
/* en */ const OWN = /** @type {Record<string, string>} */ ({ yue: '粵語' });
/** A language's name for itself ("日本語"). @param {Language} l */
export function nativeName(l) {
  const own = display(displayCode(l.id), displayCode(l.id), l.name);
  return own !== l.name && own !== l.id ? own : OWN[l.id] ?? own;
}

/** What a browser's language tag is, as a language: the browser's own tag stays the locale (zh-Hant-TW, nb-NO, et-EE), as it was before this branch. @param {unknown} locale @returns {Language} */
function browserLanguage(locale) {
  const tag = String(locale ?? '').trim().replace(/_/g, '-');
  // zh-yue, which Intl doesn't take, is Cantonese, as the screens read it (l10n.js screensTag).
  const raw = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/i.test(tag) ? tag.replace(/^zh-yue(?=-|$)/i, 'yue') : 'en-US';
  const code = raw.split('-')[0].toLowerCase();
  // A Traditional Chinese phone's Chinese is the Traditional row.
  const id = code === 'zh' && traditional(raw) ? 'zh-Hant' : BY_ID.has(code) ? code : ({ nb: 'no', nn: 'no', iw: 'he', tl: 'fil' }[/** @type {'nb'} */ (code)] ?? null);
  const known = id ? BY_ID.get(id) : null;
  // A language annai has no codes for is still named, and still the browser's own tag: no hint is ever sent for it.
  return known ? { ...known, locale: raw } : { id: code, name: display('en', code, code), locale: raw, iso: code, live: code, google: null };
}

/**
 * The setting (Settings → Languages): app.json's `languages` — spoken, in order (picked from LANGUAGES), and answer ('follow', or one id) —
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

/** "English", "English and Japanese", "English, Chinese (Simplified) and Japanese" (or with "or"). @param {Language[]} list @param {string} [and] */
export const named = (list, and = 'and') => list.map((l) => l.name).reduce((s, n, i, a) => (i ? `${s}${i === a.length - 1 ? ` ${and} ` : ', '}${n}` : n), '');

/** What a model that writes speech down is told, after its own instruction: who may speak, and that nothing is translated. @param {LanguageSettings} s */
export const speakerLine = (s) => /* en */ (!s.explicit ? '' : `The speaker uses ${named(s.spoken, 'or')}: write ${s.spoken.length > 1 ? 'each' : 'it'} in the language spoken and never translate.`);

/**
 * The last sentence of the Languages section, for every setting: its own words say when it applies. It names no register ("to a friend" here made Opus drop
 * です・ます, 2026-11-14) and quotes no word to say; its example explains what annai's word means (it moved Opus, not Sonnet or Haiku). The recap's request
 * carries it too (its Japanese read as translated, 2026-11-17).
 */
/* en */
export const NATIVE = "When you answer in a language other than English, say things the way a native speaker of that language would, and say what annai's English words mean instead of translating them word for word (a plan item marked fixed is one that can't be moved).";

/**
 * What every model that hears or speaks is told, in the same words: Shiori's and Kokoro's system text, Koe's, and a live session's. The
 * languages are named because "reply in the user's language" makes a model take an accent, a filler or one foreign word for a change of
 * language (OpenAI's own prompting guide warns against it); one unsure word changes nothing. It always ends with one sentence for how she
 * sounds in a language other than English (her Japanese read as translated English, the user, 2026-11-14). Its own words say when it applies:
 * no setting tells whether she will answer in another language (an English phone, nothing chosen, Japanese typed), so none branches on one.
 * @param {LanguageSettings} s
 */
export function languagesText(s) {
  const list = named(s.spoken);
  /* en */
  const rest = `Never switch to another language because of one word you're unsure of; if you can't make out what they said, ask them to say it again. ${NATIVE}`;
  // "The language they used" names none until they have said something (a first message annai wakes her for: files moved into a chat, a share into a new
  // conversation): then the first language listed, which with nothing chosen is the phone's. Worded by its own condition (fix round 2).
  /* en */
  const first = `Answer in the language they used; before they have written or said anything in this conversation, answer in ${s.spoken[0].name}`;
  // Until the user picks, all annai knows is what the phone is set to: not that they speak it, and not that they speak nothing else.
  /* en */
  if (!s.explicit) return `The user's phone is set to ${list}${s.answer ? `. Always answer in ${s.answer.name}, whatever language they use` : `, and they may speak other languages. ${first}`}. ${rest}`;
  /* en */
  if (s.answer) return `The user speaks ${list}. Always answer in ${s.answer.name}, whatever language they use. ${rest}`;
  /* en */
  return `The user speaks ${list}${s.spoken.length > 1 ? '; they may switch between these' : ''}. ${first}. ${rest}`;
}

/** What Shiori is told of screens not in English: one stable line of their names. @param {string} tag @param {string} names the catalog's, "Settings (設定), …" */
export const screensText = (tag, names) => /* en */ (tag.split('-')[0] === 'en' || !names ? ''
  : `annai's screens are in ${display('en', tag, tag)}. When you name a screen, a setting or a button, use the name it shows: ${names}. This doesn't change the language you answer in.`);

/** The Distances choice kept in the app settings: 'km', 'mi', or null for Automatic (anything else). @param {Record<string, any>} app @returns {'km' | 'mi' | null} */
export const distancesOf = (app) => { const d = app?.languages?.distances; return d === 'km' || d === 'mi' ? d : null; };
/** What Shiori is told of a Distances choice, over the profile's Units line; '' for Automatic. @param {Record<string, any>} app */
export function distancesText(app) {
  const d = distancesOf(app);
  /* en */
  return d ? `Give distances in ${d === 'mi' ? 'miles' : 'kilometres'}, as annai's screens show them, whatever their profile says.` : '';
}

/**
 * What a protocol plugin is given: the languages as data. Until the user has chosen, no hint is given (the browser's language is told to
 * models in words only): a hint that forces a Whisper-style model to English would garble a Japanese speaker whose browser is in English.
 * @param {LanguageSettings} s @returns {{ spoken: Language[], answer: Language | null }}
 */
export const modelLanguages = (s) => ({ spoken: s.explicit ? s.spoken.map((l) => ({ ...l })) : [], answer: s.answer ? { ...s.answer } : null });

/** Han, kana and Hangul by script (so Extension A, 々, half-width katakana and jamo count), and the prolonged sound mark. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc]/gu;
/** How many words a text has, counting each Chinese, Japanese or Korean character as one (they have no spaces between words). @param {string} text */
export const units = (text) => (text.match(CJK)?.length ?? 0) + (text.replace(CJK, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0);

/* en */
/**
 * Writing systems that name their language when they make up most of a text's letters (a place name in kanji in an
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
/** The languages COMMON has small words for. */
const WORD_LISTS = new Set(COMMON.map(([name]) => name));
/** A mark only one of them has counts as a word: ¿ ¡ ñ (Spanish), ß (German), ã õ (Portuguese). */
const MARKS = /** @type {Record<string, RegExp>} */ ({ Spanish: /[¿¡ñ]/u, German: /ß/u, Portuguese: /[ãõ]/u });

/**
 * One of the world's languages a text looks written in, by name, or '' when it can't be told: the stray note's question (strayLanguage), the
 * realtime check's, and for a Latin line, which of the 7 languages with a word list its small words are. Choosing among the traveller's own
 * languages is placed's, which asks this only for those words. min: how many words of one language's list (a mark counts as one) a Latin text
 * needs, alone at the top: 2 to name a language, where one hit is a name or a word English has too ("Per se", "Des Moines", "Los Angeles
 * hotel"); 1 to ask whether a line has any word of another language at all. @param {string} text @param {number} [min]
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
const SHARED = /** @type {Record<string, string[]>} */ ({ Chinese: ['zh', 'zh-Hant', 'yue'], Arabic: ['ar', 'fa'], Russian: ['ru', 'uk', 'bg', 'sr'], Ukrainian: ['uk'] });

/**
 * Whether a name from languageOf is one of the listed languages (the stray note's question): a script several share is any of them; Han
 * characters alone are Chinese's, and Japanese's too when Chinese isn't listed (a short Japanese reply may be kanji only).
 * @param {string} guess @param {Language[]} spoken
 */
export function listedFor(guess, spoken) {
  return spoken.find((l) => guess === l.name || (SHARED[guess] ?? []).includes(l.id)) ?? (guess === 'Chinese' ? spoken.find((l) => l.id === 'ja') ?? null : null);
}
/** The two Chinese rows, Simplified and Traditional. */
export const MANDARIN = ['zh', 'zh-Hant'];
/**
 * The Chinese row a text's characters say, or '' when they don't tell. Only text that is Chinese by its writing (writing: a character only Chinese
 * writes) says a row: Japanese writes 東, 時 and 間 too, so 東京駅 says none (every reader asks this, and so agrees). @param {string} text
 */
export const hanRow = (text) => {
  if (writing(text) !== 'zh') return '';
  const [hans, hant] = [count(text, HANS), count(text, HANT)];
  return hans > hant ? 'zh' : hant > hans ? 'zh-Hant' : '';
};

/** The script a BCP 47 tag is likeliest written in ('Latn', 'Jpan', 'Hans', 'Hant', 'Cyrl'…), or '' for a tag that is none. @param {string} tag */
const likelyScript = (tag) => { try { return new Intl.Locale(tag).maximize().script ?? ''; } catch { return ''; } };
/** Whether a locale is written in Traditional characters: its script when it names one (zh-Hans-HK is Simplified), else its region's. @param {string} locale */
const traditional = (locale) => likelyScript(locale) === 'Hant';
/** A language's BCP 47 tag, for `lang`: Chinese by script (a Traditional Chinese phone's is Traditional), Norwegian as Bokmål. @param {Language} l */
export const tagFor = (l) => (l.id === 'zh' ? (traditional(l.locale) ? 'zh-Hant' : 'zh-Hans') : l.id === 'yue' ? (traditional(l.locale) ? 'yue-Hant' : 'yue-Hans') : l.id === 'no' ? 'nb' : l.id);
/** The script a language is written in: Japanese 'Jpan', the Chinese rows and Cantonese 'Hans' or 'Hant', Turkish 'Latn', Bengali 'Beng'. @param {Language} l */
const scriptOfLanguage = (l) => likelyScript(tagFor(l));
/** The scripts Han text is written in, by the languages it may be (Japanese, the Chinese rows, Cantonese). */
/* en */ const HAN_SCRIPTS = ['Jpan', 'Hans', 'Hant'];
/** What a script says when no listed language is its own (Han alone, with neither Chinese nor Japanese listed, is Chinese). */
const SCRIPT_TAGS = /** @type {Record<string, string>} */ ({ Chinese: 'zh-Hans', Japanese: 'ja', Korean: 'ko', Thai: 'th', Arabic: 'ar', Hebrew: 'he', Greek: 'el', Hindi: 'hi', Russian: 'ru', Ukrainian: 'uk' });

/**
 * Characters only Simplified Chinese uses, all but the last 3 of them (国 会 来, which Japanese writes too) unused in Japanese, and the 21 more
 * that Japanese's own character set has no form of (请 钱 饭 为 让 觉 脑 确 认 设 项 应 类 图 边 办 进 种 层 运 张: CHINESE's reason), so
 * 确认一下设置 is Simplified; and the Traditional forms of the first ones. 点 is not one: Japanese writes it too (交差点, 終点; the design check of
 * 2026-11-17, N1), and 點 is still Traditional.
 */
/* en */ const HANS = '这们个说时门东车马鸟书见长问间对开关现过还发实经动样乐请钱饭为让觉脑确认设项应类图边办进种层运张国会来';
/* en */ const HANT = '這們個說時門東車馬鳥書見長問間對開關現過還點發實經動樣樂國會來';
/** How many of a text's characters are in a set. @param {string} text @param {string} set */
const count = (text, set) => [...text].filter((c) => set.includes(c)).length;

/** Cantonese's own characters, none of them Mandarin's or Japanese's: its pronouns and plural (佢 哋), particles (嘅 咗 啲 喺), negatives (唔 冇), 嚟 睇 乜 嘢 咁. */
/* en */ const CANTONESE = '哋佢嘅唔咗冇喺啲嚟睇乜嘢咁';
/**
 * Chinese's own small words: its pronouns and their plural (你 您 她 们 們), 这 and 這, 哪, its question and closing particles (吗 嗎 呢 吧 么 麼 啊),
 * 很 and 沒, and Cantonese's characters; all are in CHINESE. A Japanese line with one (們 這 麼 很 沒 are in Japanese's character set) has kana,
 * read first. As grammar (GRAMMAR, without 你 这 這 哪 吧, which are in names too: 你好饭店, 酒吧街, 哪吒庙, so an English question naming one is
 * English), like hiragana: where a line has CJK characters
 * and Latin words, they outrank a Latin name's small words (「我们明天去 The Museum of Modern Art 吗？」 is Chinese), while the forms of CHINESE
 * (门 东…) are names, which two English small words outrank ("Where is 天安门?" is English).
 */
/* en */ const CHINESE_WORDS = `你您她们們这這哪吗嗎呢吧么麼沒很啊${CANTONESE}`;
/** The small words that outrank a Latin name's in a mixed line: CHINESE_WORDS but those names carry too. */
/* en */ const GRAMMAR = `您她们們吗嗎呢么麼沒很啊${CANTONESE}`;
/**
 * Characters only Chinese writes, where Japanese writes none of them: the Simplified forms Japanese doesn't share (HANS but its last 3, the 21
 * among them: none is in Japanese's own character set, JIS X 0208, none is in l10n/ja.tsv's Japanese or the 33 kept Japanese runs' 11,183 Han
 * characters, and 后 and 无 are left out because JIS has them: 皇后), the Traditional forms Japanese writes otherwise (說 説, 對 対, 點 点…), and
 * Chinese's small words (CHINESE_WORDS). Measured on the made-up trip's real lines (the design check of 2026-11-17): 48 of 48 Chinese lines
 * carry one of the first kind, and none of 1,038 Japanese sentences or 123 made-up kanji-only lines (stations, sights, food, signs, short
 * replies) does; the 21 are the second reviewer's (detector-next, 2026-11-17): of the catalog's 2,514 Simplified lines of 3 words or more,
 * 1,480 read as Chinese with them (1,218 without), and none of its 2,622 Japanese lines does. 的 and 是 would add 6 of 116 Chinese
 * sentences, but 目的地 and 是非 are Japanese, so they are left out.
 */
/* en */ const CHINESE = `${HANS.slice(0, -3)}說對關點發實經樣樂國會來${CHINESE_WORDS}`;
/** An address in a line: no language's words. */
const URLS = /\b(?:https?:\/\/|www\.)\S+/gi;
/**
 * The scripts of annai's languages other than Latin and Chinese, Japanese and Korean, each with the first of its languages (Cyrillic: Russian;
 * Arabic: Arabic): what a line written in it is when nothing is chosen and the phone's language isn't written in it.
 * @type {Map<string, { language: Language, re: RegExp }>}
 */
const SCRIPTS_OF_LANGUAGES = new Map();
for (const l of LANGUAGES) {
  const script = scriptOfLanguage(l);
  /* en */ if (!['Latn', ...HAN_SCRIPTS, 'Kore'].includes(script) && !SCRIPTS_OF_LANGUAGES.has(script)) SCRIPTS_OF_LANGUAGES.set(script, { language: l, re: new RegExp(`\\p{Script=${script}}`, 'gu') });
}

/**
 * What a line is written in, by its writing alone: 'Jpan' (kana), 'Kore' (Hangul), 'zh' (Han with a character only Chinese writes), 'Hani' (Han
 * that says neither), another script of annai's languages ('Cyrl', 'Beng'…) or 'Latn' when it is most of the letters, or '' when nothing tells.
 * One scale, units': Chinese, Japanese and Korean characters against the words in other scripts, so a Latin name leaves 「Los Angelesまで何時間？」
 * Japanese (letters against characters read it as Latin). A line with such characters and Latin words is Latin only when its Latin words name a
 * language (two small words of one: languageOf): "Where is 新宿御苑?" and "Where is 天安门?" are English, with a name in them; where they name none,
 * "新宿 Shibuya Sky", "好想去 Golden Gate Bridge" and "Meet at 新宿 station" tell nothing, and fewer such characters than Latin letters tell only by
 * a grammar of their own, kana or a character only Chinese writes (「iPhone 15 Pro 多少钱？」 is Chinese by 钱). Kana and Chinese's small words
 * (GRAMMAR) are grammar and outrank the Latin words' small words (「我们明天去 The Museum of Modern Art 吗？」 is Chinese); its other
 * characters (门 东 钱…) are names, which two small words outrank (「Where is 天安门?」 is English).
 * @param {string} text
 */
export function writing(text) {
  const said = text.replace(URLS, ' ');
  const n = (/** @type {RegExp} */ re) => said.match(re)?.length ?? 0;
  const cjk = n(CJK);
  const rest = said.replace(CJK, ' ');
  const words = rest.match(/[\p{L}\p{M}]+/gu)?.length ?? 0;
  const letters = rest.match(/\p{L}/gu)?.length ?? 0;
  const latin = n(/\p{Script=Latin}/gu) * 2 > letters;
  // Its Latin words name a language: the characters among them are names in a line in it. Words in another script name none here.
  const says = cjk > 0 && latin && !!languageOf(rest, 2);
  if (cjk > words) {
    // Fewer such characters than letters in other scripts: maybe a name in a line in another language.
    const name = words > 0 && cjk <= letters;
    /* en */ if (n(/\p{Script=Hangul}/gu) * 2 > cjk) return name ? (says ? 'Latn' : '') : 'Kore';
    /* en */ if (n(/\p{Script=Hiragana}/gu)) return 'Jpan';
    // Chinese's own small words are grammar too, so they outrank a Latin name's (「我们明天去 The Museum of Modern Art 吗？」); its forms are names, which "the" and "of" outrank.
    if ([...said].some((c) => GRAMMAR.includes(c))) return 'zh';
    if (name && says) return 'Latn';
    if ([...said].some((c) => CHINESE.includes(c))) return 'zh';
    /* en */ return name ? '' : n(/[\p{Script=Katakana}ー]/gu) ? 'Jpan' : 'Hani';
  }
  if (!words) return '';
  for (const [script, { re }] of SCRIPTS_OF_LANGUAGES) if (n(re) * 2 > letters) return script;
  return latin && (!cjk || says) ? 'Latn' : '';
}

/** What placed says of Han that tells neither Japanese nor Chinese where the traveller may mean either: its reader decides (the count, the tag, the voice). */
export const EITHER = 'either';

/**
 * The one of the traveller's own languages a line's writing shows (writing), or null when it shows none of theirs. Each listed language stands
 * for the script it is written in, so one annai has no words for (Turkish, Bengali) is placed when it is the only one listed in its script; with
 * nothing chosen the phone's language does (English for Latin letters on a phone not in them; Ukrainian for all Cyrillic on a Ukrainian phone),
 * and a line plainly in another language is that one: they may speak others. Between two of theirs in one script what the line shows decides:
 * Ukrainian's letters, Simplified or Traditional forms, Cantonese's characters, two small words or a mark of a language annai has words for
 * (languageOf; one small word when every listed Latin-script language has a list, since a line is then English or Spanish, not a name), the
 * marks only Vietnamese writes. Order decides only where the line shows nothing between them: Traditional characters fit Cantonese and Chinese
 * (Traditional) alike, so with Cantonese listed first they stay Cantonese. Han that says neither Japanese nor Chinese is EITHER where both may
 * be meant (both listed, or nothing chosen), else the one listed.
 * @param {string} text @param {LanguageSettings} s @returns {Language | typeof EITHER | null}
 */
export function placed(text, s) {
  const kind = writing(text);
  if (!kind) return null;
  const mine = s.spoken;
  const scripts = mine.map(scriptOfLanguage);
  const of = (/** @type {string[]} */ codes) => mine.filter((_, i) => codes.includes(scripts[i]));
  /** A language they may speak besides the phone's, with nothing chosen. @param {string} id */
  const open = (id) => (s.explicit ? null : BY_ID.get(id) ?? null);
  if (kind === 'Jpan' || kind === 'Kore') {
    const id = kind === 'Jpan' ? 'ja' : 'ko';
    return mine.find((l) => l.id === id) ?? open(id);
  }
  if (kind === 'zh' || kind === 'Hani') {
    /* en */ const chinese = of(['Hans', 'Hant']);
    const ja = mine.find((l) => l.id === 'ja');
    if (kind === 'Hani' && (!s.explicit || (ja && chinese.length))) return EITHER;
    if (kind === 'Hani' && !chinese.length) return ja ?? null;
    const yue = [...text].some((c) => CANTONESE.includes(c)) ? chinese.find((l) => l.id === 'yue') ?? open('yue') : null;
    if (yue) return yue;
    if (!chinese.length) return open(hanRow(text) || 'zh');
    // Simplified or Traditional forms: the first of theirs written in them (Cantonese is written in Traditional), else the first Chinese listed.
    /* en */ const forms = { zh: 'Hans', 'zh-Hant': 'Hant', '': '' }[hanRow(text)];
    return (forms && chinese.find((l) => scriptOfLanguage(l) === forms)) || chinese[0];
  }
  if (kind === 'Latn') {
    /* en */ const latin = of(['Latn']);
    const part = text.replace(URLS, ' ').replace(CJK, ' ');
    // Two listed Latin-script languages that both have small words: one word of one and none of the other's decides; else two (one is a name, or English's own).
    const min = s.explicit && latin.length > 1 && latin.every((l) => WORD_LISTS.has(l.name)) ? 1 : 2;
    const word = languageOf(part, min) || (VIETNAMESE.test(part) ? 'Vietnamese' : '');
    if (s.explicit) return word ? mine.find((l) => l.name === word) ?? null : latin.length === 1 ? latin[0] : null;
    if (word) return mine.find((l) => l.name === word) ?? LANGUAGES.find((l) => l.name === word) ?? null;
    // The phone's language, or English on a phone not in Latin letters; one small word of another language leaves the line unsure.
    const home = latin[0] ?? /** @type {Language} */ (BY_ID.get('en'));
    const one = languageOf(part, 1);
    return one && one !== home.name ? null : home;
  }
  const same = of([kind]);
  if (kind === 'Cyrl' && /[іїєґ]/iu.test(text)) return same.find((l) => l.id === 'uk') ?? open('uk');
  // Without its letters a Cyrillic line is not Ukrainian, unless that is the only Cyrillic language listed or the phone's (it stands for its script).
  const left = kind === 'Cyrl' && same.length > 1 ? same.filter((l) => l.id !== 'uk') : same;
  return left.length === 1 ? left[0] : left.length ? null : open(SCRIPTS_OF_LANGUAGES.get(kind)?.language.id ?? '');
}

/** The first of the traveller's languages written in Han, the one Han that says neither is taken for where nothing else decides (the voice's, the tag's and the summary's). @param {LanguageSettings} s */
export const firstHan = (s) => s.spoken.find((l) => HAN_SCRIPTS.includes(scriptOfLanguage(l))) ?? null;

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
  if (han + kana + hangul > (text.replace(CJK, ' ').match(/\p{L}+/gu)?.length ?? 0)) /* en */ return hangul > han + kana ? 'Korean' : kana ? 'Japanese' : 'Chinese';
  const other = han + kana + hangul ? '' : languageOf(text);
  return SCRIPT_TAGS[other] ? other : '';
}

/**
 * The tag of Han characters with no kana: Japanese when they are taken to be (placed takes no line with a character only Chinese writes for
 * Japanese); else Chinese, Simplified or Traditional by the characters when the text is Chinese by its writing (hanRow), and when they do not
 * tell, by Traditional screens, else by the language (the phone's, or the list's). @param {string} text @param {Language | null} l the language
 * they are taken to be @param {string} ui the screens'
 */
function hanTag(text, l, ui) {
  const row = hanRow(text);
  if (l?.id === 'ja') return 'ja';
  if (row === 'zh') return 'zh-Hans';
  if (l?.id === 'yue') return tagFor(l);
  return row === 'zh-Hant' || ui === 'zh-Hant' ? 'zh-Hant' : l ? tagFor(l) : 'zh-Hans';
}

/** What tagOf says for a line that must not take the screens' language and has none of its own (shown as `lang=""`). */
export const NO_LANGUAGE = 'und';
/** Whether most of a text's letters are in the script a language tag is likeliest written in (false for Han, which Unicode scripts name apart). @param {string} text @param {string} tag */
function writtenIn(text, tag) {
  try {
    return (text.match(new RegExp(`\\p{Script=${likelyScript(tag)}}`, 'gu'))?.length ?? 0) * 2 > (text.match(/[\p{L}\p{M}]/gu)?.length ?? 0);
  } catch { return false; } // 'Jpan', 'Hans' and 'Kore' are no Unicode script, nor ''
}
/** Whether a language is written in Latin letters, by its likeliest script. @param {string} tag */
const latinTag = (tag) => likelyScript(tag) === 'Latn';

/**
 * A line's BCP 47 tag, for its `lang`: a browser draws Han characters and a screen reader reads by it. From the writing system (scriptOf,
 * whose scale draws a line that is mostly Chinese, Japanese or Korean characters as what they are, a name in a Latin line too) and the one of
 * theirs those characters are placed as (placed): Han that says neither Japanese nor Chinese is the screens' language when that is one of
 * theirs, else the first of theirs written in Han; a script two of theirs share that nothing in the line tells, the first of them. Latin text
 * is never guessed (a wrong tag gives it a wrong voice): it and unsure text get '' and inherit the screens'. byShiori: the language she
 * answers in, where the text agrees with it; Han alone is taken for hers, if that is Japanese. ui: the screens' language. Under screens not in
 * Latin letters, a Latin line is the one listed Latin-script language if exactly one is, else the one languageOf names from two of its words,
 * else NO_LANGUAGE: never the screens'. Han that does not tell Simplified from Traditional is Traditional under Traditional Chinese screens.
 * @param {string} text @param {LanguageSettings} s @param {boolean} [byShiori] @param {string} [ui]
 */
export function tagOf(text, s, byShiori = false, ui = 'en') {
  const said = text.replace(URLS, ' ');
  // A line whose writing is Latin (an English sentence with a name in kanji) has no Chinese or Japanese tag: it is tagged as Latin text is.
  // A Chinese sentence naming a place in English with two small words (「我想去 The Museum of Modern Art，下午去中央公园。」) has full-width marks: its tag stays Chinese.
  const kind = writing(said) === 'Latn' && !/[。，、？！]/u.test(said) ? '' : scriptOf(said);
  const answer = byShiori ? s.answer : null;
  if (!kind) {
    if (!/\p{L}/u.test(said)) return '';
    // Hers, when most of the line is in the script her answer language is written in (Bengali, Tamil… as well as Latin).
    if (answer && writtenIn(said, tagFor(answer))) return tagFor(answer);
    if (latinTag(ui)) return '';
    if (!writtenIn(said, 'en')) return NO_LANGUAGE;
    const listed = s.spoken.filter((l) => latinTag(tagFor(l)));
    if (listed.length === 1) return tagFor(listed[0]);
    const guess = languageOf(said, 2);
    const named = guess ? LANGUAGES.find((l) => l.name === guess) : undefined;
    return named ? tagFor(named) : NO_LANGUAGE;
  }
  // Chinese, Japanese or Korean is placed by those characters alone, so the Latin words around them don't make it a mixed line.
  /* en */ const own = ['Chinese', 'Japanese', 'Korean'].includes(kind) ? (said.match(CJK) ?? []).join('') : said;
  const placedAs = (answer && placed(own, { explicit: true, spoken: [answer], answer })) || placed(own, s);
  const l = placedAs === EITHER
    ? s.spoken.find((x) => HAN_SCRIPTS.includes(scriptOfLanguage(x)) && tagFor(x) === ui) ?? firstHan(s)
    : placedAs ?? (kind === 'Chinese' ? null : s.spoken.find((x) => scriptOfLanguage(x) === likelyScript(SCRIPT_TAGS[kind])) ?? null);
  return kind === 'Chinese' ? hanTag(own, l, ui) : l ? tagFor(l) : SCRIPT_TAGS[kind];
}

/**
 * The locale browser voice uses: the answer language if she answers in one; else the one of theirs the sentence is placed as (placed), except
 * that with nothing chosen a sentence in the phone's own script is read in the phone's voice (a Dutch phone's Dutch sentence has "is" and
 * "open" in it: on real sentences of other languages the final review of detector-next measured a wrong voice for 0.9 to 3.2% of a
 * Latin-script phone's when placed decided). For other scripts placed gives the same answer (it stands the phone's language for its script:
 * a Ukrainian phone's Cyrillic is Ukrainian, where letting і ї є ґ decide gave a wrong voice for 6.9% of its real sentences), but for a
 * Ukrainian sentence with і ї є ґ on a Russian, Bulgarian or Serbian phone, which keeps the phone's voice so one reply is read in one voice;
 * a sentence in another script is read as what it is, so Japanese replies on an English phone still go from 1.9% to 98.7% given the right
 * voice. Han placed as none of theirs (a Chinese sentence with only Japanese listed) is read as Han that says neither. A sentence that shows none (a plan line of names and times; 「明天比較滿：」, Han that says neither Japanese nor Chinese) takes the language of her reply so far:
 * the first earlier sentence that shows one (for Han that says neither, one written in Han), not a reading of them joined, which one hiragana in
 * a name made Japanese; measured on her real sentences, 99.4 to 99.5% given the right voice in every list order of [en, ja] and [en, zh, ja],
 * against 96.5 to 99.5% without the reply so far.
 * Else Han that says neither is the first of theirs written in Han, a script two listed languages share the first of them written in it, and
 * anything else the first listed. Chinese whose characters say Simplified or Traditional (hanRow) takes a voice of that script.
 * @param {LanguageSettings} s @param {string} [text] @param {{ before?: string[] }} [o] before: her sentences before this one in the same utterance
 */
export function speechLocale(s, text = '', { before = [] } = {}) {
  const phone = s.explicit ? null : s.spoken[0];
  /** The one of theirs a sentence is read as, with nothing chosen the phone's for a sentence in its script. @param {string} x */
  const shown = (x) => (phone && writing(x) && writing(x) === scriptOfLanguage(phone) ? phone : placed(x, s));
  const kind = writing(text);
  const placedAs = s.answer ?? shown(text);
  // Han placed as none of theirs (a Chinese sentence with only Japanese listed: 靖國神社) is Han that says neither: the reply's Han language, else the first listed in Han.
  // An English sentence naming such a place ("Is 國立故宮博物院 far from here?") keeps its own reading.
  const own = !placedAs && kind === 'zh' && !/\p{Script=Latin}/u.test(text) ? EITHER : placedAs;
  /** The first earlier sentence that shows a language (for Han that says neither, one written in Han). @type {Language | null} */
  let sofar = null;
  if (!own || own === EITHER) {
    for (const x of before) {
      const l = shown(x);
      if (l && l !== EITHER && (!own || HAN_SCRIPTS.includes(scriptOfLanguage(l)))) { sofar = l; break; }
    }
  }
  const l = sofar ?? (own === EITHER ? firstHan(s) : own) ?? (kind ? s.spoken.find((x) => scriptOfLanguage(x) === kind) : null) ?? s.spoken[0];
  // Chinese in the other script than the row's is read with a voice of its own script, by the sentence's Han characters alone, as the tag reads them.
  const row = MANDARIN.includes(l.id) ? hanRow((text.match(CJK) ?? []).join('')) : '';
  return row && row !== (traditional(l.locale) ? 'zh-Hant' : 'zh') ? /** @type {Language} */ (BY_ID.get(row)).locale : l.locale;
}

/** The locale phone dictation listens in: Web Speech takes one tag, the first language listed, whatever Shiori answers in. @param {LanguageSettings} s */
export const dictationLocale = (s) => s.spoken[0].locale;

/**
 * A transcript of a user turn of fewer than 3 words (a Chinese, Japanese or Korean character counts as a word) plainly in a language not
 * listed ("¿Qué?" for a short English reply): that language's name, else ''. annai never treats it as the user changing language: it is
 * flagged in the trace, and languagesText covers the model's side. Plainly: a script, a mark only that language has, or two of its small
 * words; one word could be a name or English's own ("Per se.", "Um.").
 * @param {string} text @param {LanguageSettings} s
 */
export function strayLanguage(text, s) {
  const said = String(text).trim();
  if (!said || units(said) >= 3) return '';
  const guess = languageOf(said, 2) || vietnameseMarks(said, s.spoken);
  return guess && !listedFor(guess, s.spoken) ? guess : '';
}

/** What the model that reads a flagged heard line is told beside it: Kokoro should know a line may be a mishearing. @param {string} language */
export const strayNote = (language) => /* en */ ` (heard; may be misheard as ${language})`;

/**
 * The setting's own words, each a message. A status is a pair, what the line says while the change is written and what it says once it
 * has been, each whole so each can be translated whole.
 */
export const LANGUAGE_WORDS = {
  heading: t`Languages`,
  intro: t`The languages you speak, and the language Shiori answers in, are told to every model that hears or speaks, so a short reply is not taken for another language.`,
  spokenLabel: t`Languages you speak`,
  order: t`The first is the language phone dictation listens in; the order tells Shiori which you prefer.`,
  add: t`Add a language`,
  addButton: t`Add`,
  remove: t`Remove`,
  removeLabel: (/** @type {string} */ name) => t`Remove ${name}`,
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
  emptyHint: t`None picked: annai uses the browser’s language.`,
};
