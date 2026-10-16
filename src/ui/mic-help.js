import { platform } from './platform.js';
import { micProblem as words } from '../core/voice/mic.js';

/** What went wrong with the microphone, with steps for this phone (spec §17 rule 3). @param {unknown} e @param {'ios' | 'android' | 'desktop'} [where] */
export function micProblem(e, where = platform()) {
  return words(e, where);
}
