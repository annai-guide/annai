/**
 * Sentences as they stream in (spec §10.1). The text of speak arrives a piece at a time, read from
 * the tool call's half-finished arguments; Intl.Segmenter finds where sentences end. Every segment
 * but the last is complete, and the last one is complete once the text is. A last segment longer
 * than LONG with no end in sight is cut after its last comma, so speaking can start sooner.
 */
export const LONG = 220;

export class Sentences {
  /** @type {Intl.Segmenter} */
  #segmenter;
  /** How much of the text has been handed out. */
  #taken = 0;

  /** @param {string} [locale] */
  constructor(locale) {
    try {
      this.#segmenter = new Intl.Segmenter(locale || undefined, { granularity: 'sentence' });
    } catch {
      this.#segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }
  }

  /**
   * The sentences complete in the text so far that weren't handed out yet.
   * @param {string} text all of the text so far @param {boolean} [final] the text is complete
   * @returns {string[]}
   */
  take(text, final = false) {
    const rest = String(text ?? '').slice(this.#taken);
    const parts = [...this.#segmenter.segment(rest)].map((s) => s.segment);
    /** @type {string[]} */
    const out = [];
    const complete = final ? parts.length : parts.length - 1;
    for (let i = 0; i < complete; i++) {
      this.#taken += parts[i].length;
      if (parts[i].trim()) out.push(parts[i].trim());
    }
    const last = final ? '' : parts.at(-1) ?? '';
    if (last.length > LONG) {
      const cut = Math.max(last.lastIndexOf(', ', LONG), last.lastIndexOf('; ', LONG));
      if (cut > 40) {
        this.#taken += cut + 1;
        out.push(last.slice(0, cut + 1).trim());
      }
    }
    return out;
  }
}
