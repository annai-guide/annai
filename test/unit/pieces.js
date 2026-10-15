/**
 * A Blob that can only be read in slices, and remembers the largest slice taken.
 * Code that works on one of these never needs the whole file in memory at once.
 */
export class PiecesOnly extends Blob {
  largest = 0;
  arrayBuffer() { return Promise.reject(new Error('read the whole file at once')); }
  text() { return Promise.reject(new Error('read the whole file at once')); }
  /** @returns {never} */
  stream() { throw new Error('read the whole file at once'); }
  /** @param {number} [start] @param {number} [end] @param {string} [type] */
  slice(start, end, type) {
    const s = super.slice(start, end, type);
    this.largest = Math.max(this.largest, s.size);
    return s;
  }
}

/** @param {Blob} b */
export const bytesOf = async (b) => new Uint8Array(await b.arrayBuffer());

/** @param {Uint8Array} b */
export const blobOf = (b) => new Blob([/** @type {BlobPart} */ (b)]);
