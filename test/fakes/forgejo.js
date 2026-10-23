import http from 'node:http';
import { createHash } from 'node:crypto';

/**
 * A stand-in for the part of Forgejo's API (and Gitea's, which it shares) that annai's Forgejo /
 * Gitea backups use: the repository, branches, paged recursive trees, raw files, the commit list
 * and ChangeFiles (POST /contents). It answers with Forgejo 16.0.6's status codes, messages and
 * CORS behaviour (measured 2026-10-18, see docs/superpowers/plans/2026-10-18-storage-forgejo.md),
 * including its tree pages that all say truncated. It hashes git objects with code of its own
 * (node:crypto), in SHA-1 or SHA-256 repositories. Tests and the end-to-end suite run it on a port
 * of its own (port 0). The account and the repository search answer as both servers did for each
 * token's scopes (2026-10-18): GET /user needs User: Read, which TOKEN and READ_TOKEN lack and
 * USER_TOKEN has; the search needs only Repository, and the permissions it gives are the user's,
 * whatever the token may do.
 * @typedef {{ type: 'blob', data: Buffer } | { type: 'tree', entries: { name: string, mode: string, sha: string }[] }
 *   | { type: 'commit', tree: string, parents: string[], message: string, date: string }} GitObject
 * @typedef {{ name: string, private: boolean, archived: boolean, format: 'sha1' | 'sha256', defaultBranch: string,
 *   push: boolean, mirror: boolean, objects: Map<string, GitObject>, refs: Map<string, string> }} Repo
 *   push: whether the user may change it (a collaborator may only read); mirror: a pull mirror
 * @typedef {Map<string, { sha: string, mode: string }>} Files path → file
 * @typedef {{ files: Map<string, { sha: string, mode: string }>, dirs: Map<string, Dir> }} Dir
 * @typedef {{ status: number, json?: any, raw?: Buffer, headers?: Record<string, string>, cors?: boolean, drop?: boolean }} Answer
 *   cors: false for an answer a proxy in front gives, without Forgejo's CORS headers; drop: the connection is cut
 */

export const TOKEN = 'f0rgej0standin0123456789abcdef01234567';
export const READ_TOKEN = 'f0rgej0standinreadonly0123456789abcdef';
/** A token with Repository: Read and write and User: Read. */
export const USER_TOKEN = 'f0rgej0standinuser0123456789abcdef0123';
/** The headers the user's own server allows web apps to send. */
const ALLOWED_HEADERS = ['authorization', 'content-type', 'accept'];
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const DOCS = 'http://127.0.0.1/api/swagger';
/** Blobs up to this size have their content in ChangeFiles' answer ([api] DEFAULT_MAX_BLOB_SIZE). */
const MAX_BLOB_SIZE = 10 * 1024 * 1024;
/** @param {string} message @param {string[]} [errors] @returns {any} */
const err = (message, errors) => ({ message, url: DOCS, ...(errors ? { errors } : {}) });
/** @param {string[]} [errors] @returns {Answer} */
const notFound = (errors = []) => ({ status: 404, json: err("The target couldn't be found.", errors) });

/** @param {'sha1' | 'sha256'} format @param {string} type @param {Buffer} body */
const gitId = (format, type, body) => createHash(format).update(`${type} ${body.length}\0`).update(body).digest('hex');

/** Git sorts a folder as its name followed by "/". @param {{ name: string, mode: string }} e */
const sortKey = (e) => Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name);
/** @template {{ name: string, mode: string }} E @param {E[]} entries @returns {E[]} */
const sorted = (entries) => [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));

