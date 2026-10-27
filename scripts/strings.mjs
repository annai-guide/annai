#!/usr/bin/env node
// annai's words, found, gathered and checked (localization design, section 1). The English is written in the code, marked
// t`…`, tc(context)`…` or plural(n, one, other); this reads those marks with TypeScript's parser (no type checking), and keeps
// one translator's file per language, l10n/<tag>.tsv, from which it writes what ships, l10n/<tag>.json.
//   node scripts/strings.mjs                    updates the TSVs, the JSON files, src/core/l10n-list.js and sw.js's LANGS
//   node scripts/strings.mjs --check            exits 1 on any missing, stale or wrong word, any collision, any stale file,
//                                               and any bare English where a screen surely shows it (npm run check)
//   node scripts/strings.mjs --find [paths]     lists the literals that read as words and are not marked
//   node scripts/strings.mjs --review <tag>     a language's drafts as a Markdown table
import ts from 'typescript';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { key, holes } from '../src/core/l10n.js';

/**
 * The files whose bare English the check refuses: every user-facing literal in them goes through t. Each step extends it; the last
 * extraction step replaces it with whole folders.
 */
export const EXTRACTED = [
  'src/ui/screens/trips.js',
  'src/ui/languages.js',
  'src/core/languages.js',
  // L5a: the shell
  'src/ui/shell.js',
  'src/ui/router.js',
  'src/ui/dock.js',
  'src/ui/notices.js',
  'src/ui/cards.js',
  'src/ui/dom.js',
  'src/ui/install.js',
  'src/ui/platform.js',
  'src/ui/updates.js',
  'src/app/claim.js',
  'src/app/main.js',
  'src/ui/storage-full.js',
  'src/ui/unlock.js',
  'src/ui/mic-help.js',
  'src/ui/live-help.js',
  'src/ui/wake-lock.js',
  'src/ui/slots.js',
  'src/ui/media-keys.js',
  'src/ui/tap-keeps-keyboard.js',
  'src/ui/dock-hides.js',
  // l10n-L5d: models and tools.
  'src/ui/screens/models.js',
  'src/ui/screens/model.js',
  'src/ui/screens/provider.js',
  'src/ui/provider-setup.js',
  'src/ui/screens/add.js',
  'src/ui/search-panel.js',
  'src/ui/screens/tools.js',
  'src/ui/screens/mcp.js',
  'src/ui/credits.js',
  'src/ui/privacy.js',
  // l10n-L5g: the built-in plugins. Tool descriptions and what tools answer are Shiori's, marked English.
  'src/plugins/core-schemas/index.js',
  'src/plugins/core-schemas/schemas.js',
  'src/plugins/files/index.js',
  'src/plugins/go/index.js',
  'src/plugins/mcp/client.js',
  'src/plugins/mcp/index.js',
  'src/plugins/places/index.js',
  'src/plugins/sensors/index.js',
  'src/plugins/skills/index.js',
  'src/plugins/voice-browser/capture-worklet.js',
  'src/plugins/voice-browser/index.js',
  'src/plugins/voice-browser/player-worklet.js',
  'src/plugins/web/free.js',
  'src/plugins/web/index.js',
];
/** Where messages are read from: every t, tc and plural under these folders. */
const SCAN = ['src'];
/** The runtime itself and the pseudo-locale mention t and plural without being messages. */
const SKIP = new Set(['src/core/l10n.js', 'src/core/l10n-pseudo.js', 'src/core/l10n-list.js']);
const HEADER = 'key\tstate\ten\ttext\twhere\tnote';
/** Properties whose value a screen shows as it is, and calls whose first argument it does (the design's "certain places"). */
const SHOWN_PROPS = new Set(['text', 'title', 'aria-label', 'placeholder', 'label', 'alt', 'body']);
/** Properties that hold a code, not words: a class, an id, a type, a link. */
const CODE_PROPS = new Set(['class', 'id', 'name', 'type', 'role', 'href', 'src', 'rel', 'for', 'method', 'inputmode', 'autocomplete', 'pattern', 'accept', 'target', 'lang', 'dir', 'kind', 'mode', 'value']);
/** The calls that show words, and which of their arguments (dom.js's labelled controls too); `pairs`: the second is [value, label][]. */
const SHOWN_CALLS = new Map([
  ['field', [0]], ['checkbox', [0]], ['toast', [0]], ['card', [0]], ['twoStep', [0, 1]], ['jsonField', [0]], ['savedField', [0]], ['savedCheck', [0]],
  ['radios', [0]], ['savedRadios', [0]],
]);
const PAIRS = new Set(['radios', 'savedRadios']);

