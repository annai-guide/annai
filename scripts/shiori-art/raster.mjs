// Raster helpers for the art tool: colour classes, masks, distances, filling hidden areas, and PBM files for potrace.

/** @typedef {import('./png.mjs').Image} Image */
/** A label map: one class index per pixel, 0 for nothing. @typedef {{ width: number, height: number, data: Uint8Array }} Labels */
/** @typedef {{ width: number, height: number, data: Uint8Array }} Mask 1 where set */

/** @param {string} h like '3E1A10' @returns {number[]} */
export const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));

/**
 * Sorts each pixel into the nearest of the given colours, or into a blend of two of them (an anti-aliased edge goes to
 * the nearer end of its blend). Pixels under half opacity are 0; class k is index k - 1 of colours.
 * @param {Image} img @param {number[][]} colours
 * @returns {Labels}
 */
export function classify(img, colours) {
  const out = new Uint8Array(img.width * img.height);
  const n = colours.length;
  for (let p = 0; p < out.length; p++) {
    const i = p * 4;
    if (img.data[i + 3] < 128) continue;
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < n; k++) {
      const [cr, cg, cb] = colours[k];
      const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
      if (d < bd) [bd, best] = [d, k];
    }
    bd = Math.sqrt(bd);
    if (bd < 14) {
      out[p] = best + 1; // a flat colour, not an edge
      continue;
    }
    for (let a = 0; a < n; a++) {
      for (let c = a + 1; c < n; c++) {
        const A = colours[a];
        const B = colours[c];
        const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const ac = [r - A[0], g - A[1], b - A[2]];
        const t = (ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2);
        if (t <= 0.02 || t >= 0.98) continue;
        const d = Math.hypot(ac[0] - t * ab[0], ac[1] - t * ab[1], ac[2] - t * ab[2]) + 6; // a pure colour wins a tie
        if (d < bd) [bd, best] = [d, t < 0.5 ? a : c];
      }
    }
    out[p] = best + 1;
  }
  return { width: img.width, height: img.height, data: out };
}

/** @param {number} width @param {number} height @returns {Mask} */
export const blank = (width, height) => ({ width, height, data: new Uint8Array(width * height) });

/** @param {Labels} labels @param {(label: number, p: number) => boolean} test @returns {Mask} */
export function where(labels, test) {
  const m = blank(labels.width, labels.height);
  for (let p = 0; p < m.data.length; p++) m.data[p] = test(labels.data[p], p) ? 1 : 0;
  return m;
}

/** @param {...Mask} ms */
export const union = (...ms) => ({ ...ms[0], data: ms[0].data.map((_, p) => (ms.some((m) => m.data[p]) ? 1 : 0)) });
/** @param {Mask} a @param {Mask} b */
export const minus = (a, b) => ({ ...a, data: a.data.map((v, p) => (v && !b.data[p] ? 1 : 0)) });
/** @param {Mask} a @param {Mask} b */
export const and = (a, b) => ({ ...a, data: a.data.map((v, p) => (v && b.data[p] ? 1 : 0)) });
/** @param {Mask} a */
export const not = (a) => ({ ...a, data: a.data.map((v) => (v ? 0 : 1)) });

/**
 * The 4-connected region of set pixels holding (x, y).
 * @param {Mask} m @param {number} x @param {number} y @returns {Mask}
 */
export function region(m, x, y) {
  const { width, height } = m;
  const out = blank(width, height);
  const start = y * width + x;
  if (!m.data[start]) throw new Error(`region: (${x}, ${y}) is not set`);
  const stack = new Int32Array(width * height);
  let top = 0;
  stack[top++] = start;
  out.data[start] = 1;
  while (top) {
    const p = stack[--top];
    const px = p % width;
    for (const q of [p - 1, p + 1, p - width, p + width]) {
      if (q < 0 || q >= m.data.length || (q === p - 1 && px === 0) || (q === p + 1 && px === width - 1)) continue;
      if (m.data[q] && !out.data[q]) {
        out.data[q] = 1;
        stack[top++] = q;
      }
    }
  }
  return out;
}

