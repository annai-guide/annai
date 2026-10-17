import { normPath } from './paths.js';

/**
 * Skills in the open Agent Skills format (spec §5.1): a folder with SKILL.md, plus optional
 * references/ and assets/ (scripts/ are never run). SKILL.md starts with front matter, read here by
 * a small parser for the subset the format uses: strings, plus a one-level map (metadata) and a
 * list (allowed-tools). Everything else in YAML is skipped.
 * @typedef {{ name: string, description: string, license?: string, compatibility?: string, allowedTools?: string,
 *   metadata: Record<string, string>, body: string }} Skill
 * @typedef {Record<string, string | Record<string, string>>} FrontMatter
 */

export const SKILL_FILE = 'SKILL.md';
/** The longest description the format allows. */
export const DESCRIPTION_MAX = 1024;

export class SkillError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SkillError';
  }
}

const KEY = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;
const MAP_KEY = /^[ \t]+([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/;
const ITEM = /^[ \t]*-(?:[ \t]+(.*))?$/;
const indentOf = (/** @type {string} */ l) => (/^[ \t]*/.exec(l)?.[0].length ?? 0);
const blank = (/** @type {string} */ l) => /^\s*$/.test(l);

/**
 * The front matter between the first two --- lines, and the body after it. CRLF and a byte-order
 * mark are read past.
 * @param {string} text @returns {{ data: FrontMatter, body: string }}
 */
export function frontMatter(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) throw new SkillError('SKILL.md starts with front matter: a line with just ---, then name: and description:, then another ---.');
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
  if (end < 0) throw new SkillError("SKILL.md's front matter isn't closed: it needs a line with just --- after it.");
  return { data: block(lines.slice(1, end)), body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

/** @param {string[]} lines @returns {FrontMatter} */
function block(lines) {
  /** @type {FrontMatter} */
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    const m = indentOf(line) === 0 ? KEY.exec(line) : null;
    if (!m) continue; // blank, a comment, or something this parser skips
    /** @type {string[]} */
    const more = [];
    while (i < lines.length && (blank(lines[i]) || indentOf(lines[i]) > 0)) more.push(lines[i++]);
    while (more.length && blank(more[more.length - 1])) more.pop();
    data[m[1]] = valueOf((m[2] ?? '').trim(), more);
  }
  return data;
}

/** @param {string} rest what follows "key:" on its line @param {string[]} more the indented lines after it */
function valueOf(rest, more) {
  if (rest.startsWith('"') || rest.startsWith("'")) return quoted(rest, more);
  if (/^[|>][+-]?[0-9]?(?:[ \t]+#.*)?$/.test(rest)) return blockScalar(rest[0] === '>', more);
  if (rest === '' || rest.startsWith('#')) {
    const lines = more.filter((l) => !blank(l) && !/^\s*#/.test(l));
    if (!lines.length) return '';
    if (ITEM.test(lines[0])) return lines.map((l) => ITEM.exec(l)).filter(Boolean).map((x) => scalar(/** @type {RegExpExecArray} */ (x)[1] ?? '')).join(' ').trim();
    /** @type {Record<string, string>} */
    const map = {};
    for (const l of lines) {
      const kv = MAP_KEY.exec(l);
      if (kv) map[kv[1]] = scalar(kv[2] ?? '');
    }
    return map;
  }
  const folded = [cutComment(rest), ...more.filter((l) => !blank(l) && !/^\s*#/.test(l)).map((l) => cutComment(l.trim()))];
  return folded.join(' ').trim();
}

/** A one-line value: quoted, or plain with any comment cut. @param {string} s */
function scalar(s) {
  const t = s.trim();
  return t.startsWith('"') || t.startsWith("'") ? quoted(t, []) : cutComment(t).trim();
}

/** @param {string} s */
function cutComment(s) {
  const at = s.search(/[ \t]#/);
  return at < 0 ? s : s.slice(0, at);
}

/**
 * A quoted value: "…" with backslash escapes, or '…' with '' for a quote. A value that goes on past
 * its line takes the lines after it, folded with spaces.
 * @param {string} first @param {string[]} more
 */
function quoted(first, more) {
  const q = first[0];
  const s = [first, ...more.map((l) => l.trim())].join(' ');
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (q === "'" && c === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return out.trim();
    }
    if (q === '"' && c === '"') return out.trim();
    if (q === '"' && c === '\\') {
      const n = s[++i];
      if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
        i += 4;
      } else {
        out += ({ n: '\n', t: '\t', r: '\r', 0: '\0' })[/** @type {'n'} */ (n)] ?? n ?? '';
      }
      continue;
    }
    out += c;
  }
  return out.trim();
}

/** A | or > block: the lines after it, without their common indent; > folds lines into one. @param {boolean} fold @param {string[]} more */
function blockScalar(fold, more) {
  const first = more.find((l) => !blank(l));
  const cut = first === undefined ? 0 : indentOf(first);
  const lines = more.map((l) => (blank(l) ? '' : l.slice(Math.min(cut, indentOf(l)))));
  if (!fold) return lines.join('\n').trim();
  let out = '';
  for (const l of lines) out += l === '' ? '\n' : `${out && !out.endsWith('\n') ? ' ' : ''}${l}`;
  return out.trim();
}

/** What is wrong with a skill's name, or null (the Agent Skills naming rules). @param {unknown} name @returns {string | null} */
export function checkSkillName(name) {
  if (typeof name !== 'string' || !name) return 'SKILL.md needs a name: lowercase letters, digits and dashes, like tide-pools.';
  if (!/^[a-z0-9-]{1,64}$/.test(name)) return "A skill's name is 1 to 64 lowercase letters, digits and dashes, like tide-pools.";
  if (name.startsWith('-') || name.endsWith('-')) return "A skill's name can't start or end with a dash.";
  if (name.includes('--')) return "A skill's name can't have two dashes in a row.";
  return null;
}

/** @param {string} text @returns {Skill} */
export function parseSkill(text) {
  const { data, body } = frontMatter(text);
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : undefined);
  const wrong = checkSkillName(str(data.name));
  if (wrong) throw new SkillError(wrong);
  const description = str(data.description);
  if (!description) throw new SkillError('SKILL.md needs a description: what the skill is for and when to use it.');
  if (description.length > DESCRIPTION_MAX) throw new SkillError(`A skill's description is at most ${DESCRIPTION_MAX} characters; this one has ${description.length}.`);
  const metadata = data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {};
  /** @type {Skill} */
  const skill = { name: /** @type {string} */ (str(data.name)), description, metadata, body };
  const license = str(data.license);
  const compatibility = str(data.compatibility);
  const allowedTools = str(data['allowed-tools']);
  if (license) skill.license = license;
  if (compatibility) skill.compatibility = compatibility;
  if (allowedTools) skill.allowedTools = allowedTools;
  return skill;
}

/**
 * The files a SKILL.md's links and images point to inside its own folder: no other site, no
 * absolute path, nothing above the folder. Fragments and queries are cut; each file once.
 * @param {string} body @returns {string[]}
 */
export function skillLinks(body) {
  /** @type {string[]} */
  const out = [];
  for (const m of String(body ?? '').matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    let target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) continue;
    target = target.replace(/[#?].*$/, '');
    try {
      target = decodeURIComponent(target);
    } catch {
      continue;
    }
    target = target.replace(/^(\.\/)+/, '');
    if (!target || out.includes(target)) continue;
    try {
      if (normPath(`/${target}`) !== `/${target}`) continue;
    } catch {
      continue;
    }
    out.push(target);
  }
  return out;
}

/** A skill's metadata.version as x.y.z when it is one to three groups of digits, else 0.0.0. @param {Record<string, string> | undefined} metadata */
export function skillVersion(metadata) {
  const v = metadata?.version;
  if (typeof v !== 'string' || !/^\d+(\.\d+){0,2}$/.test(v)) return '0.0.0';
  const parts = v.split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}
