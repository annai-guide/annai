/**
 * Reads JSON that is still arriving: "the half-finished-JSON reader" (spec §9.1). It closes what
 * is open (a string, arrays, objects) and drops a dangling key, comma or half-written value, so a
 * tool's arguments can be used while they stream. Undefined when nothing usable has arrived yet.
 * @param {string} text
 * @returns {any}
 */
export function parsePartialJSON(text) {
  let s = text.trimEnd();
  while (s) {
    try {
      return JSON.parse(close(s));
    } catch {
      s = s.slice(0, -1).trimEnd();
    }
  }
  return undefined;
}

/** s with an escape cut short dropped, and its open string, arrays and objects closed. @param {string} s */
function close(s) {
  /** @type {string[]} */
  const stack = [];
  let inString = false;
  let end = s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') {
        const need = s[i + 1] === 'u' ? 6 : 2;
        if (i + need > s.length) {
          end = i;
          break;
        }
        i += need - 1;
      } else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return s.slice(0, end) + (inString ? '"' : '') + stack.reverse().join('');
}