/** The mask with its holes filled: everything not reachable from the border through unset pixels. @param {Mask} m */
export function fillHoles(m) {
  const { width, height } = m;
  const outside = blank(width, height);
  const stack = new Int32Array(width * height);
  let top = 0;
  const push = (/** @type {number} */ p) => {
    if (!m.data[p] && !outside.data[p]) {
      outside.data[p] = 1;
      stack[top++] = p;
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (top) {
    const p = stack[--top];
    const px = p % width;
    if (px > 0) push(p - 1);
    if (px < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < (height - 1) * width) push(p + width);
  }
  return not(outside);
}

/**
 * Exact Euclidean distance to the nearest set pixel, and which pixel that is (Felzenszwalb and Huttenlocher).
 * @param {Mask} m @returns {{ dist: Float32Array, near: Int32Array }} near is -1 where m is empty
 */
export function distance(m) {
  const { width, height } = m;
  const INF = 1e20;
  const n = width * height;
  const col = new Float64Array(n); // squared distance down each column
  const colSite = new Int32Array(n); // the row of that nearest site
  const f = new Float64Array(Math.max(width, height));
  const d = new Float64Array(Math.max(width, height));
  const arg = new Int32Array(Math.max(width, height));
  const v = new Int32Array(Math.max(width, height));
  const z = new Float64Array(Math.max(width, height) + 1);
  /** 1D squared distance transform of f[0..len), into d and arg. @param {number} len */
  const dt = (len) => {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + f[v[k]];
      arg[q] = v[k];
    }
  };
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = m.data[y * width + x] ? 0 : INF;
    dt(height);
    for (let y = 0; y < height; y++) {
      col[y * width + x] = d[y];
      colSite[y * width + x] = arg[y];
    }
  }
  const dist = new Float32Array(n);
  const near = new Int32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = col[y * width + x];
    dt(width);
    for (let x = 0; x < width; x++) {
      const sx = arg[x];
      const sy = colSite[y * width + sx];
      const sq = d[x];
      dist[y * width + x] = sq >= INF ? Infinity : Math.sqrt(sq);
      near[y * width + x] = sq >= INF ? -1 : sy * width + sx;
    }
  }
  return { dist, near };
}

/** Set pixels and everything within r of them. @param {Mask} m @param {number} r */
export function grow(m, r) {
  const { dist } = distance(m);
  return { ...m, data: Uint8Array.from(dist, (d) => (d <= r ? 1 : 0)) };
}

/**
 * Fills the pixels under hole with the label of the nearest pixel outside it whose label passes keep: what a moving
 * part needs where it covered something in the art.
 * @param {Labels} labels @param {Mask} hole @param {(label: number) => boolean} keep @returns {Labels}
 */
export function inpaint(labels, hole, keep) {
  const source = where(labels, (l, p) => !hole.data[p] && l !== 0 && keep(l));
  const { near } = distance(source);
  const out = labels.data.slice();
  for (let p = 0; p < out.length; p++) if (hole.data[p] && near[p] >= 0) out[p] = labels.data[near[p]];
  return { ...labels, data: out };
}

/**
 * A polygon as a mask (even-odd, sampled at pixel centres).
 * @param {number} width @param {number} height @param {number[][]} pts [[x, y], ...] @returns {Mask}
 */
export function polygon(width, height, pts) {
  const m = blank(width, height);
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    /** @type {number[]} */
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= cy) !== (y2 <= cy)) xs.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x < Math.min(width, Math.ceil(xs[i + 1] - 0.5)); x++) m.data[y * width + x] = 1;
    }
  }
  return m;
}

/**
 * Places an image on a new canvas: its pixel `from` lands on the canvas's `to`, scaled by `scale` and turned by
 * `angle` degrees (clockwise) about that point. Bilinear, on premultiplied colour.
 * @param {Image} img @param {{ scale?: number, angle?: number, from?: number[], to?: number[] }} at
 * @param {number} width @param {number} height
 * @returns {Image}
 */
