import http from 'node:http';
import { createHash } from 'node:crypto';

/**
 * A stand-in for the part of GitHub's REST API that annai's GitHub backups use: the repository,
 * refs, commits, trees and blobs of the Git Data API, the contents API for a first commit, and the
 * commit list. It answers with GitHub's status codes, messages and CORS headers (checked
 * 2026-10-16). It hashes git objects with code of its own (node:crypto), so annai's ids are checked
 * against an independent implementation. Tests and the end-to-end suite run it on a port of its own
 * (port 0): WebKit can't route requests from a page a service worker controls.
 * @typedef {{ type: 'blob', data: Buffer } | { type: 'tree', entries: { name: string, mode: string, sha: string }[] }
 *   | { type: 'commit', tree: string, parents: string[], message: string, date: string }} GitObject
 * @typedef {{ name: string, private: boolean, defaultBranch: string, objects: Map<string, GitObject>, refs: Map<string, string> }} Repo
 * @typedef {Map<string, { sha: string, mode: string }>} Files path → file
 * @typedef {{ files: Map<string, { sha: string, mode: string }>, dirs: Map<string, Dir> }} Dir
 * @typedef {{ status: number, json?: any, raw?: Buffer, headers?: Record<string, string> }} Answer
 */

export const TOKEN = 'ghp_standin_0123456789abcdefghijklmnopqr';

const ALLOW_HEADERS = 'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, Accept-Encoding, X-GitHub-OTP, X-Requested-With, User-Agent, X-GitHub-Api-Version';
const EXPOSE_HEADERS = 'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-Request-Id';
const DOCS = 'https://docs.github.com/rest';
/** @type {Answer} */
const NOT_FOUND = { status: 404, json: { message: 'Not Found', documentation_url: DOCS } };
/** @type {Answer} */
const EMPTY = { status: 409, json: { message: 'Git Repository is empty.', documentation_url: DOCS } };

/** @param {string} type @param {Buffer} body */
const gitId = (type, body) => createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');

/** Git sorts a folder as its name followed by "/". @param {{ name: string, mode: string }} e */
const sortKey = (e) => Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name);

