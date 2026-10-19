import { newId } from '../scopes.js';
import { asksOrNotes, quote } from './blocks.js';

/**
 * The channel between the halves (the Koe and Kokoro design): Koe's tell_kokoro and Kokoro's
 * tell_koe. A note is written into the conversation first (each half reads the other's: Kokoro as a
 * block, Koe inside annai's own marker), then handed over, and the sender never waits. append reaches
 * the other half before its next model call, or starts a turn; immediate cuts its call or speech too.
 * @typedef {'koe' | 'kokoro'} HalfName
 * @typedef {'append' | 'immediate'} Mode
 * @typedef {'tool' | 'gated:speak' | 'gated:show' | 'gated:ask' | 'final-text' | 'kokoro-failed' | 'nothing-to-add'} NoteWhy
 * @typedef {import('./loop.js').Wake} Wake
 */

export class Channel {
  /**
   * @param {{ log: Record<HalfName, (ev: any) => Promise<any>>, deliver: Record<HalfName, (w: Wake) => void>, cut: Record<HalfName, () => void> }} c
   *   log: each half's own writing (its events take turns with the other's); deliver: a wake for a half; cut: cuts in on a half
   */
  constructor({ log, deliver, cut }) {
    this.log = log;
    this.deliver = deliver;
    this.cut = cut;
  }

  /**
   * Records a note, then hands it over; never waits for the other half.
   * @param {HalfName} from @param {string} text @param {Mode} mode @param {NoteWhy} why @param {string} [wake] the wake of the turn it came from
   * @returns {Promise<'sent'>}
   */
  async send(from, text, mode, why, wake) {
    const to = from === 'koe' ? 'kokoro' : 'koe';
    await this.log[from]({ type: 'note', actor: 'shiori', data: { id: newId('n'), from, mode, why, ...(wake ? { wake } : {}) }, texts: [['text', text]] });
    // Why the other half woke, for its now block: Koe never mentions Kokoro, so its line says only that a note came.
    const said = from === 'koe' ? `Koe ${asksOrNotes(text)}: ${quote(text.length > 120 ? `${text.slice(0, 120)}…` : text)}` : 'a note from Kokoro';
    this.deliver[to]({ kind: 'note', logged: true, from, text: said });
    if (mode === 'immediate') this.cut[to]();
    return 'sent';
  }
}

/**
 * The tool each half reaches the other with: Koe's tell_kokoro, Kokoro's tell_koe.
 * @param {HalfName} from @param {Channel} channel @param {() => string | null} [refuse] why the other half can't take a note now
 * @returns {import('./loop.js').LoopTool}
 */
export function channelTool(from, channel, refuse = () => null) {
  const koe = from === 'koe';
  return {
    name: koe ? 'tell_kokoro' : 'tell_koe', pluginId: 'core', group: 'Talk',
    description: koe
      ? "Ask or tell Kokoro, your other half, who looks things up and works behind you. It returns at once; Kokoro's answer comes as a note. mode immediate cuts Kokoro off mid-task: use it only when something really should be cut off."
      : 'Tell Koe, who talks with the user, what to say or know: an answer, or a correction with the fact and its source. Koe says it in its own words. It returns at once. mode immediate cuts Koe off mid-sentence: use it only when something really should be cut off, such as a wrong claim.',
    input: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, mode: { enum: ['append', 'immediate'] } }, required: ['text'] },
    run: async (/** @type {{ text: string, mode?: string }} */ i, /** @type {any} */ call) => {
      const text = String(i.text ?? '').trim();
      if (!text) return { content: `Error: ${koe ? 'tell_kokoro' : 'tell_koe'} needs the text to pass on.`, isError: true };
      const no = refuse();
      if (no) return { content: no, isError: true };
      return channel.send(from, text, i.mode === 'immediate' ? 'immediate' : 'append', 'tool', call.wake);
    },
  };
}
