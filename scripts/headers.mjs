/**
 * Parses a Cloudflare Pages style _headers file: a path pattern on its own
 * line, then indented "Name: value" lines. "*" at the end of a pattern matches
 * any rest of the path.
 * @param {string} src
 * @returns {{ pattern: string, headers: [string, string][] }[]}
 */
export function parseHeaders(src) {
  /** @type {{ pattern: string, headers: [string, string][] }[]} */
  const rules = [];
  /** @type {{ pattern: string, headers: [string, string][] } | null} */
  let current = null;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const i = line.indexOf(':');
      if (i > 0) current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

/** @param {ReturnType<typeof parseHeaders>} rules @param {string} path */
export function headersFor(rules, path) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const r of rules) {
    const hit = r.pattern.endsWith('*') ? path.startsWith(r.pattern.slice(0, -1)) : r.pattern === path;
    if (hit) for (const [k, v] of r.headers) out.set(k, v);
  }
  return out;
}
