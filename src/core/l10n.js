/**
 * annai's words in the interface's language (localization design, section 1). English is written where it is used, marked
 * t`…`, tc(context)`…` or plural(n, one, other); a message's key is a hash of its context and English, so changed English flags
 * its translations. With no words set the English shows, and a translation is used only when its placeholders are the English's.
 * Pure: boot.js sets the words before main.js loads.
 */
import { SHIPPED } from './l10n-list.js';

const RTL = ['ar', 'he', 'fa', 'ur'];
let tag = 'en';
/** @type {Record<string, string | Record<string, string>> | null} */
let table = null;
/** @type {((english: string) => string) | null} a pseudo-locale's transform (development only) */
let pseudo = null;
/** @type {WeakMap<TemplateStringsArray, string>} each call site's chosen text, with {0}… for its values */
let seen = new WeakMap();
/** @type {Intl.PluralRules | null} */
let rules = null;

/** Sets the interface language and its words, at the start and in tests. @param {string} next @param {Record<string, any> | null} words @param {(english: string) => string} [transform] */
export function setWords(next, words, transform) { tag = next; table = words; pseudo = transform ?? null; seen = new WeakMap(); rules = null; }
/** The interface's language tag ("en", "ja", "zh-Hans"), and its direction. */
export const lang = () => tag;
export const dir = () => (RTL.includes(tag.split('-')[0]) ? 'rtl' : 'ltr');
export { SHIPPED };

/** A message's key: FNV-1a over its UTF-8, in base 36. @param {string} source @param {string} [context] */
export function key(source, context) {
  let n = 0x811c9dc5;
  for (const b of new TextEncoder().encode(context ? `${context}\u0001${source}` : source)) n = Math.imul(n ^ b, 0x01000193);
  return (n >>> 0).toString(36);
}
/** The placeholders of a text, each once: "{1} and {0}" → "{0}{1}". @param {string} s */
export const holes = (s) => [...new Set(s.match(/\{\d+\}/g))].sort().join('');

/** A value as it goes into a message: isolated in a right-to-left language, so a Latin name keeps its place. @param {unknown} v */
const wrap = (v) => (dir() === 'rtl' ? `⁨${v}⁩` : String(v));
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
 * A message that depends on a number: plural(n, '# stamp', '# stamps'). `#` is n, formatted for the language; {0}… are the
 * other values. The words give a text per category the language has (Japanese one, English two, Arabic six).
 * @param {number} n @param {string} one @param {string} other @param {...unknown} values
 */
export function plural(n, one, other, ...values) {
  rules ??= new Intl.PluralRules(table ? tag : 'en');
  const category = rules.select(n);
  const forms = table?.[key(`${one}\0${other}`)];
  const own = forms && typeof forms === 'object' ? forms[category] ?? forms.other : undefined;
  const english = category === 'one' ? one : other;
  const text = typeof own === 'string' && holes(own) === holes(`${one}${other}`) ? own : pseudo ? pseudo(english) : english;
  const shown = n.toLocaleString(table ? tag : 'en');
  return text.replace(/#|\{(\d+)\}/g, (m, i) => (i === undefined ? shown : wrap(values[i])));
}