/** @param {'sha1' | 'sha256'} format @param {GitObject} o */
function idOf(format, o) {
  if (o.type === 'blob') return gitId(format, 'blob', o.data);
  if (o.type === 'tree') return gitId(format, 'tree', Buffer.concat(sorted(o.entries).flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
  const stamp = `${Math.floor(Date.parse(o.date) / 1000)} +0000`;
  const parents = o.parents.map((p) => `parent ${p}\n`).join('');
  return gitId(format, 'commit', Buffer.from(`tree ${o.tree}\n${parents}author me <me@example.com> ${stamp}\ncommitter me <me@example.com> ${stamp}\n\n${o.message}`));
}

/**
 * @param {{ token?: string, user?: string, repos?: Record<string, { private?: boolean, archived?: boolean, format?: 'sha1' | 'sha256', defaultBranch?: string,
 *   push?: boolean, mirror?: boolean, files?: Record<string, string | Buffer> }>, cors?: boolean | string, perPage?: number, flavor?: 'forgejo' | 'gitea',
 *   maxBody?: number, lfs?: boolean, maxItems?: number }} [opts]
 *   user: the tokens' account; repos: each one empty, or with one commit holding files; cors: true allows any origin, a string only that origin, false none
 *   (Forgejo's default); perPage: the most tree entries a page holds; flavor: Gitea says truncated only while more pages follow,
 *   and answers a stale sha with 422; maxBody: a proxy in front refuses larger requests with 413, without CORS headers;
 *   lfs: the server keeps files .gitattributes sends to Git LFS ([server] LFS_START_SERVER): ChangeFiles commits a pointer
 *   to the content in their place, as both servers did (2026-10-18), and /media gives the content; maxItems: the most a
 *   page of the repository search holds ([api] MAX_RESPONSE_ITEMS, 50 unless the server's app.ini says less)
 */
export async function startForgejo({ token = TOKEN, user = 'me', repos = {}, cors = true, perPage = 1000, flavor = 'forgejo', maxBody = Infinity, lfs = false, maxItems = 50 } = {}) {
  /** @type {Map<string, Repo>} */
  const all = new Map();
  /** @type {{ method: string, path: string, status: number, body: string }[]} */
  const log = [];
  /** @type {(() => void) | null} */
  let beforeChange = null;
  /** @type {(() => void) | null} */
  let duringChange = null;
  /** @type {{ method: string, part: string, answer: Answer | ((own: Answer) => Answer) } | null} */
  let next = null;
  /** @type {{ gate: Promise<void>, pass: number } | null} */
  let held = null;
  let waiting = 0;
  /** @type {number} bytes the owner may keep, or Infinity */
  let quota = Infinity;
  let origin = '';

  /** @param {Repo} repo @param {GitObject} o */
  const keep = (repo, o) => {
    const sha = idOf(repo.format, o);
    repo.objects.set(sha, o);
    return sha;
  };
  /** @param {Repo} repo @param {Buffer} data */
  const blob = (repo, data) => keep(repo, { type: 'blob', data });
  /** What Git LFS keeps, by the content's SHA-256. @type {Map<string, Buffer>} */
  const kept = new Map();
  /** A file's text on a branch, or ''. @param {Repo} repo @param {{ sha: string } | undefined} f */
  const text = (repo, f) => (f ? /** @type {any} */ (repo.objects.get(f.sha))?.data?.toString() ?? '' : '');
  /**
   * What the tree holds for a file: itself, or, where .gitattributes says filter=lfs, a pointer to it (Forgejo's lfs.Pointer.StringContent).
   * @param {Repo} repo @param {string} attributes @param {string} path @param {Buffer} data
   */
  const stored = (repo, attributes, path, data) => {
    const lfsd = attributes.split('\n').some((line) => {
      const [pattern, ...attrs] = line.trim().split(/\s+/);
      if (!pattern || !attrs.includes('filter=lfs')) return false;
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
      return re.test(pattern.includes('/') ? path : /** @type {string} */ (path.split('/').pop()));
    });
    if (!lfsd) return data;
    const oid = createHash('sha256').update(data).digest('hex');
    kept.set(oid, data);
    return Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${data.length}\n`);
  };
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  /** @param {Repo} repo @param {Files} files */
  function build(repo, files) {
    /** @type {Dir} */
    const root = { files: new Map(), dirs: new Map() };
    for (const [path, f] of files) {
      const parts = path.split('/');
      let d = root;
      for (const p of parts.slice(0, -1)) {
        if (!d.dirs.has(p)) d.dirs.set(p, { files: new Map(), dirs: new Map() });
        d = /** @type {Dir} */ (d.dirs.get(p));
      }
      d.files.set(/** @type {string} */ (parts.at(-1)), f);
    }
    /** @param {Dir} d @returns {string} */
    const write = (d) => keep(repo, { type: 'tree', entries: [
      ...[...d.files].map(([name, f]) => ({ name, mode: f.mode, sha: f.sha })),
      ...[...d.dirs].map(([name, sub]) => ({ name, mode: '40000', sha: write(sub) })),
    ] });
    return write(root);
  }

  /** Every file under a tree, by path. @param {Repo} repo @param {string} sha @returns {Files} */
  function flatten(repo, sha, prefix = '', out = new Map()) {
    const t = repo.objects.get(sha);
    if (t?.type !== 'tree') return out;
    for (const e of t.entries) {
      if (e.mode === '40000') flatten(repo, e.sha, `${prefix}${e.name}/`, out);
      else out.set(`${prefix}${e.name}`, { sha: e.sha, mode: e.mode });
    }
    return out;
  }

  /** The tree a commit or tree id names, or null. @param {Repo} repo @param {string} sha */
  function treeOf(repo, sha) {
    const o = repo.objects.get(sha);
    if (o?.type === 'tree') return sha;
    if (o?.type === 'commit') return o.tree;
    return null;
  }

  /** A branch, or a commit's id, as a commit's id; null when it is neither. @param {Repo} repo @param {string} ref */
  function resolve(repo, ref) {
    const branch = repo.refs.get(ref);
    if (branch) return branch;
    return repo.objects.get(ref)?.type === 'commit' ? ref : null;
  }

  /** What the owner keeps, in bytes: every blob in every repository. */
  const used = () => [...all.values()].reduce((n, r) => n + [...r.objects.values()].reduce((m, o) => m + (o.type === 'blob' ? o.data.length : 0), 0), 0);

  /** @param {Repo} repo @param {Files} files @param {string} message @param {string[]} parents */
  const commitOf = (repo, files, message, parents) => keep(repo, { type: 'commit', tree: build(repo, files), parents, message: `${message.trim()}\n`, date: now() });

  /** @param {string} sha @param {any} c a commit */
  const commitJson = (sha, c) => {
    const who = { name: 'me', email: 'me@example.com', date: c.date };
    return { sha, message: c.message, author: who, committer: who, tree: { sha: c.tree, url: `${origin}/api/v1/git/trees/${c.tree}` }, parents: c.parents.map((/** @type {string} */ p) => ({ sha: p })) };
  };

  /** Recursive entries, depth first in git's order, each folder before what it holds (git ls-tree -r -t). @param {Repo} repo @param {string} sha @returns {any[]} */
  function treeJson(repo, sha, recursive, prefix = '') {
    const t = repo.objects.get(sha);
    if (t?.type !== 'tree') return [];
    return sorted(t.entries).flatMap((e) => {
      const path = `${prefix}${e.name}`;
      if (e.mode !== '40000') {
        const o = repo.objects.get(e.sha);
        return [{ path, mode: e.mode, type: 'blob', size: o?.type === 'blob' ? o.data.length : 0, sha: e.sha }];
      }
      return [{ path, mode: '040000', type: 'tree', size: 0, sha: e.sha }, ...(recursive ? treeJson(repo, e.sha, true, `${path}/`) : [])];
    });
  }

  /** @param {Repo} repo */
  const repoJson = (repo) => ({
    id: 1, name: repo.name.split('/')[1], full_name: repo.name, owner: { id: 1, login: repo.name.split('/')[0] }, private: repo.private, internal: false,
    empty: repo.refs.size === 0, archived: repo.archived, mirror: repo.mirror, default_branch: repo.defaultBranch, object_format_name: repo.format,
    permissions: { admin: repo.name.startsWith(`${user}/`), push: repo.push, pull: true },
  });

  for (const [name, r] of Object.entries(repos)) {
    /** @type {Repo} */
    const repo = { name, private: r.private ?? true, archived: r.archived ?? false, format: r.format ?? 'sha1', defaultBranch: r.defaultBranch ?? 'main',
      push: r.push ?? true, mirror: r.mirror ?? false, objects: new Map(), refs: new Map() };
    all.set(name, repo);
    if (r.files) {
      /** @type {Files} */
      const files = new Map(Object.entries(r.files).map(([p, c]) => [p, { sha: blob(repo, Buffer.from(c)), mode: '100644' }]));
      repo.refs.set(repo.defaultBranch, commitOf(repo, files, 'Initial commit', []));
    }
  }

  /** ChangeFiles, as Forgejo's services/repository/files/update.go does it. @param {Repo} repo @param {any} body @param {string} authed @returns {Answer} */
  function changeFiles(repo, body, authed) {
    if (authed !== token && authed !== USER_TOKEN) return { status: 403, json: err('token does not have at least one of required scope(s): [write:repository]') };
    if (repo.archived) return { status: 423, json: err(`<Repository 1:${repo.name}> is archived`) };
    if (used() > quota) return { status: 413, json: { message: 'quota exceeded', user_id: 1, username: repo.name.split('/')[0] } };
    if (!Array.isArray(body?.files)) return { status: 422, json: err('[Files]: Required') };
    const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
    const before = beforeChange;
    beforeChange = null;
    before?.();
    if (all.get(repo.name) !== repo) return notFound(); // deleted meanwhile
    const empty = repo.refs.size === 0;
    const head = repo.refs.get(branch);
    if (!head && !empty) return { status: 404, json: err(`branch does not exist [name: ${branch}]`) };
    /** @type {Files} */
    const base = head ? flatten(repo, /** @type {string} */ (treeOf(repo, head))) : new Map();
    const dirs = new Set([...base.keys()].flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
    for (const f of body.files) {
      const path = String(f?.path ?? '').replace(/^\/+|\/+$/g, '');
      const parts = path.split('/');
      if (!path || parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) return { status: 422, json: err(`path contains a malformed path component [path: ${f?.path}]`) };
      if (f.content !== undefined && !/^[A-Za-z0-9+/]*={0,2}$/.test(String(f.content))) return { status: 422, json: err('illegal base64 data at input byte 0') };
      if (!['create', 'update', 'delete'].includes(f.operation)) return { status: 500, json: err(`invalid file operation: ${f.operation} ${path}, supported operations are create, update, delete`) };
      if (f.operation === 'delete' && !head) return { status: 500, json: err(`branch does not exist [name: ${branch}]`) };
    }
    // A file to delete, or to update, that the branch doesn't have: Forgejo answers 500, Gitea 404.
    const gone = (/** @type {string} */ path, /** @type {string} */ forgejo) => (flavor === 'gitea'
      ? { status: 404, json: err(`object does not exist [id: , rel_path: ${path}]`) } : { status: 500, json: err(forgejo) });
    for (const f of body.files) {
      if (f.operation !== 'delete') continue;
      if (!base.has(f.path)) return gone(f.path, `repository file does not exist [path: ${f.path}]`);
    }
    for (const f of body.files) {
      const had = base.get(f.path);
      if (f.operation === 'update' || f.operation === 'delete') {
        if (!had) return gone(f.path, `object does not exist [id: , rel_path: ${f.path}]`);
        // Without a file's id, Gitea checks against the branch's head as it is now, so it always passes; Forgejo refuses.
        if (!f.sha && flavor !== 'gitea') return { status: 422, json: err('a SHA or commit ID must be provided when updating a file') };
        if (f.sha && f.sha !== had.sha) return { status: flavor === 'gitea' ? 422 : 409, json: err(`sha does not match [given: ${f.sha}, expected: ${had.sha}]`) };
      }
      if (f.operation === 'create' || f.operation === 'update') {
        const parts = f.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const sub = parts.slice(0, i).join('/');
          if (base.has(sub)) return { status: 422, json: err(`a file exists where you’re trying to create a subdirectory [path: ${sub}]`) };
        }
        if (dirs.has(f.path)) return { status: 422, json: err(`a directory exists where you’re trying to create a file [path: ${f.path}]`) };
        if (f.operation === 'create' && had) return { status: 422, json: err(`repository file already exists [path: ${f.path}]`) };
      }
    }
    // Forgejo reads the attributes as the branch has them; Gitea also takes a .gitattributes the same request brings.
    const attributes = lfs ? text(repo, base.get('.gitattributes')) + (flavor === 'gitea' ? body.files.filter((/** @type {any} */ f) => f.path === '.gitattributes' && f.content).map((/** @type {any} */ f) => Buffer.from(f.content, 'base64').toString()).join('\n') : '') : '';
    const files = new Map(base);
    for (const f of body.files) {
      if (f.operation === 'delete') files.delete(f.path);
      else files.set(f.path, { sha: blob(repo, stored(repo, attributes, f.path, Buffer.from(String(f.content ?? ''), 'base64'))), mode: '100644' });
    }
    const during = duringChange;
    duringChange = null;
    during?.();
    const sha = commitOf(repo, files, String(body.message ?? 'Update files'), head ? [head] : []);
    // The push from the server's temporary copy is never forced: a branch that moved meanwhile refuses it, with 403.
    const moved = repo.refs.get(branch);
    if (moved !== head) {
      return { status: 403, json: err(flavor === 'gitea'
        ? `cannot lock ref 'refs/heads/${branch}': is at ${moved} but expected ${head}`
        : `PushRejected Error: exit status 1 - To /var/lib/gitea/git/repositories/${repo.name}.git\n ! [remote rejected] ${sha} -> ${branch} (incorrect old value provided)\nerror: failed to push some refs to '/var/lib/gitea/git/repositories/${repo.name}.git'`) };
    }
    repo.refs.set(branch, sha);
    // An empty repository's first commit, on whatever branch, makes that branch its default.
    if (empty) repo.defaultBranch = branch;
    const c = /** @type {any} */ (repo.objects.get(sha));
    return {
      status: 201,
      json: {
        files: body.files.map((/** @type {any} */ f) => {
          if (f.operation === 'delete') return null;
          const kept = /** @type {{ sha: string }} */ (files.get(f.path));
          const data = /** @type {any} */ (repo.objects.get(kept.sha)).data;
          // Over [api] DEFAULT_MAX_BLOB_SIZE, Forgejo gives "" for the content, Gitea null.
          const content = data.length <= MAX_BLOB_SIZE ? data.toString('base64') : flavor === 'gitea' ? null : '';
          return { name: f.path.split('/').pop(), path: f.path, sha: kept.sha, type: 'file', size: data.length, encoding: 'base64', content };
        }),
        commit: commitJson(sha, c),
        verification: { verified: false, reason: 'gpg.error.not_signed_commit', signature: '', signer: null, payload: '' },
      },
    };
  }

  /**
   * @param {string} method @param {URL} url @param {import('node:http').IncomingHttpHeaders} headers @param {any} body
   * @returns {Answer}
   */
  function answer(method, url, headers, body) {
    const m = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const auth = /^(?:token|bearer) (.+)$/i.exec(String(headers.authorization ?? ''))?.[1] ?? '';
    if (!headers.authorization) return { status: 401, json: err('token is required') };
    if (auth !== token && auth !== READ_TOKEN && auth !== USER_TOKEN) return { status: 401, json: err(`access token does not exist [sha: ${auth.slice(0, 40)}]`) };
    if (method === 'GET' && url.pathname === '/api/v1/user') {
      return auth === USER_TOKEN ? { status: 200, json: { id: 1, login: user, username: user } } : { status: 403, json: err('token does not have at least one of required scope(s): [read:user]') };
    }
    if (method === 'GET' && url.pathname === '/api/v1/repos/search') {
      // What the user may see, by name; is_private and archived filter, q matches part of a name.
      const q = url.searchParams;
      const flag = (/** @type {string} */ k) => (q.has(k) ? q.get(k) === 'true' : null);
      const [priv, archived, words] = [flag('is_private'), flag('archived'), (q.get('q') ?? '').toLowerCase()];
      const found = [...all.values()].filter((x) => (priv === null || x.private === priv) && (archived === null || x.archived === archived) && x.name.split('/')[1].toLowerCase().includes(words))
        .sort((a, b) => (a.name.split('/')[1] < b.name.split('/')[1] ? -1 : 1));
      const limit = Math.min(maxItems, Number(q.get('limit')) || 30);
      const start = (Math.max(1, Number(q.get('page')) || 1) - 1) * limit;
      return { status: 200, json: { ok: true, data: found.slice(start, start + limit).map(repoJson) }, headers: { 'x-total-count': String(found.length) } };
    }
    const repo = m ? all.get(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`) : undefined;
    if (!m || !repo) return notFound();
    const rest = m[3] ?? '';
    /** @type {RegExpExecArray | null} */
    let r;
    if (method === 'GET' && rest === '') return { status: 200, json: repoJson(repo) };
    if (method === 'GET' && (r = /^\/branches\/(.+)$/.exec(rest))) {
      const branch = decodeURIComponent(r[1]);
      const sha = repo.refs.get(branch);
      if (!sha) return notFound([`branch does not exist [name: ${branch}]`]);
      const c = /** @type {any} */ (repo.objects.get(sha));
      return { status: 200, json: { name: branch, commit: { id: sha, message: c.message, timestamp: c.date, author: { name: 'me', email: 'me@example.com', username: 'me' } }, protected: false, user_can_push: true } };
    }
    if (method === 'GET' && (r = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const c = /** @type {any} */ (repo.objects.get(r[1]));
      if (c?.type !== 'commit') return flavor === 'gitea' ? { status: 404, json: err(`commit doesn't exist: ${r[1]}`) } : { status: 404, json: err(r[1], []) };
      const j = commitJson(r[1], c);
      return { status: 200, json: { sha: r[1], created: c.date, commit: { message: j.message, author: j.author, committer: j.committer, tree: j.tree }, parents: j.parents } };
    }
    if (method === 'GET' && (r = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest))) {
      const tree = treeOf(repo, r[1]);
      if (!tree) return { status: 400, json: err(`sha not found [${r[1]}]`) };
      const entries = treeJson(repo, tree, ['true', '1'].includes(url.searchParams.get('recursive') ?? ''));
      const asked = Number(url.searchParams.get('per_page'));
      const per = asked > 0 && asked < perPage ? asked : perPage;
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const start = per * (page - 1);
      const json = { sha: r[1], url: `${origin}${url.pathname}`, page, total_count: entries.length };
      if (start >= entries.length) return { status: 200, json: { ...json, tree: null, truncated: false } };
      const end = Math.min(start + per, entries.length);
      return { status: 200, json: { ...json, tree: entries.slice(start, end), truncated: flavor === 'gitea' ? end < entries.length : entries.length > per } };
    }
    if (method === 'GET' && (r = /^\/(raw|media)\/(.+)$/.exec(rest))) {
      const at = resolve(repo, url.searchParams.get('ref') ?? repo.defaultBranch);
      const path = r[2].split('/').map(decodeURIComponent).join('/');
      const f = at ? flatten(repo, /** @type {string} */ (treeOf(repo, at))).get(path) : undefined;
      const b = f ? repo.objects.get(f.sha) : undefined;
      if (b?.type !== 'blob') return notFound();
      // /media follows a pointer to the content Git LFS keeps; /raw gives the pointer.
      const oid = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\n/.exec(b.data.toString('latin1'))?.[1];
      return { status: 200, raw: r[1] === 'media' && oid && kept.has(oid) ? /** @type {Buffer} */ (kept.get(oid)) : b.data };
    }
    if (method === 'GET' && rest === '/commits') {
      if (repo.refs.size === 0) return { status: 409, json: err('Git Repository is empty.') };
      let sha = resolve(repo, url.searchParams.get('sha') ?? repo.defaultBranch);
      if (!sha) return notFound();
      const limit = Math.min(50, Number(url.searchParams.get('limit')) || 30);
      const skip = (Math.max(1, Number(url.searchParams.get('page')) || 1) - 1) * limit;
      const out = [];
      for (let i = 0; sha && out.length < limit; i++) {
        const c = /** @type {any} */ (repo.objects.get(sha));
        const j = commitJson(sha, c);
        if (i >= skip) out.push({ sha, created: c.date, commit: { message: j.message, author: j.author, committer: j.committer, tree: j.tree }, parents: j.parents });
        sha = c.parents[0];
      }
      return { status: 200, json: out };
    }
    if (method === 'POST' && rest === '/contents') return changeFiles(repo, body, auth);
    return notFound();
  }

  /** The CORS headers Forgejo's go-chi/cors sends for a request from origin, or none. @param {string | undefined} from */
  const allows = (from) => Boolean(from) && cors !== false && (cors === true || cors === from);

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      // A backup's files (not its manifest) wait here while holdFiles is on.
      if (held && method === 'GET' && url.pathname.includes('/media/') && !url.pathname.endsWith('/media/annai-archive.json') && held.pass-- <= 0) {
        waiting++;
        await held.gate;
        waiting--;
      }
      const from = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const raw = Buffer.concat(chunks);
      /** @type {Answer} */
      let a;
      if (method === 'OPTIONS') {
        // A preflight: only when CORS is on, and only for methods and headers it allows; otherwise no CORS headers.
        const wanted = String(req.headers['access-control-request-method'] ?? '');
        const asked = String(req.headers['access-control-request-headers'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (cors === false || !wanted) a = { status: 405, headers: { allow: 'GET' }, cors: false };
        else if (!allows(from) || !ALLOWED_METHODS.includes(wanted) || asked.some((h) => !ALLOWED_HEADERS.includes(h))) a = { status: 200, cors: false };
        else a = { status: 200, headers: { 'access-control-allow-methods': wanted, 'access-control-allow-headers': asked.join(', '), 'access-control-max-age': '600' } };
      } else if (raw.length > maxBody) {
        a = { status: 413, raw: Buffer.from('<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413 Request Entity Too Large</h1></center><hr><center>nginx</center></body></html>'), headers: { 'content-type': 'text/html' }, cors: false };
      } else {
        // answerNext's answer: given as it is, or, a function, the answer the stand-in would have given this very request (the file at the ref
        // it asked for) to change. Either way a throw is an answer (400 for a body that didn't parse, else 500), never a request left unanswered.
        const made = next && method === next.method && url.pathname.includes(next.part) ? next.answer : null;
        if (made) next = null;
        try {
          const own = () => answer(method, url, req.headers, raw.length ? JSON.parse(raw.toString('utf8')) : null);
          a = typeof made === 'function' ? made(own()) : made ?? own();
        } catch (e) {
          a = raw.length ? { status: 400, json: err(`[]: ${String(/** @type {any} */ (e)?.message ?? e)}`) } : { status: 500, json: err(String(e)) };
        }
      }
      log.push({ method, path: url.pathname, status: a.drop ? 0 : a.status, body: raw.toString('utf8') });
      if (a.drop) {
        req.socket.destroy();
        return;
      }
      const payload = a.raw ?? (a.json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(a.json)));
      res.writeHead(a.status, {
        ...(a.cors !== false && allows(from) ? { 'access-control-allow-origin': /** @type {string} */ (from), vary: 'Origin' } : {}),
        ...(a.raw ? { 'content-type': 'text/plain; charset=utf-8' } : a.json === undefined ? {} : { 'content-type': 'application/json;charset=utf-8' }),
        'content-length': String(payload.length), 'x-content-type-options': 'nosniff', ...(a.headers ?? {}),
      });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

  /** @param {string} name */
  const repoOf = (name) => {
    const r = all.get(name);
    if (!r) throw new Error(`the stand-in has no repository ${name}`);
    return r;
  };
  return {
    origin, token, log,
    /** How many requests with this method went to a path ending so. @param {string} method @param {string} end */
    count: (method, end) => log.filter((l) => l.method === method && l.path.endsWith(end)).length,
    /** The files on a branch (the default one), by path. @param {string} name @param {string} [branch] @returns {Map<string, Buffer>} */
    files(name, branch) {
      const repo = repoOf(name);
      const at = repo.refs.get(branch ?? repo.defaultBranch);
      /** @type {Map<string, Buffer>} */
      const out = new Map();
      if (!at) return out;
      for (const [path, f] of flatten(repo, /** @type {string} */ (treeOf(repo, at)))) out.set(path, /** @type {any} */ (repo.objects.get(f.sha)).data);
      return out;
    },
    /** The commits on a branch, newest first, by first parents. @param {string} name @param {string} [branch] */
    commits(name, branch) {
      const repo = repoOf(name);
      /** @type {{ sha: string, message: string, parents: string[], tree: string }[]} */
      const out = [];
      let sha = repo.refs.get(branch ?? repo.defaultBranch);
      while (sha) {
        const c = /** @type {any} */ (repo.objects.get(sha));
        out.push({ sha, message: c.message, parents: c.parents, tree: c.tree });
        sha = c.parents[0];
      }
      return out;
    },
    /** Another device (or a person) commits these files, as the whole tree, on the default branch. @param {string} name @param {Record<string, string | Buffer>} files @param {string} message */
    commitAs(name, files, message) {
      const repo = repoOf(name);
      const parent = repo.refs.get(repo.defaultBranch);
      /** @type {Files} */
      const tree = new Map(Object.entries(files).map(([p, c]) => [p, { sha: blob(repo, Buffer.from(c)), mode: '100644' }]));
      const sha = commitOf(repo, tree, message, parent ? [parent] : []);
      repo.refs.set(repo.defaultBranch, sha);
      return sha;
    },
    /** Runs fn as the next ChangeFiles starts, before it reads the branch: another device's backup lands first. @param {() => void} fn */
    beforeChange(fn) {
      beforeChange = fn;
    },
    /** Runs fn after the next ChangeFiles has checked the branch, before it pushes: another device's push lands in between, and this push is refused (403). @param {() => void} fn */
    duringChange(fn) {
      duringChange = fn;
    },
    /** The requests for a backup's files (not its manifest) wait, after the first letThrough of them, until the returned function is called. @param {number} [letThrough] @returns {() => void} */
    holdFiles(letThrough = 0) {
      /** @type {() => void} */
      let release = () => {};
      held = { gate: new Promise((resolve) => { release = () => resolve(undefined); }), pass: letThrough };
      return () => {
        held = null;
        release();
      };
    },
    /** How many requests for files are waiting in holdFiles. */
    waiting: () => waiting,
    /**
     * The next request with this method to a path holding part gets this answer instead; or, given a function, that function's answer
     * to the stand-in's own for this request. @param {string} method @param {string} part @param {Answer | ((own: Answer) => Answer)} a
     */
    answerNext(method, part, a) {
      next = { method, part, answer: a };
    },
    /** @param {number} bytes what the owner may keep; Forgejo refuses changes once more is used */
    setQuota(bytes) {
      quota = bytes;
    },
    /** @param {string} name @param {boolean} value */
    setPrivate(name, value) {
      repoOf(name).private = value;
    },
    /** @param {string} name @param {boolean} value */
    setArchived(name, value) {
      repoOf(name).archived = value;
    },
    /** Someone makes a branch where another is. @param {string} name @param {string} branch @param {string} from */
    branchFrom(name, branch, from) {
      const repo = repoOf(name);
      repo.refs.set(branch, /** @type {string} */ (repo.refs.get(from)));
    },
    /** Someone deletes a branch, as the web page's Branches tab does (never the default one). @param {string} name @param {string} branch */
    deleteBranch(name, branch) {
      repoOf(name).refs.delete(branch);
    },
    /** Someone deletes the whole repository. @param {string} name */
    deleteRepo(name) {
      all.delete(name);
    },
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    }),
  };
}
