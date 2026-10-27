/**
 * Git's object ids, made in the browser with WebCrypto's SHA-1, so annai knows which files a
 * repository already has, and can check that GitHub stored exactly what it sent (spec §12.4: only
 * changed files are uploaded).
 * @typedef {{ path: string, sha: string, mode?: string }} TreeFile mode: "100644" unless given
 * @typedef {{ files: Map<string, { sha: string, mode: string }>, dirs: Map<string, Dir> }} Dir
 */

const enc = new TextEncoder();

/** A path git can't hold: what is wrong (code), and the path. */
export class GitPathError extends Error {
  /** @param {'part' | 'dot-git' | 'both' | 'twice'} code @param {string} path @param {string} message in English */
  constructor(code, path, message) {
    super(message);
    this.name = 'GitPathError';
    this.code = code;
    this.path = path;
  }
}

/**
 * What a path git can't hold means for a backup, in English and the screens' words, with what to do (annai.l10n.both).
 * @param {any} l10n annai.l10n @param {GitPathError} e @returns {{ message: string, shown: string }}
 */
export function pathWords(l10n, e) {
  const { both } = l10n;
  if (e.code === 'part') return both`git can't hold "${e.path}": it has an empty, "." or ".." part. Rename it in annai, then back up again.`;
  if (e.code === 'dot-git') return both`git can't hold "${e.path}": nothing in it may be called .git. Rename it in annai, then back up again.`;
  if (e.code === 'both') return both`git can't hold both a file and a folder called "${e.path}". Rename it in annai, then back up again.`;
  return both`"${e.path}" is in the backup twice. Rename it in annai, then back up again.`;
}

/** @param {ArrayBuffer} b */
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

/** @param {string} s */
function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** @param {Uint8Array[]} parts */
function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** @param {Uint8Array<ArrayBuffer>} bytes */
const sha1 = async (bytes) => hex(await crypto.subtle.digest('SHA-1', bytes));

/** The id git gives some content: the SHA-1 of "blob <size>\0" and the bytes. @param {Uint8Array} bytes */
export function blobId(bytes) {
  return sha1(join([enc.encode(`blob ${bytes.byteLength}\0`), bytes]));
}

/**
 * The files as folders, refusing what git can't hold: an empty, "." or ".." part, a part named
 * .git, a name that is both a file and a folder, and a file listed twice.
 * @param {TreeFile[]} files @returns {Dir}
 */
export function nest(files) {
  /** @type {Dir} */
  const root = { files: new Map(), dirs: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new GitPathError('part', f.path, `git can't hold "${f.path}": it has an empty, "." or ".." part.`);
    if (parts.some((p) => p.toLowerCase() === '.git')) throw new GitPathError('dot-git', f.path, `git can't hold "${f.path}": nothing in it may be called .git.`);
    let d = root;
    for (const [i, p] of parts.slice(0, -1).entries()) {
      if (d.files.has(p)) throw new GitPathError('both', parts.slice(0, i + 1).join('/'), `git can't hold both a file and a folder called "${parts.slice(0, i + 1).join('/')}".`);
      let next = d.dirs.get(p);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        d.dirs.set(p, next);
      }
      d = next;
    }
    const name = /** @type {string} */ (parts.at(-1));
    if (d.dirs.has(name)) throw new GitPathError('both', f.path, `git can't hold both a file and a folder called "${f.path}".`);
    if (d.files.has(name)) throw new GitPathError('twice', f.path, `"${f.path}" is in the backup twice.`);
    d.files.set(name, { sha: f.sha, mode: f.mode ?? '100644' });
  }
  return root;
}

/** Compares bytes the way git sorts tree entries. @param {Uint8Array} a @param {Uint8Array} b */
function compare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** @param {Dir} d @returns {Promise<string>} */
async function hashDir(d) {
  /** @type {{ key: Uint8Array, head: Uint8Array, sha: string }[]} */
  const entries = [];
  for (const [name, f] of d.files) entries.push({ key: enc.encode(name), head: enc.encode(`${f.mode} ${name}\0`), sha: f.sha });
  for (const [name, sub] of d.dirs) entries.push({ key: enc.encode(`${name}/`), head: enc.encode(`40000 ${name}\0`), sha: await hashDir(sub) });
  entries.sort((a, b) => compare(a.key, b.key));
  const body = join(entries.flatMap((e) => [e.head, fromHex(e.sha)]));
  return sha1(join([enc.encode(`tree ${body.byteLength}\0`), body]));
}

/**
 * The id of the tree git makes of these files: folders become trees of their own, and entries sort
 * by their UTF-8 bytes, a folder as its name followed by "/". Rejects with GitPathError (see nest).
 * @param {TreeFile[]} files @returns {Promise<string>}
 */
export async function treeId(files) {
  return hashDir(nest(files));
}

/**
 * Each name's bytes, read up to width at a time, handed to take in the order given: a backup's files are
 * many and small, and one at a time each waits a round trip (review R14). The first failure is thrown.
 * @param {string[]} names @param {(name: string) => Promise<Uint8Array>} read
 * @param {(name: string, bytes: Uint8Array, i: number) => Promise<void>} take @param {number} [width]
 */
export async function readInOrder(names, read, take, width = 6) {
  /** @type {Promise<Uint8Array>[]} */
  const reads = [];
  const more = () => {
    if (reads.length >= names.length) return;
    const p = read(names[reads.length]);
    p.catch(() => {}); // thrown when its turn comes
    reads.push(p);
  };
  for (let k = 0; k < width; k++) more();
  for (let i = 0; i < names.length; i++) {
    const bytes = await reads[i];
    more();
    await take(names[i], bytes, i);
  }
}