/**
 * @typedef {{ key: string, kind: 't' | 'plural', context: string, source: string, forms?: { one: string, other: string }, file: string, line: number, values: string[] }} Message
 * @typedef {{ key: string, state: string, en: string, text: string, where: string, note: string, line: number }} Row
 * @typedef {{ file: string, line: number, message: string }} Problem
 */

// ---- reading the code ----

/** @param {string} file @param {string} text */
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
/** @param {ts.SourceFile} sf @param {ts.Node} node */
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
/** @param {ts.Node} n @returns {n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral} */
const isText = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** The module a specifier names, when it is where t, tc and plural come from. @param {ts.Expression | undefined} spec */
const wordsModule = (spec) => !!spec && ts.isStringLiteral(spec) && /\/(l10n|dom)\.js$/.test(spec.text);

/**
 * How a file gets t, tc and plural: by name (`import { t as tr }`) or through a namespace (`import * as L`), and the import shapes of
 * the words it can't follow: a default import, and a re-export (dom.js alone re-exports them, for the screens).
 * @param {ts.SourceFile} sf @param {string} file
 */
function importedNames(sf, file) {
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @type {Set<string>} */
  const spaces = new Set();
  /** @type {{ node: ts.Node, message: string }[]} */
  const refused = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && wordsModule(st.moduleSpecifier)) {
      const clause = st.importClause;
      const named = clause?.namedBindings;
      if (clause?.name) refused.push({ node: st, message: "a default import of the words: annai can't follow it, import { t, tc, plural } by name" });
      if (named && ts.isNamedImports(named)) for (const e of named.elements) names.set(e.name.text, (e.propertyName ?? e.name).text);
      else if (named && ts.isNamespaceImport(named)) spaces.add(named.name.text);
    } else if (ts.isExportDeclaration(st) && wordsModule(st.moduleSpecifier) && file !== 'src/ui/dom.js') {
      refused.push({ node: st, message: "a re-export of the words outside src/ui/dom.js: annai can't follow it, import them where they are used" });
    }
  }
  return { names, spaces, refused };
}
/** Which of t, tc and plural an expression names: an imported name, or a member of a namespace import. @param {ReturnType<typeof importedNames>} imports @param {ts.Node} n */
function markerOf(imports, n) {
  if (ts.isIdentifier(n)) return imports.names.get(n.text) ?? null;
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && imports.spaces.has(n.expression.text) && ['t', 'tc', 'plural'].includes(n.name.text)) return n.name.text;
  return null;
}

/**
 * The messages a file marks, and what the script can't read.
 * @param {string} file the path shown @param {string} text
 * @returns {{ messages: Message[], errors: Problem[] }}
 */