/** @param {GitObject} o */
function idOf(o) {
  if (o.type === 'blob') return gitId('blob', o.data);
  if (o.type === 'tree') {
    const sorted = [...o.entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
    return gitId('tree', Buffer.concat(sorted.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
  }
  const stamp = `${Math.floor(Date.parse(o.date) / 1000)} +0000`;
  const parents = o.parents.map((p) => `parent ${p}\n`).join('');
  const who = 'annai <annai@users.noreply.github.com>';
  return gitId('commit', Buffer.from(`tree ${o.tree}\n${parents}author ${who} ${stamp}\ncommitter ${who} ${stamp}\n\n${o.message}`));
}

/**
 * @param {{ token?: string, repos?: Record<string, { private?: boolean, defaultBranch?: string, files?: Record<string, string | Buffer> }> }} [opts]
 *   repos: each one empty, or with one commit holding files
 */
export async function startGitHub({ token = TOKEN, repos = {} } = {}) {
  /** @type {Map<string, Repo>} */
  const all = new Map();
  /** @type {{ method: string, path: string, status: number }[]} */
  const log = [];
  /** @type {{ after: number, retryAfter: number, times: number, seen: number } | null} */
  let limit = null;
  /** @type {(() => void) | null} */
  let beforeRef = null;
  let tamper = false;
  let origin = '';

  /** @param {Repo} repo @param {GitObject} o */
  const keep = (repo, o) => {
    const sha = idOf(o);
    repo.objects.set(sha, o);
    return sha;
  };
  /** @param {Repo} repo @param {Buffer} data */
  const blob = (repo, data) => keep(repo, { type: 'blob', data });
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  /** The tree of these files, or null when git can't hold one of their paths. @param {Repo} repo @param {Files} files */
  function build(repo, files) {
    /** @type {Dir} */
    const root = { files: new Map(), dirs: new Map() };
    for (const [path, f] of files) {
      const parts = path.split('/');
      if (parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) return null;
      let d = root;
      for (const p of parts.slice(0, -1)) {
        if (d.files.has(p)) return null;
        if (!d.dirs.has(p)) d.dirs.set(p, { files: new Map(), dirs: new Map() });
        d = d.dirs.get(p);
      }
      const name = parts.at(-1);
      if (d.dirs.has(name)) return null;
      d.files.set(name, f);
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

  /** @param {Repo} repo @param {Files} files @param {string} message @param {string[]} parents */
  const commitOf = (repo, files, message, parents) => keep(repo, { type: 'commit', tree: build(repo, files), parents, message, date: now() });

  /** Whether sha has old among its ancestors (or is old). @param {Repo} repo @param {string} old @param {string} sha */
  function descends(repo, old, sha) {
    const seen = new Set();
    const todo = [sha];
    while (todo.length) {
      const s = todo.pop();
      if (s === old) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      const c = repo.objects.get(s);
      if (c?.type === 'commit') todo.push(...c.parents);
    }
    return false;
  }

  /** @param {string} sha @param {any} c a commit */
  const commitJson = (sha, c) => {
    const who = { name: 'annai', email: 'annai@users.noreply.github.com', date: c.date };
    return { sha, tree: { sha: c.tree }, parents: c.parents.map((/** @type {string} */ p) => ({ sha: p })), message: c.message, author: who, committer: who };
  };

  /** @param {Repo} repo @param {string} sha @param {boolean} recursive @returns {any[]} */
  function treeJson(repo, sha, recursive, prefix = '') {
    const t = repo.objects.get(sha);
    if (t?.type !== 'tree') return [];
    return t.entries.flatMap((e) => {
      const path = `${prefix}${e.name}`;
      if (e.mode !== '40000') {
        const o = repo.objects.get(e.sha);
        return [{ path, mode: e.mode, type: 'blob', sha: e.sha, size: o?.type === 'blob' ? o.data.length : 0 }];
      }
      return [{ path, mode: '040000', type: 'tree', sha: e.sha }, ...(recursive ? treeJson(repo, e.sha, true, `${path}/`) : [])];
    });
  }

  for (const [name, r] of Object.entries(repos)) {
    /** @type {Repo} */
    const repo = { name, private: r.private ?? true, defaultBranch: r.defaultBranch ?? 'main', objects: new Map(), refs: new Map() };
    all.set(name, repo);
    if (r.files) {
      /** @type {Files} */
      const files = new Map(Object.entries(r.files).map(([p, c]) => [p, { sha: blob(repo, Buffer.from(c)), mode: '100644' }]));
      repo.refs.set(repo.defaultBranch, commitOf(repo, files, 'Initial commit', []));
    }
  }

  /**
   * @param {string} method @param {URL} url @param {import('node:http').IncomingHttpHeaders} headers @param {any} body
   * @returns {Answer}
   */
  function answer(method, url, headers, body) {
    if (method === 'OPTIONS') {
      return { status: 204, headers: { 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE', 'access-control-allow-headers': ALLOW_HEADERS, 'access-control-max-age': '86400' } };
    }
    const auth = String(headers.authorization ?? '');
    if (auth !== `Bearer ${token}` && auth !== `token ${token}`) return { status: 401, json: { message: 'Bad credentials', documentation_url: DOCS } };
    const m = /^\/repos\/([^/]+\/[^/]+?)(\/.*)?$/.exec(url.pathname);
    const repo = m ? all.get(decodeURIComponent(m[1])) : undefined;
    if (!m || !repo) return NOT_FOUND;
    const rest = m[2] ?? '';
    const empty = repo.refs.size === 0;
    /** @type {RegExpExecArray | null} */
    let r;
    if (method === 'GET' && rest === '') {
      return { status: 200, json: { full_name: repo.name, private: repo.private, visibility: repo.private ? 'private' : 'public', default_branch: repo.defaultBranch,
        permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } } };
    }
    if (method === 'GET' && (r = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      if (empty) return EMPTY;
      const branch = decodeURIComponent(r[1]);
      const sha = repo.refs.get(branch);
      return sha ? { status: 200, json: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } } : NOT_FOUND;
    }
    if (method === 'GET' && (r = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      const c = repo.objects.get(r[1]);
      return c?.type === 'commit' ? { status: 200, json: commitJson(r[1], c) } : NOT_FOUND;
    }
    if (method === 'GET' && (r = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      if (repo.objects.get(r[1])?.type !== 'tree') return NOT_FOUND;
      return { status: 200, json: { sha: r[1], tree: treeJson(repo, r[1], url.searchParams.has('recursive')), truncated: false } };
    }
    if ((method === 'GET' || method === 'HEAD') && (r = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
      const b = repo.objects.get(r[1]);
      if (b?.type !== 'blob') return NOT_FOUND;
      if (String(headers.accept ?? '').includes('raw')) return { status: 200, raw: b.data };
      return { status: 200, json: { sha: r[1], node_id: r[1], size: b.data.length, url: `${origin}${url.pathname}`, content: b.data.toString('base64'), encoding: 'base64' } };
    }
    if (method === 'POST' && rest === '/git/blobs') {
      if (empty) return EMPTY;
      if (limit && ++limit.seen > limit.after && limit.times > 0) {
        limit.times--;
        return { status: 403, headers: { 'retry-after': String(limit.retryAfter) }, json: {
          message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again. If you reach out to GitHub Support for help, please include the request ID.',
          documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits' } };
      }
      const data = body?.encoding === 'base64' ? Buffer.from(String(body.content), 'base64') : Buffer.from(String(body?.content ?? ''), 'utf8');
      const sha = blob(repo, data);
      return { status: 201, json: { sha, url: `${origin}/repos/${repo.name}/git/blobs/${sha}` } };
    }
    if (method === 'POST' && rest === '/git/trees') {
      if (empty) return EMPTY;
      /** @type {Files} */
      const files = body?.base_tree ? flatten(repo, body.base_tree) : new Map();
      for (const e of body?.tree ?? []) {
        if (e.sha !== undefined && e.content !== undefined) return { status: 422, json: { message: 'Must supply either tree.sha or tree.content, not both.' } };
        if (e.sha === null) {
          if (!files.delete(e.path)) return { status: 422, json: { message: 'Invalid tree info' } };
        } else if (e.content !== undefined) {
          files.set(e.path, { sha: blob(repo, Buffer.from(String(e.content), 'utf8')), mode: e.mode });
        } else if (repo.objects.get(e.sha)?.type === 'blob') {
          files.set(e.path, { sha: e.sha, mode: e.mode });
        } else {
          return { status: 422, json: { message: `tree.sha ${e.sha} is not a valid blob` } };
        }
      }
      if (tamper) {
        tamper = false;
        files.set('tampered.txt', { sha: blob(repo, Buffer.from('x')), mode: '100644' });
      }
      const sha = build(repo, files);
      if (!sha) return { status: 422, json: { message: 'tree.path contains a malformed path component' } };
      return { status: 201, json: { sha, url: `${origin}/repos/${repo.name}/git/trees/${sha}`, tree: treeJson(repo, sha, false), truncated: false } };
    }
    if (method === 'POST' && rest === '/git/commits') {
      if (empty) return EMPTY;
      const parents = body?.parents ?? [];
      if (repo.objects.get(body?.tree)?.type !== 'tree' || parents.some((/** @type {string} */ p) => repo.objects.get(p)?.type !== 'commit')) {
        return { status: 422, json: { message: 'Invalid request.' } };
      }
      const sha = keep(repo, { type: 'commit', tree: body.tree, parents, message: String(body.message ?? ''), date: now() });
      return { status: 201, json: commitJson(sha, repo.objects.get(sha)) };
    }
    if (method === 'PATCH' && (r = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const before = beforeRef;
      beforeRef = null;
      before?.();
      const branch = decodeURIComponent(r[1]);
      const old = repo.refs.get(branch);
      if (!old) return { status: 422, json: { message: 'Reference does not exist' } };
      if (repo.objects.get(body?.sha)?.type !== 'commit') return { status: 422, json: { message: 'Object does not exist' } };
      if (!body.force && !descends(repo, old, body.sha)) return { status: 422, json: { message: 'Update is not a fast forward' } };
      repo.refs.set(branch, body.sha);
      return { status: 200, json: { ref: `refs/heads/${branch}`, object: { sha: body.sha, type: 'commit' } } };
    }
    if (method === 'POST' && rest === '/git/refs') {
      const branch = String(body?.ref ?? '').replace(/^refs\/heads\//, '');
      if (repo.refs.has(branch)) return { status: 422, json: { message: 'Reference already exists' } };
      if (repo.objects.get(body?.sha)?.type !== 'commit') return { status: 422, json: { message: 'Object does not exist' } };
      repo.refs.set(branch, body.sha);
      return { status: 201, json: { ref: `refs/heads/${branch}`, object: { sha: body.sha, type: 'commit' } } };
    }
    if (method === 'PUT' && (r = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(r[1]);
      const branch = body?.branch ?? repo.defaultBranch;
      const parent = repo.refs.get(branch);
      if (!parent && !empty) return { status: 404, json: { message: `Branch ${branch} not found` } };
      const head = parent ? repo.objects.get(parent) : undefined;
      /** @type {Files} */
      const files = head?.type === 'commit' ? flatten(repo, head.tree) : new Map();
      if (files.has(path) && body?.sha !== files.get(path)?.sha) return { status: 422, json: { message: '"sha" wasn\'t supplied.' } };
      const sha = blob(repo, Buffer.from(String(body?.content ?? ''), 'base64'));
      files.set(path, { sha, mode: '100644' });
      const c = commitOf(repo, files, String(body?.message ?? ''), parent ? [parent] : []);
      repo.refs.set(branch, c);
      return { status: 201, json: { content: { name: path.split('/').pop(), path, sha }, commit: commitJson(c, repo.objects.get(c)) } };
    }
    if (method === 'GET' && rest === '/commits') {
      if (empty) return EMPTY;
      let sha = repo.refs.get(url.searchParams.get('sha') ?? repo.defaultBranch);
      if (!sha) return NOT_FOUND;
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const out = [];
      while (sha && out.length < per) {
        const j = commitJson(sha, repo.objects.get(sha));
        out.push({ sha, commit: { message: j.message, author: j.author, committer: j.committer, tree: j.tree }, parents: j.parents });
        sha = j.parents[0]?.sha;
      }
      return { status: 200, json: out };
    }
    return NOT_FOUND;
  }

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      /** @type {Answer} */
      let a;
      /** @type {any} */
      let body = null;
      try {
        const raw = Buffer.concat(chunks);
        body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        a = answer(method, url, req.headers, body);
      } catch (e) {
        a = body === null && chunks.length ? { status: 400, json: { message: 'Problems parsing JSON' } } : { status: 500, json: { message: String(/** @type {any} */ (e)?.message ?? e) } };
      }
      log.push({ method, path: url.pathname, status: a.status });
      const payload = a.raw ?? (a.json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(a.json)));
      res.writeHead(a.status, {
        'access-control-allow-origin': '*', 'access-control-expose-headers': EXPOSE_HEADERS,
        ...(a.raw ? { 'content-type': 'application/octet-stream' } : a.json === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
        'content-length': String(payload.length), ...(a.headers ?? {}),
      });
      res.end(method === 'HEAD' ? undefined : payload);
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
      const c = repo.objects.get(repo.refs.get(branch ?? repo.defaultBranch) ?? '');
      /** @type {Map<string, Buffer>} */
      const out = new Map();
      if (c?.type !== 'commit') return out;
      for (const [path, f] of flatten(repo, c.tree)) {
        const b = repo.objects.get(f.sha);
        if (b?.type === 'blob') out.set(path, b.data);
      }
      return out;
    },
    /** The commits on a branch, newest first, by first parents. @param {string} name @param {string} [branch] */
    commits(name, branch) {
      const repo = repoOf(name);
      /** @type {{ sha: string, message: string, parents: string[], tree: string }[]} */
      const out = [];
      let sha = repo.refs.get(branch ?? repo.defaultBranch);
      while (sha) {
        const c = repo.objects.get(sha);
        if (c?.type !== 'commit') break;
        out.push({ sha, message: c.message, parents: c.parents, tree: c.tree });
        sha = c.parents[0];
      }
      return out;
    },
    /** Another device commits these files, as the whole tree, on the default branch. @param {string} name @param {Record<string, string | Buffer>} files @param {string} message */
    commitAs(name, files, message) {
      const repo = repoOf(name);
      const parent = repo.refs.get(repo.defaultBranch);
      /** @type {Files} */
      const tree = new Map(Object.entries(files).map(([p, c]) => [p, { sha: blob(repo, Buffer.from(c)), mode: '100644' }]));
      const sha = commitOf(repo, tree, message, parent ? [parent] : []);
      repo.refs.set(repo.defaultBranch, sha);
      return sha;
    },
    /** After `after` more blob uploads, the next `times` are refused as over a secondary rate limit, asking to wait retryAfter seconds. */
    limitBlobs({ after = 0, retryAfter = 1, times = 1 } = {}) {
      limit = { after, retryAfter, times, seen: 0 };
    },
    /** Runs fn just before the next branch update is handled, as another device moving the branch then would. @param {() => void} fn */
    beforeRefUpdate(fn) {
      beforeRef = fn;
    },
    /** The next tree made holds one file more than it was sent: a stored tree that differs. */
    breakNextTree() {
      tamper = true;
    },
    /** @param {string} name @param {boolean} value */
    setPrivate(name, value) {
      repoOf(name).private = value;
    },
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    }),
  };
}
