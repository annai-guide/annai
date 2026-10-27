import { wordsOver } from '../../src/core/l10n.js';
import { num, money, size, distance, duration, relTime, when, day, list, sentences } from '../../src/core/intl.js';

/** annai.l10n as a plugin gets it, for tests that hand a plugin a stand-in annai: English, or the words given (as on other screens). @param {Record<string, any> | null} [words] */
export const pluginWords = (words = null) => ({ lang: 'en', dir: 'ltr', ...wordsOver(words), format: { num, money, size, distance, duration, relTime, when, day, list, sentences } });