export function readMessages(file, text) {
  const sf = parse(file, text);
  const imports = importedNames(sf, file);
  /** @type {Message[]} */
  const messages = [];
  /** @type {Problem[]} */
  const errors = [];
  const bad = (/** @type {ts.Node} */ n, /** @type {string} */ message) => errors.push({ file, line: lineOf(sf, n), message });
  const is = (/** @type {ts.Node} */ n, /** @type {string} */ what) => markerOf(imports, n) === what;
  for (const r of imports.refused) bad(r.node, r.message);
  /** @param {ts.TemplateLiteral} tpl */
  const sourceOf = (tpl) => (ts.isNoSubstitutionTemplateLiteral(tpl) ? tpl.text : tpl.templateSpans.reduce((s, sp, i) => `${s}{${i}}${sp.literal.text}`, tpl.head.text));
  const visit = (/** @type {ts.Node} */ n) => {
    if (ts.isTaggedTemplateExpression(n)) {
      let context = '';
      let marked = false;
      if (is(n.tag, 't')) marked = true;
      else if (ts.isCallExpression(n.tag) && is(n.tag.expression, 'tc')) {
        marked = true;
        const c = n.tag.arguments[0];
        if (c && isText(c)) context = c.text;
        else bad(n, 'tc needs its context as a plain string');
      }
      if (marked) {
        const values = ts.isTemplateExpression(n.template) ? n.template.templateSpans.map((s) => s.expression.getText(sf)) : [];
        const source = sourceOf(n.template);
        messages.push({ key: key(source, context), kind: 't', context, source, file, line: lineOf(sf, n), values });
      }
    } else if (ts.isCallExpression(n)) {
      if (is(n.expression, 't') || is(n.expression, 'tc') && !ts.isTaggedTemplateExpression(n.parent)) bad(n, `${n.expression.getText(sf)} is used as a function: write it as a tag, t\`…\``);
      else if (is(n.expression, 'plural')) {
        const [, one, other, ...rest] = n.arguments;
        if (!one || !other || !isText(one) || !isText(other)) bad(n, 'plural needs its two forms as plain strings');
        else messages.push({ key: key(`${one.text}\0${other.text}`), kind: 'plural', context: '', source: `${one.text}\0${other.text}`, forms: { one: one.text, other: other.text }, file, line: lineOf(sf, n), values: [n.arguments[0].getText(sf), ...rest.map((v) => v.getText(sf))] });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { messages, errors };
}

/** Every .js file under a folder, as paths from the root, sorted. @param {string} root @param {string} dir @returns {Promise<string[]>} */
async function jsFiles(root, dir) {
  if (!existsSync(`${root}/${dir}`)) return [];
  const out = [];
  for (const e of await readdir(`${root}/${dir}`, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await jsFiles(root, `${dir}/${e.name}`)));
    else if (/\.m?js$/.test(e.name)) out.push(`${dir}/${e.name}`);
  }
  return out.sort();
}

/**
 * Every message under the scanned folders, in the order of their first use, and the problems in reading them.
 * @param {string} root
 * @returns {Promise<{ messages: Map<string, Message>, problems: Problem[] }>}
 */
export async function extract(root) {
  /** @type {Map<string, Message>} */
  const messages = new Map();
  /** @type {Problem[]} */
  const problems = [];
  for (const dir of SCAN) {
    for (const file of await jsFiles(root, dir)) {
      if (SKIP.has(file)) continue;
      const read = readMessages(file, await readFile(`${root}/${file}`, 'utf8'));
      problems.push(...read.errors);
      for (const m of read.messages) {
        const had = messages.get(m.key);
        if (!had) messages.set(m.key, m);
        else if (had.source !== m.source || had.context !== m.context) {
          problems.push({ file: m.file, line: m.line, message: `the key ${m.key} is also ${had.file}:${had.line}'s (a different message): change one's words` });
        }
      }
    }
  }
  return { messages, problems };
}

/** The plural categories a language has. @param {string} tag */
export const categories = (tag) => new Intl.PluralRules(tag).resolvedOptions().pluralCategories;

// ---- the translator's file ----

/** @param {string} s */
const escape = (s) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
/** @param {string} s */
const unescape = (s) => s.replace(/\\(\\|t|n)/g, (m, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : '\\'));

/** @param {string} text @returns {Row[]} */
export function readTsv(text) {
  /** @type {Row[]} */
  const rows = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (i === 0 || !line.trim()) return;
    const [k = '', state = '', en = '', body = '', where = '', note = ''] = line.split('\t').map(unescape);
    rows.push({ key: k, state, en, text: body, where, note, line: i + 1 });
  });
  return rows;
}
/** @param {Omit<Row, 'line'>[]} rows */
export const writeTsv = (rows) => `${[HEADER, ...rows.map((r) => [r.key, r.state, r.en, r.text, r.where, r.note].map(escape).join('\t'))].join('\n')}\n`;

/** The rows a language needs for a message. @param {Message} m @param {string} tag @returns {{ key: string, en: string, note: string }[]} */
function wanted(m, tag) {
  const where = m.values.map((v, i) => (m.kind === 'plural' ? (i ? `{${i - 1}} = ${v}` : `# = ${v}`) : `{${i}} = ${v}`));
  if (m.kind === 't') return [{ key: m.key, en: m.source, note: [m.context && `context: ${m.context}`, ...where].filter(Boolean).join('; ') }];
  const forms = /** @type {{ one: string, other: string }} */ (m.forms);
  const note = ['plural', ...where, `English: "${forms.one}" (one), "${forms.other}" (other)`].join('; ');
  return categories(tag).map((c) => ({ key: `${m.key}#${c}`, en: c === 'one' ? forms.one : forms.other, note }));
}

/** @param {string} a @param {string} b */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}
/** Whether one English is a small edit of another, or the same words reordered. @param {string} a @param {string} b */
function close(a, b) {
  const words = (/** @type {string} */ s) => s.split(/\s+/).sort().join(' ');
  const d = distance(a, b);
  return words(a) === words(b) || (d <= Math.floor(Math.max(a.length, b.length) * 0.4) && d < Math.min(a.length, b.length));
}
const fileOf = (/** @type {string} */ where) => where.replace(/:\d+$/, '');
const catOf = (/** @type {string} */ k) => (k.includes('#') ? k.slice(k.indexOf('#')) : '');
const WAS = 'English was: ';
/** A translator's own words on a row, after the script's (why a draft says what it says): kept when the script writes the row again. */
const NOTE = 'Note: ';
/** A row's note in its parts: what the English was (a carried draft), and the translator's note, each with its mark. @param {string} note */
function noteParts(note) {
  const n = note.search(new RegExp(`(?:^|; )${NOTE}`));
  const mine = n < 0 ? '' : note.slice(n).replace(/^; /, '');
  const rest = n < 0 ? note : note.slice(0, n);
  const w = rest.indexOf(WAS);
  return { was: w < 0 ? '' : rest.slice(w), mine };
}

