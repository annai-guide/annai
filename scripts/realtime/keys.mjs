// The Gemini keys a realtime check uses (test/live is opt-in and costs quota, never money: free keys only). A key is read
// here, inside the process that uses it, from the environment or from named lines of a file; it is held in private
// fields, so JSON.stringify and util.inspect of this object show nothing, and every text that leaves the process goes
// through scrub() or assertClean() first.
import { readFileSync } from 'node:fs';

/**
 * "3", "1-11" or "1,3-4" as line numbers (1-based). Anything else is an error: a key file is never read by guesswork.
 * @param {string} spec @returns {number[]}
 */
export function parseLines(spec) {
  const out = /** @type {number[]} */ ([]);
  for (const part of String(spec).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    const from = m ? Number(m[1]) : 0;
    const to = m ? Number(m[2] ?? m[1]) : 0;
    if (!m || from < 1 || to < from) throw new Error(`The lines must look like 3, 1-11 or 1,3-4; got "${spec}".`);
    for (let i = from; i <= to; i++) out.push(i);
  }
  return out;
}

export class Keys {
  /** @type {{ line: number | null, key: string }[]} */
  #held;
  #at = 0;

  /** @param {{ line: number | null, key: string }[]} held */
  constructor(held) {
    if (!held.length) throw new Error('There is no key to use.');
    this.#held = held;
  }

  /** The lines of a file, only those named, an empty one skipped. @param {string} text @param {string} spec */
  static fromFile(text, spec) {
    const rows = text.split('\n');
    const held = parseLines(spec).flatMap((line) => {
      const key = (rows[line - 1] ?? '').trim();
      return key ? [{ line, key }] : [];
    });
    if (!held.length) throw new Error(`There is no key on the lines ${spec}.`);
    return new Keys(held);
  }

  /** @param {string} path @param {string} spec */
  static fromPath(path, spec) {
    return Keys.fromFile(readFileSync(path, 'utf8'), spec);
  }

  /** One key, from GEMINI_KEY. @param {Record<string, string | undefined>} env */
  static fromEnvironment(env) {
    const key = (env.GEMINI_KEY ?? '').trim();
    if (!key) throw new Error('Set GEMINI_KEY, or give --keys-file with --lines.');
    return new Keys([{ line: null, key }]);
  }

  /** The key in use. */
  get key() {
    return this.#held[this.#at].key;
  }

  /** Its line in the file (for saying which was used, never what it is), or null. */
  get line() {
    return this.#held[this.#at].line;
  }

  /** Every line held. */
  get lines() {
    return this.#held.flatMap((h) => (h.line === null ? [] : [h.line]));
  }

  /** Moves to the next key (after a 429); false when there is none. */
  advance() {
    if (this.#at + 1 >= this.#held.length) return false;
    this.#at++;
    return true;
  }

  /** Blanks every key held, in the forms an address or a header would carry. @param {string} text */
  scrub(text) {
    let out = String(text);
    for (const { key } of this.#held) for (const form of new Set([key, encodeURIComponent(key)])) out = out.split(form).join('«key»');
    return out;
  }

  /** Throws, without repeating the key, when a text holds one. @param {string} text @param {string} [what] */
  assertClean(text, what = 'the output') {
    if (this.scrub(text) !== text) throw new Error(`A key was about to appear in ${what}; stopped.`);
  }
}
