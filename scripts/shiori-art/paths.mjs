// Turns potrace's SVG into compact path data: every point moved into the art's units and rounded to whole units,
// written relative to the previous rounded point so rounding never drifts.

/**
 * @param {string} svg potrace output (-s)
 * @param {(x: number, y: number) => number[]} to canvas pixels to art units
 * @returns {string} path data, or '' when the layer is empty
 */
export function tracedPath(svg, to) {
  const tr = /translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+),([-\d.]+)\)/.exec(svg);
  if (!tr) return '';
  const [tx, ty, sx, sy] = tr.slice(1).map(Number);
  const ds = [...svg.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]);
  /** @type {string[]} */
  const out = [];
  for (const d of ds) out.push(convert(d, (x, y) => to(tx + sx * x, ty + sy * y)));
  return out.join('');
}

/** @param {string} d @param {(x: number, y: number) => number[]} to */
function convert(d, to) {
  const tokens = d.match(/[MmLlCcZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // the last rounded point written, which the next relative numbers count from
  let rx = 0;
  let ry = 0;
  let last = '';
  let s = '';
  const num = () => Number(tokens[i++]);
  /** @param {string} c @param {number[]} vals */
  const emit = (c, vals) => {
    if (c !== last || c === 'M') s += c; // a repeated command needs no letter
    for (const v of vals) {
      const t = String(v);
      s += /[A-Za-z]$/.test(s) || t.startsWith('-') ? t : ` ${t}`;
    }
    last = c;
  };
  /** @param {number} ax @param {number} ay */
  const point = (ax, ay) => {
    const [u, v] = to(ax, ay);
    return [Math.round(u), Math.round(v)];
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[A-Za-z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'z' || cmd === 'Z') {
        x = startX;
        y = startY;
        s += 'z';
        last = 'z';
        const [u, v] = point(x, y);
        rx = u;
        ry = v;
      }
      continue;
    }
    if (cmd === 'M' || cmd === 'm') {
      const nx = num();
      const ny = num();
      x = cmd === 'M' ? nx : x + nx;
      y = cmd === 'M' ? ny : y + ny;
      startX = x;
      startY = y;
      const [u, v] = point(x, y);
      emit('M', [u, v]);
      rx = u;
      ry = v;
      cmd = cmd === 'M' ? 'L' : 'l'; // further pairs are lines
    } else if (cmd === 'c' || cmd === 'C') {
      const rel = cmd === 'c';
      const c = [num(), num(), num(), num(), num(), num()];
      const p1 = point(rel ? x + c[0] : c[0], rel ? y + c[1] : c[1]);
      const p2 = point(rel ? x + c[2] : c[2], rel ? y + c[3] : c[3]);
      x = rel ? x + c[4] : c[4];
      y = rel ? y + c[5] : c[5];
      const p3 = point(x, y);
      if (p3[0] === rx && p3[1] === ry && p1[0] === rx && p1[1] === ry && p2[0] === rx && p2[1] === ry) continue;
      emit('c', [p1[0] - rx, p1[1] - ry, p2[0] - rx, p2[1] - ry, p3[0] - rx, p3[1] - ry]);
      [rx, ry] = p3;
    } else if (cmd === 'l' || cmd === 'L') {
      const nx = num();
      const ny = num();
      x = cmd === 'l' ? x + nx : nx;
      y = cmd === 'l' ? y + ny : ny;
      const p = point(x, y);
      if (p[0] === rx && p[1] === ry) continue;
      emit('l', [p[0] - rx, p[1] - ry]);
      [rx, ry] = p;
    } else throw new Error(`unexpected path command ${cmd}`);
  }
  return s;
}