/**
 * A language's rows after the code changed: a row for every message, new ones `new`, rows of vanished messages gone, or, when the
 * English changed by a little in the same file, carried over as a `draft` that says what the English was.
 * @param {Row[]} old @param {Map<string, Message>} messages @param {string} tag @returns {Omit<Row, 'line'>[]}
 */
export function updateRows(old, messages, tag) {
  const had = new Map(old.map((r) => [r.key, r]));
  /** @type {Omit<Row, 'line'>[]} */
  const rows = [];
  for (const m of messages.values()) {
    for (const w of wanted(m, tag)) {
      const r = had.get(w.key);
      const { was, mine } = noteParts(r?.note ?? '');
      const note = [w.note, r?.state === 'draft' ? was : '', mine].filter(Boolean).join('; ');
      rows.push({ key: w.key, state: r?.state ?? 'new', en: w.en, text: r?.text ?? '', where: `${m.file}:${m.line}`, note });
    }
  }
  const now = new Set(rows.map((r) => r.key));
  const orphans = old.filter((r) => !now.has(r.key) && r.state !== 'new' && r.text);
  for (const r of rows) {
    if (r.state !== 'new' || had.has(r.key)) continue;
    const i = orphans.findIndex((o) => fileOf(o.where) === fileOf(r.where) && catOf(o.key) === catOf(r.key) && close(o.en, r.en));
    if (i < 0) continue;
    const [o] = orphans.splice(i, 1);
    r.state = 'draft';
    r.text = o.text;
    r.note = [r.note, `${WAS}${o.en}`, noteParts(o.note).mine].filter(Boolean).join('; ');
  }
  const at = (/** @type {{ where: string }} */ r) => /** @type {[string, number]} */ ([fileOf(r.where), Number(r.where.split(':').pop())]);
  return rows.sort((a, b) => {
    const [fa, la] = at(a);
    const [fb, lb] = at(b);
    return fa < fb ? -1 : fa > fb ? 1 : la - lb || (a.key < b.key ? -1 : 1);
  });
}

/** What ships for a language: { key: text } and, for plurals, { key: { category: text } }. @param {Omit<Row, 'line'>[]} rows */
export function shippedJson(rows) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const r of [...rows].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (r.state === 'new' || !r.text) continue;
    const [k, c] = r.key.split('#');
    if (c) (out[k] ??= {})[c] = r.text;
    else out[k] = r.text;
  }
  return `${JSON.stringify(out)}\n`;
}

