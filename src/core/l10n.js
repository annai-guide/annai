/**
 * annai's words in the interface's language (localization design, section 1): t`…`, tc(context)`…` and plural(n, one, other) show
 * their English until words are set (by boot.js, before main.js loads), and a translation only when its placeholders are the
 * English's. A message's key is a hash of its context and English, so changed English flags its translations.
 */
let tag = 'en';
/** @type {Record<string, string | Record<string, string>> | null} */
let table = null;
/** @type {((english: string) => string) | null} a pseudo-locale's transform (development only) */
let pseudo = null;
/** @type {WeakMap<TemplateStringsArray, string>} each call site's chosen text, with {0}… for its values */
let seen = new WeakMap();
/** @type {Intl.PluralRules | null} */
let rules = null;

/** Sets the language and words, at the start and in tests. @param {string} next @param {Record<string, any> | null} words @param {(english: string) => string} [transform] */
export function setWords(next, words, transform) { tag = next; table = words; pseudo = transform ?? null; seen = new WeakMap(); rules = null; }
export const lang = () => tag;

let phoneSeen = '';
let current = 'en-US';
/** The formats' locale: the interface language with the phone's region ("en-GB", "en-DE"; "ja" for ja-US, as Intl resolves it). */
export function locale() {
  const phone = globalThis.navigator?.language || 'en-US';
  if (phoneSeen !== `${tag}|${phone}`) {
    phoneSeen = `${tag}|${phone}`;
    try {
      current = new Intl.Locale(tag, { region: new Intl.Locale(phone).maximize().region }).toString();
    } catch {
      current = tag;
    }
  }
  return current;
}
export const dir = () => (['ar', 'he', 'fa', 'ur'].includes(tag.split('-')[0]) ? 'rtl' : 'ltr');

/** A message's key: FNV-1a over its UTF-8, base 36. @param {string} source @param {string} [context] */
export function key(source, context) {
  let n = 0x811c9dc5;
  for (const b of new TextEncoder().encode(context ? `${context}\u0001${source}` : source)) n = Math.imul(n ^ b, 0x01000193);
  return (n >>> 0).toString(36);
}
/** Whether two tags are one language and script (zh-TW is zh-Hant, not zh-Hans). @param {string} a @param {string} b */
function sameLanguage(a, b) {
  try {
    const [x, y] = [new Intl.Locale(a).maximize(), new Intl.Locale(b).maximize()];
    return x.language === y.language && x.script === y.script;
  } catch { return false; /* not a language tag */ }
}
/**
 * The screens' language at the start and the region its formats take. own: the choice kept on the device (`annai.ui`); offered: what
 * it may be; shipped: what the phone's languages are matched against (a draft is only ever chosen). A choice no longer offered is
 * as none: the first of the phone's languages annai has, not straight English. The region is the phone's, from its first language
 * that is the chosen one (ja chosen on a ja-JP phone gives ja-JP).
 * @param {string | null | undefined} own @param {readonly string[]} phone @param {readonly string[]} offered @param {readonly string[]} [shipped]
 * @returns {{ tag: string, region: string }}
 */
export function chooseTag(own, phone, offered, shipped = offered) {
  const regionOf = (/** @type {string} */ tag) => {
    for (const wanted of phone) if (sameLanguage(wanted, tag)) { try { return new Intl.Locale(wanted).region ?? ''; } catch { return ''; } }
    return '';
  };
  if (own && offered.includes(own)) return { tag: own, region: regionOf(own) };
  for (const wanted of phone) {
    const found = shipped.find((s) => sameLanguage(wanted, s));
    if (found) return { tag: found, region: regionOf(found) };
  }
  return { tag: 'en', region: '' };
}

/** A text's placeholders, once each: "{1} {0}" → "{0}{1}". @param {string} s */
export const holes = (s) => [...new Set(s.match(/\{\d+\}/g))].sort().join('');

/** A value in a message, isolated in a right-to-left language so a Latin name keeps its place. @param {unknown} v */
const wrap = (v) => (dir() === 'rtl' ? `\u2068${v}\u2069` : String(v));
/** @param {TemplateStringsArray} strings @param {unknown[]} values @param {string} [context] */
function say(strings, values, context) {
  let text = seen.get(strings);
  if (text === undefined) {
    const source = strings.reduce((s, p, i) => `${s}{${i - 1}}${p}`);
    const own = table?.[key(source, context)];
    seen.set(strings, text = typeof own === 'string' && holes(own) === holes(source) ? own : pseudo ? pseudo(source) : source);
  }
  return text.replace(/\{(\d+)\}/g, (m, i) => wrap(values[i]));
}

/** A message: t`Last backup ${when}, to ${where}.`. @param {TemplateStringsArray} strings @param {...unknown} values */
export const t = (strings, ...values) => (table || pseudo ? say(strings, values) : strings.reduce((s, p, i) => `${s}${values[i - 1]}${p}`));
/** A message with a context, for English that means two things: tc('verb')`Open`. @param {string} context */
export const tc = (context) => (/** @type {TemplateStringsArray} */ strings, /** @type {unknown[]} */ ...values) => say(strings, values, context);

/**
 * plural(n, '# stamp', '# stamps'): `#` is n, formatted for the language; {0}… are the other values. The words give a text per
 * plural category of the language (Japanese one, English two, Arabic six).
 * @param {number} n @param {string} one @param {string} other @param {...unknown} values
 */
export function plural(n, one, other, ...values) {
  const forms = table?.[key(`${one}\0${other}`)];
  const own = forms && typeof forms === 'object' ? forms[(rules ??= new Intl.PluralRules(tag)).select(n)] ?? forms.other : undefined;
  // English without a translation, counted the English way.
  const english = Math.abs(n) === 1 ? one : other;
  const text = typeof own === 'string' && holes(own) === holes(`${one}${other}`) ? own : pseudo ? pseudo(english) : english;
  const shown = n.toLocaleString(locale());
  return text.replace(/#|\{(\d+)\}/g, (m, i) => (i === undefined ? shown : wrap(values[i])));
}
