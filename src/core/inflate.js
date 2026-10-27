/**
 * Raw DEFLATE in plain code, for small pieces (a note in a backup is a few hundred bytes). The platform's
 * DecompressionStream costs a stream and several thread hops per call, which on a slow phone is far more
 * than the work: a backup of 300 notes spent minutes on hops (spec §12.1). Large entries still use the stream.
 * It follows zlib's "puff": counts and symbols, one bit at a time.
 */

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** @typedef {{ count: Uint16Array, symbol: Uint16Array }} Huffman */

/**
 * @param {ArrayLike<number>} lengths code length of each symbol, 0 for unused
 * @param {boolean} [partial] a code that doesn't use every bit pattern is allowed when it has one code of one bit (a lone distance), as zlib's puff has it
 * @returns {Huffman}
 */
function huffman(lengths, partial = false) {
  const count = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
  // Over-subscribed (more codes than the lengths have room for) or incomplete codes are damaged data, as in zlib.
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - count[len];
    if (left < 0) /* en */ throw new Error('bad code lengths');
  }
  if (left > 0 && !(partial && count[0] + count[1] === lengths.length)) /* en */ throw new Error('incomplete code');
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  const symbol = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

const FIXED_LIT = huffman([...Array(144).fill(8), ...Array(112).fill(9), ...Array(24).fill(7), ...Array(8).fill(8)]);
const FIXED_DIST = huffman(Array(32).fill(5)); // 30 codes are used; the last two are never sent

/**
 * @param {Uint8Array} data raw DEFLATE
 * @param {number} limit the size it must unpack to at most; more throws a RangeError
 * @returns {Uint8Array}
 */
export function inflateSmall(data, limit) {
  const out = new Uint8Array(limit);
  let pos = 0;
  let outPos = 0;
  let buf = 0;
  let cnt = 0;
  /** @param {number} need */
  const bits = (need) => {
    let v = buf;
    while (cnt < need) {
      if (pos >= data.length) /* en */ throw new Error('ran out of data');
      v |= data[pos++] << cnt;
      cnt += 8;
    }
    buf = v >>> need;
    cnt -= need;
    return v & ((1 << need) - 1);
  };
  /** @param {Huffman} h */
  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const n = h.count[len];
      if (code - n < first) return h.symbol[index + (code - first)];
      index += n;
      first += n;
      first <<= 1;
      code <<= 1;
    }
    /* en */ throw new Error('bad code');
  };
  /** @param {Huffman} lit @param {Huffman} dist */
  const codes = (lit, dist) => {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) {
        if (outPos >= limit) throw new RangeError('over');
        out[outPos++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) /* en */ throw new Error('bad length');
        const len = LBASE[sym] + bits(LEXT[sym]);
        const ds = decode(dist);
        if (ds >= 30) /* en */ throw new Error('bad distance');
        const d = DBASE[ds] + bits(DEXT[ds]);
        if (d > outPos) /* en */ throw new Error('bad distance');
        if (outPos + len > limit) throw new RangeError('over');
        for (let i = 0; i < len; i++, outPos++) out[outPos] = out[outPos - d];
      }
    }
  };
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      buf = 0;
      cnt = 0;
      if (pos + 4 > data.length) /* en */ throw new Error('ran out of data');
      const len = data[pos] | (data[pos + 1] << 8);
      if (len !== (~(data[pos + 2] | (data[pos + 3] << 8)) & 0xffff)) /* en */ throw new Error('bad stored block');
      pos += 4;
      if (pos + len > data.length) /* en */ throw new Error('ran out of data');
      if (outPos + len > limit) throw new RangeError('over');
      out.set(data.subarray(pos, pos + len), outPos);
      pos += len;
      outPos += len;
    } else if (type === 1) {
      codes(FIXED_LIT, FIXED_DIST);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) /* en */ throw new Error('bad counts');
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[ORDER[i]] = bits(3);
      const lencode = huffman(lengths.subarray(0, 19));
      const all = new Uint8Array(nlen + ndist);
      for (let i = 0; i < all.length;) {
        const sym = decode(lencode);
        if (sym < 16) {
          all[i++] = sym;
          continue;
        }
        let prev = 0;
        let rep;
        if (sym === 16) {
          if (i === 0) /* en */ throw new Error('bad repeat');
          prev = all[i - 1];
          rep = 3 + bits(2);
        } else rep = sym === 17 ? 3 + bits(3) : 11 + bits(7);
        if (i + rep > all.length) /* en */ throw new Error('bad repeat');
        while (rep--) all[i++] = prev;
      }
      codes(huffman(all.subarray(0, nlen), true), huffman(all.subarray(nlen), true));
    } else /* en */ throw new Error('bad block');
  } while (!last);
  return out.subarray(0, outPos);
}