/** @typedef {{ tag: string, status: 'shipped' | 'experimental' }} Language */
/** @param {string} root @returns {Promise<Language[]>} */
async function languages(root) {
  const f = `${root}/l10n/languages.json`;
  return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : [];
}
/** What src/core/l10n-list.js says. @param {Language[]} list */
export const listFile = (list) => {
  return `// Written by scripts/strings.mjs from l10n/languages.json. Do not edit.\nexport const SHIPPED = Object.freeze(${quoted(['en', ...list.filter((l) => l.status === 'shipped').map((l) => l.tag)])});\n/** @type {readonly string[]} */\nexport const EXPERIMENTAL = Object.freeze(${quoted(list.filter((l) => l.status === 'experimental').map((l) => l.tag))});\n`;
};
/** The lines of sw.js that name the languages with a catalog (all listed), and those a phone is matched against (the shipped ones). */
const LANGS_LINE = /^const LANGS = \[[^\]]*\];$/m;
const SHIPPED_LANGS_LINE = /^const SHIPPED_LANGS = \[[^\]]*\];$/m;
const quoted = (/** @type {string[]} */ tags) => JSON.stringify(tags).replace(/"/g, "'").replace(/,/g, ', ');
/** sw.js with those lines made from the list, or null when it lacks one. @param {string} sw @param {Language[]} list */
export const swWithLangs = (sw, list) => (LANGS_LINE.test(sw) && SHIPPED_LANGS_LINE.test(sw)
  ? sw.replace(LANGS_LINE, `const LANGS = ${quoted(list.map((l) => l.tag))};`).replace(SHIPPED_LANGS_LINE, `const SHIPPED_LANGS = ${quoted(list.filter((l) => l.status === 'shipped').map((l) => l.tag))};`)
  : null);

/** The tags that have a translator's file. @param {string} root */
async function tsvTags(root) {
  return existsSync(`${root}/l10n`) ? (await readdir(`${root}/l10n`)).filter((f) => f.endsWith('.tsv') && f !== 'glossary.tsv').map((f) => f.slice(0, -4)).sort() : [];
}

/** The default run: writes every language's TSV and JSON, the list, and the languages sw.js caches. @param {string} root @returns {Promise<string[]>} the files written */
export async function update(root) {
  const { messages, problems } = await extract(root);
  if (problems.length) throw new Error(problems.map((p) => `${p.file}:${p.line}: ${p.message}`).join('\n'));
  const list = await languages(root);
  const tags = [...new Set([...list.map((l) => l.tag), ...(await tsvTags(root))])].sort();
  /** @type {string[]} */
  const written = [];
  const put = async (/** @type {string} */ path, /** @type {string} */ text) => {
    if (!existsSync(`${root}/${path}`) || (await readFile(`${root}/${path}`, 'utf8')) !== text) {
      await mkdir(dirname(`${root}/${path}`), { recursive: true });
      await writeFile(`${root}/${path}`, text);
      written.push(path);
    }
  };
  for (const tag of tags) {
    const file = `l10n/${tag}.tsv`;
    const old = existsSync(`${root}/${file}`) ? readTsv(await readFile(`${root}/${file}`, 'utf8')) : [];
    const rows = updateRows(old, messages, tag);
    await put(file, writeTsv(rows));
    await put(`l10n/${tag}.json`, shippedJson(rows));
  }
  await put('src/core/l10n-list.js', listFile(list));
  if (existsSync(`${root}/sw.js`)) {
    const made = swWithLangs(await readFile(`${root}/sw.js`, 'utf8'), list);
    if (made !== null) await put('sw.js', made);
  }
  return written;
}

// ---- the glossary ----

/** @typedef {{ en: string, kind: string, terms: Record<string, string>, where: string, note: string }} Term */
/**
 * l10n/glossary.tsv: the names of annai's screens and things, per language (columns en, kind, then a column per language, where, note).
 * `never` rows are kept as written in every language, so a language's cell may be empty there. @param {string} text @returns {Term[]}
 */
export function readGlossary(text) {
  const [head = '', ...lines] = text.split('\n');
  const names = head.replace(/\r$/, '').split('\t');
  /** @type {Term[]} */
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const cells = line.split('\t').map(unescape);
    /** @type {Record<string, string>} */
    const by = {};
    names.forEach((n, i) => { by[n] = (cells[i] ?? '').trim(); });
    if (!by.en) continue;
    const { en, kind = '', where = '', note = '', ...terms } = by;
    out.push({ en, kind, terms, where, note });
  }
  return out;
}
const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The terms a message names in English: whole words, with an s or es after, as the glossary writes them. A Capitalised term (a screen)
 * is a name only where a name stands, not as the first word of a sentence ("Plan your day", "Ask Shiori"); a lowercase one (a thing)
 * is also met with a capital. A name kept as written (Shiori, Koe) is a name wherever it stands. The longest terms go first, and their
 * words are not read again as a shorter term's. @param {Set<string>} [never] the terms kept as written
 */
function naming(/** @type {string} */ english, /** @type {string[]} */ ens, never = new Set()) {
  let rest = english;
  /** @type {string[]} */
  const found = [];
  for (const en of [...ens].sort((a, b) => b.length - a.length)) {
    const first = en[0];
    const lower = first === first.toLowerCase() && first !== first.toUpperCase();
    const head = lower ? `[${escapeRe(first)}${escapeRe(first.toUpperCase())}]` : escapeRe(first);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${head}${escapeRe(en.slice(1))}(?:e?s)?(?![\\p{L}\\p{N}])`, 'u');
    const m = re.exec(rest);
    if (!m) continue;
    const opens = m.index === 0 && rest.slice(m[0].length).replace(/[\s.!?…:]+$/u, '') !== '';
    if (lower || !opens || never.has(en)) found.push(en);
    rest = rest.replace(re, ' ');
  }
  return found;
}
/**
 * A language's rows that name a glossary term in English and do not use the language's word for it: warnings, not failures (a
 * sentence may rightly turn a term into a verb). A `never` term (annai, Shiori, Koe) must stay as written.
 * @param {Term[]} glossary @param {string} tag @param {(Omit<Row, 'line'> & { line?: number })[]} rows @returns {Problem[]}
 */
export function glossaryWarnings(glossary, tag, rows) {
  const termOf = (/** @type {Term} */ g) => g.terms[tag] || (g.kind === 'never' ? g.en : '');
  const usable = glossary.filter((g) => termOf(g));
  /** @type {Problem[]} */
  const out = [];
  for (const r of rows) {
    if (!r.text || r.state === 'new') continue;
    for (const en of naming(r.en, usable.map((g) => g.en), new Set(usable.filter((g) => g.kind === 'never').map((g) => g.en)))) {
      const g = /** @type {Term} */ (usable.find((x) => x.en === en));
      const term = termOf(g);
      if (!r.text.includes(term)) out.push({ file: `l10n/${tag}.tsv`, line: r.line ?? 0, message: `"${r.en}" names ${g.kind === 'never' ? '' : 'the glossary\'s '}"${g.en}", which is "${term}" in ${tag}, and the text doesn't use it` });
    }
  }
  return out;
}