export function place(img, { scale = 1, angle = 0, from = [0, 0], to = [0, 0] }, width, height) {
  const out = new Uint8Array(width * height * 4);
  const cos = Math.cos((angle * Math.PI) / 180);
  const sin = Math.sin((angle * Math.PI) / 180);
  const px = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ k) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
    const i = (y * img.width + x) * 4;
    return k === 3 ? img.data[i + 3] : (img.data[i + k] * img.data[i + 3]) / 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // back from the canvas to the image: undo the move, the turn and the scale
      const ox = x + 0.5 - to[0];
      const oy = y + 0.5 - to[1];
      const sx = (ox * cos + oy * sin) / scale + from[0] - 0.5;
      const sy = (-ox * sin + oy * cos) / scale + from[1] - 0.5;
      if (sx < -1 || sy < -1 || sx > img.width || sy > img.height) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const c = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        c[k] = px(x0, y0, k) * (1 - fx) * (1 - fy) + px(x0 + 1, y0, k) * fx * (1 - fy) + px(x0, y0 + 1, k) * (1 - fx) * fy + px(x0 + 1, y0 + 1, k) * fx * fy;
      }
      const i = (y * width + x) * 4;
      if (c[3] <= 0) continue;
      out[i] = Math.round((c[0] * 255) / c[3]);
      out[i + 1] = Math.round((c[1] * 255) / c[3]);
      out[i + 2] = Math.round((c[2] * 255) / c[3]);
      out[i + 3] = Math.round(c[3]);
    }
  }
  return { width, height, data: out };
}

/** A mask as a binary PBM (P4), set pixels black: what potrace traces. @param {Mask} m @returns {Buffer} */
export function pbm(m) {
  const rowBytes = Math.ceil(m.width / 8);
  const head = Buffer.from(`P4\n${m.width} ${m.height}\n`, 'latin1');
  const body = Buffer.alloc(rowBytes * m.height);
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x]) body[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return Buffer.concat([head, body]);
}

/**
 * A mask blurred (three box blurs, close to a Gaussian of the given sigma) to coverage 0..1.
 * @param {Mask} m @param {number} sigma @returns {Float32Array}
 */
export function blur(m, sigma) {
  const { width, height } = m;
  let a = Float32Array.from(m.data);
  let b = new Float32Array(a.length);
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      const row = y * width;
      for (let x = -r; x <= r; x++) sum += a[row + Math.min(width - 1, Math.max(0, x))];
      for (let x = 0; x < width; x++) {
        b[row + x] = sum / (2 * r + 1);
        sum += a[row + Math.min(width - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    [a, b] = [b, a];
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += a[Math.min(height - 1, Math.max(0, y)) * width + x];
      for (let y = 0; y < height; y++) {
        b[y * width + x] = sum / (2 * r + 1);
        sum += a[Math.min(height - 1, y + r + 1) * width + x] - a[Math.max(0, y - r) * width + x];
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

/**
 * The mask without its small islands, and with its small holes filled: what grain in a picture leaves behind.
 * @param {Mask} m @param {number} area the largest island or hole to clean away, in pixels
 */
export function despeckle(m, area) {
  const clean = (/** @type {Uint8Array} */ data, /** @type {number} */ value) => {
    const { width, height } = m;
    const seen = new Uint8Array(data.length);
    const stack = new Int32Array(data.length);
    const members = new Int32Array(area + 1);
    for (let start = 0; start < data.length; start++) {
      if (data[start] !== value || seen[start]) continue;
      let top = 0;
      let n = 0;
      stack[top++] = start;
      seen[start] = 1;
      while (top) {
        const p = stack[--top];
        if (n <= area) members[n] = p;
        n++;
        const x = p % width;
        for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p >= width ? p - width : -1, p < (height - 1) * width ? p + width : -1]) {
          if (q >= 0 && data[q] === value && !seen[q]) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
      if (n <= area) for (let i = 0; i < n; i++) data[members[i]] = 1 - value;
    }
  };
  const data = m.data.slice();
  clean(data, 1);
  clean(data, 0);
  return { ...m, data };
}