// ---- the check ----

/** A function or a class, or a statement that makes one: a mark above it is no mark on what is inside. @param {ts.Node} n */
const holdsCode = (n) => ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)
  || (ts.isVariableStatement(n) && n.declarationList.declarations.some((d) => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer) || ts.isClassExpression(d.initializer))));
/**
 * Whether a node, or what holds it, is marked as English on purpose: a /* en *\/ before it or before a statement or expression that
 * holds it. A mark above a function or class covers the line it is on, not the body: mark the statement inside.
 * @param {ts.SourceFile} sf @param {ts.Node} node
 */
function markedEnglish(sf, node) {
  for (let n = /** @type {ts.Node | undefined} */ (node); n && n !== sf; n = n.parent) if (!holdsCode(n) && /\/\*\s*en\b/.test(sf.text.slice(n.getFullStart(), n.getStart(sf)))) return true;
  return false;
}
/** A name written as an identifier or a string. @param {ts.PropertyName} n */
const nameOf = (n) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : '');
/** The static words of an unmarked literal, or null. @param {ts.Node} n */
function staticText(n) {
  if (isText(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.templateSpans.reduce((s, sp) => `${s} ${sp.literal.text}`, n.head.text);
  return null;
}

/**
 * The bare English in the places a screen surely shows it: a child of h(); text, title, aria-label, placeholder, label, alt or
 * body in an object; the first argument of field, checkbox, toast, card or twoStep. A value joined on with + counts, and the values inside a message. `/* en *\/` marks English on purpose.
 * @param {string} file @param {string} text @returns {{ line: number, text: string }[]}
 */
export function bareEnglish(file, text) {
  const sf = parse(file, text);
  const imports = importedNames(sf, file);
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  /** Looks through the ways a shown value is chosen. @param {ts.Node} n */
  const shown = (n) => {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) shown(n.expression);
    else if (ts.isConditionalExpression(n)) { shown(n.whenTrue); shown(n.whenFalse); }
    else if (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) { shown(n.left); shown(n.right); }
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) shown(n.right);
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { shown(n.left); shown(n.right); }
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'String' && n.arguments[0]) shown(n.arguments[0]);
    else if (ts.isArrayLiteralExpression(n)) n.elements.forEach(shown);
    else {
      const s = staticText(n);
      if (s !== null && /\p{L}/u.test(s) && !markedEnglish(sf, n)) out.push({ line: lineOf(sf, n), text: s.trim() });
    }
  };
  const visit = (/** @type {ts.Node} */ n) => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : '';
      if (ts.isIdentifier(n.expression) && callee === 'h') n.arguments.slice(2).forEach(shown);
      else if (SHOWN_CALLS.has(callee)) {
        for (const i of SHOWN_CALLS.get(callee) ?? []) if (n.arguments[i]) shown(n.arguments[i]);
        const options = n.arguments[1];
        if (PAIRS.has(callee) && options && ts.isArrayLiteralExpression(options)) for (const o of options.elements) if (ts.isArrayLiteralExpression(o) && o.elements[1]) shown(o.elements[1]);
      }
      // The values of a message are code, but English in them is shown (t`Saved ${ok ? 'Kept' : 'Lost'}`).
      if (markerOf(imports, n.expression) === 'plural') n.arguments.slice(3).forEach(shown);
    } else if (ts.isTaggedTemplateExpression(n) && ts.isTemplateExpression(n.template) && (markerOf(imports, n.tag) === 't' || (ts.isCallExpression(n.tag) && markerOf(imports, n.tag.expression) === 'tc'))) {
      for (const span of n.template.templateSpans) shown(span.expression);
    } else if (ts.isPropertyAssignment(n) && SHOWN_PROPS.has(nameOf(n.name))) shown(n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Everything wrong with annai's words, by file and line, and how many drafts each language has.
 * @param {string} root @param {string[]} [files] the files whose bare English is refused
 * @returns {Promise<{ problems: Problem[], warnings: Problem[], drafts: Record<string, { draft: number, ok: number }> }>}
 */
export async function check(root, files = EXTRACTED) {
  const { messages, problems } = await extract(root);
  /** @type {Problem[]} */
  const warnings = [];
  /** @type {Record<string, { draft: number, ok: number }>} */
  const drafts = {};
  const list = await languages(root);
  // Once the glossary is there, a message that names one of its terms is held to the language's word for it (a warning).
  const glossary = existsSync(`${root}/l10n/glossary.tsv`) ? readGlossary(await readFile(`${root}/l10n/glossary.tsv`, 'utf8')) : [];
  for (const tag of [...new Set([...list.map((l) => l.tag), ...(await tsvTags(root))])].sort()) {
    const file = `l10n/${tag}.tsv`;
    const listed = list.some((l) => l.tag === tag);
    const bag = listed ? problems : warnings;
    if (!existsSync(`${root}/${file}`)) {
      bag.push({ file, line: 1, message: `${tag} has no translator's file: run npm run strings` });
      continue;
    }
    const rows = readTsv(await readFile(`${root}/${file}`, 'utf8'));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    drafts[tag] = { draft: rows.filter((r) => r.state === 'draft').length, ok: rows.filter((r) => r.state === 'ok').length };
    const needed = new Set();
    for (const m of messages.values()) {
      const have = m.kind === 'plural' ? holes(`${m.forms?.one}${m.forms?.other}`) : holes(m.source);
      for (const w of wanted(m, tag)) {
        needed.add(w.key);
        const r = byKey.get(w.key);
        const at = { file: m.file, line: m.line };
        if (!r) bag.push({ ...at, message: `${tag} has no row for "${w.en}": run npm run strings` });
        else if (r.state === 'new' || !r.text) bag.push({ file, line: r.line, message: `${tag} has no text yet for "${w.en}" (${m.file}:${m.line})` });
        else if (holes(r.text) !== have) bag.push({ file, line: r.line, message: `${tag}'s text for "${w.en}" has the placeholders ${holes(r.text) || 'none'}, the English has ${have || 'none'}` });
      }
    }
    for (const r of rows) {
      if (needed.has(r.key)) continue;
      const base = r.key.split('#')[0];
      const m = messages.get(base);
      bag.push({ file, line: r.line, message: m?.kind === 'plural' ? `${tag} has no "${r.key.split('#')[1]}" form: its categories are ${categories(tag).join(', ')}` : `"${r.en}" is no longer in the code: run npm run strings` });
    }
    warnings.push(...glossaryWarnings(glossary, tag, rows));
    if (listed) {
      const json = `l10n/${tag}.json`;
      if (!existsSync(`${root}/${json}`) || (await readFile(`${root}/${json}`, 'utf8')) !== shippedJson(rows)) problems.push({ file: json, line: 1, message: `${json} isn't what ${file} makes: run npm run strings` });
    }
  }
  const listPath = 'src/core/l10n-list.js';
  if (!existsSync(`${root}/${listPath}`) || (await readFile(`${root}/${listPath}`, 'utf8')) !== listFile(list)) problems.push({ file: listPath, line: 1, message: `${listPath} isn't what l10n/languages.json makes: run npm run strings` });
  if (existsSync(`${root}/sw.js`)) {
    const sw = await readFile(`${root}/sw.js`, 'utf8');
    const made = swWithLangs(sw, list);
    if (made === null) problems.push({ file: 'sw.js', line: 1, message: "has no `const LANGS = [...];` and `const SHIPPED_LANGS = [...];` lines for the languages it caches" });
    else if (made !== sw) problems.push({ file: 'sw.js', line: sw.slice(0, sw.search(LANGS_LINE)).split('\n').length, message: "LANGS isn't what l10n/languages.json makes: run npm run strings" });
  }
  for (const file of files) {
    if (!existsSync(`${root}/${file}`)) { problems.push({ file, line: 1, message: 'is listed in EXTRACTED but is not there' }); continue; }
    for (const b of bareEnglish(file, await readFile(`${root}/${file}`, 'utf8'))) problems.push({ file, line: b.line, message: `bare English "${b.text}": wrap it in t\`…\`, or mark it /* en */ if it stays English` });
  }
  return { problems, warnings, drafts };
}

// ---- finding what isn't marked yet ----

/** Whether a literal's text reads as words a person would be shown. @param {string} s */
export function readsAsWords(s) {
  const text = s.trim();
  if (!/\p{L}/u.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[./#~@]?[\w.@-]*\/[\w./@{}-]*$/.test(text) || /[{};]\s*$|^[\d.]+(px|em|rem|%|s|ms)\b/.test(text)) return false;
  if (/^[A-Z0-9_]+$/.test(text)) return false;
  if (!/\s/.test(text)) return /^\p{Lu}\p{Ll}/u.test(text) || /[^\x00-\x7f]/.test(text) && /\p{L}/u.test(text) || /[.…!?]$/.test(text) && /\p{L}{2}/u.test(text);
  return (text.match(/\p{L}+/gu)?.length ?? 0) >= 2 || /\p{Lu}/u.test(text);
}
/** A guess at who reads a file's words. @param {string} file */
export const readerOf = (file) => (/agent|instructions|koe\/|live\/|^src\/plugins|prompt|tools/.test(file) ? 'a model?' : file.startsWith('src/ui') || file.startsWith('src/app') ? 'the user' : 'the user?');

/** Literals that read as words, are not marked, and are not obviously code. @param {string} file @param {string} text @returns {{ line: number, text: string }[]} */
export function findWords(file, text) {
  const sf = parse(file, text);
  const imports = importedNames(sf, file);
  /** A plural's forms are its message, as a tagged template's words are t's, and tc's context is no words. @param {ts.Node} n */
  const form = (n) => ts.isCallExpression(n.parent) && n.parent.arguments.slice(...(markerOf(imports, n.parent.expression) === 'plural' ? [1, 3] : markerOf(imports, n.parent.expression) === 'tc' ? [0, 1] : [0, 0])).includes(/** @type {any} */ (n));
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  const visit = (/** @type {ts.Node} */ n) => {
    const s = staticText(n);
    if (s !== null && readsAsWords(s) && !skipped(sf, n) && !form(n) && !markedEnglish(sf, n)) out.push({ line: lineOf(sf, n), text: s.trim() });
    // A tagged template's words are its tag's business (t marks them); the code in its ${} is looked at all the same.
    if (!ts.isTaggedTemplateExpression(n)) ts.forEachChild(n, visit);
    else {
      visit(n.tag);
      if (ts.isTemplateExpression(n.template)) for (const span of n.template.templateSpans) visit(span.expression);
    }
  };
  visit(sf);
  return out;
}
/** Where a literal is code, not words: an import, a comparison, a property's name, a selector, a pattern. @param {ts.SourceFile} sf @param {ts.Node} n */
function skipped(sf, n) {
  const p = n.parent;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isCaseClause(p) || ts.isElementAccessExpression(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isPropertyAssignment(p) && (p.name === n || CODE_PROPS.has(nameOf(p.name)))) return true;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.InKeyword].includes(p.operatorToken.kind)) return true;
  if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ['querySelector', 'querySelectorAll', 'closest', 'matches', 'getElementById', 'setAttribute', 'getAttribute', 'removeAttribute', 'addEventListener', 'includes', 'startsWith', 'endsWith', 'split', 'test', 'matchMedia', 'getItem', 'setItem', 'removeItem', 'has', 'get', 'set', 'delete'].includes(p.expression.name.text)) return true;
  if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && ['require', 'RegExp'].includes(p.expression.text)) return true;
  return ts.isNewExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'RegExp';
}

/** @param {string} root @param {string[]} paths files or folders */
export async function find(root, paths) {
  const files = [];
  for (const p of paths.length ? paths : SCAN) files.push(...(/\.m?js$/.test(p) ? [p] : await jsFiles(root, p.replace(/\/$/, ''))));
  /** @type {string[]} */
  const lines = [];
  for (const file of files) for (const w of findWords(file, await readFile(`${root}/${file}`, 'utf8'))) lines.push(`${file}:${w.line}\t${readerOf(file)}\t${w.text}`);
  return lines;
}

/** A language's drafts as a Markdown table. @param {string} root @param {string} tag */
export async function review(root, tag) {
  const rows = readTsv(await readFile(`${root}/l10n/${tag}.tsv`, 'utf8')).filter((r) => r.state === 'draft');
  const cell = (/** @type {string} */ s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return `${['| English | Draft | Where |', '| --- | --- | --- |', ...rows.map((r) => `| ${cell(r.en)} | ${cell(r.text)} | ${r.where} |`)].join('\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    const { problems, warnings, drafts } = await check(root);
    for (const w of warnings) console.warn(`warning ${w.file}:${w.line}: ${w.message}`);
    for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`);
    for (const [tag, d] of Object.entries(drafts)) console.log(`${tag}: ${d.draft} drafts, ${d.ok} read`);
    if (problems.length) process.exit(1);
    console.log('annai\'s words are all marked, translated and current');
  } else if (args[0] === '--find') {
    const lines = await find(root, args.slice(1));
    console.log(lines.join('\n'));
    console.log(`${lines.length} literal${lines.length === 1 ? '' : 's'} read as words and aren't marked`);
  } else if (args[0] === '--review') {
    process.stdout.write(await review(root, args[1]));
  } else {
    try {
      const written = await update(root);
      console.log(written.length ? `wrote ${written.join(', ')}` : 'nothing to write');
    } catch (e) {
      console.error(/** @type {Error} */ (e).message);
      process.exit(1);
    }
  }
}
