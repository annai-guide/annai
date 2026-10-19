// git.js is the GitHub place's file, copied unchanged (hence its header and the helpers unused here): a plugin can't
// import another's files, and a unit test keeps the two copies identical.
import { blobId, nest, GitPathError } from './git.js';

/**
 * Forgejo and Gitea (Codeberg runs Forgejo) as a place for annai's backups (spec §12.4), through
 * their API, which takes browser calls once the server allows annai's address (CORS). A backup is
 * the archive's files as one commit on a branch of a private repository that holds nothing but
 * annai's backups (a README and the like stay); only changed files are sent, with ChangeFiles. The
 * token needs Repository: Read and write; the user makes the repository, annai never does. An owner
 * or a repository left empty is found from the token when the place is tested (fill).
 *
 * A backup larger than one request goes as several commits: parts first ("Part of an annai backup"),
 * then the one with the new annai-archive.json, the only one that is a backup. A backup cut off half
 * way leaves its parts, which no one lists or restores, and the next try builds on them.
 *
 * Single writer: ChangeFiles commits on top of the branch as it is when the server gets it, and an
 * update or delete must name the id of the file it replaces. Every backup changes annai-archive.json,
 * so one another device made meanwhile always fails that check (Forgejo answers 409, Gitea 422).
 * The API facts relied on, with sources: docs/superpowers/plans/2026-10-18-storage-forgejo.md.
 * @typedef {{ server: string, host: string, owner: string, repo: string, branch: string }} Where
 * @typedef {Where & { base: string, token: string, device: { id: string, label: string }, app: string, TargetError: any, zip: any,
 *   read: (res: Response, how: string, where: string, o?: { max?: number }) => Promise<any>,
 *   net: (url: string, init?: RequestInit) => Promise<Response> }} F
 *   read: annai's reader of a server's answer: whatever is wrong with an answer is the server's doing (a TargetError), never a bug here
 * @typedef {{ sha: string, size: number }} RemoteFile
 * @typedef {{ sha: string, message: string, at: number }} Commit a commit, as a branch or the commit list tells of it
 * @typedef {{ operation: 'create' | 'update' | 'delete', path: string, sha?: string, size: number }} Op
 *   sha: the id of the file an update or delete replaces; size: what it sends
 */

/** Files over this size are refused, as on GitHub: each goes in a request of its own, in memory. */
const MAX_FILE = 100 * 1024 * 1024;
/** One request carries at most this much of the files, and this many of them: the server runs git for each. */
const PART = Object.freeze({ bytes: 8 * 1024 * 1024, files: 200 });
/** The most annai reads of an error's body. */
const ERROR_MAX = 64 * 1024;
/** The most annai reads of a backup's annai-archive.json: about 250 bytes a file, so some 30,000 files. */
const MANIFEST_MAX = 8 * 1024 * 1024;
/** Tree entries asked for a page; servers give at most their [api] DEFAULT_GIT_TREES_PER_PAGE (1000). */
const PER_PAGE = 1000;
/** The most tree pages annai reads: 100,000 files and folders. */
const MAX_PAGES = 100;
/**
 * Commits a page of the list holds (servers give at most [api] MAX_RESPONSE_ITEMS, 50), how many pages
 * annai looks through for backups (2,000 commits: past the parts of a very large backup cut off half
 * way), and how many backups it lists.
 */
const COMMITS_PAGE = 50;
const COMMIT_PAGES = 40;
const LISTED = 30;
/** Search pages annai reads for the private repositories a token can change (1,000 of them), and how many it offers. */
const SEARCH_PAGES = 20;
const CHOICES = 20;
const MANIFEST = 'annai-archive.json';
/** The top-level files and folders of annai's backups. */
const OURS = new Set([MANIFEST, 'me', 'trips', 'system', 'blobs']);
/** What else a backup repository may hold at its top; kept as it is. */
const EXTRAS = /^(readme|license|licence|copying|notice)(\.[\w-]+)?$|^\.(gitignore|gitattributes|forgejo|gitea)$/i;
/** A commit annai made that is a backup; the parts before one aren't. */
const BACKUP = /^annai backup\b/;
/** A commit of a backup's parts, sent before the commit that is the backup. */
const PARTIAL = /^Part of an annai backup\b/;
/** A git object's id, SHA-1 or SHA-256. */
const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What app.ini needs for annai at this origin. @param {string} origin */
export const corsLines = (origin) => `[cors]\nENABLED = true\nALLOW_DOMAIN = ${origin}`;

/**
 * The place, from what the user typed. A pasted …/api/v1, "owner/name" as the repository, and the
 * repository's own address as the server's (https://codeberg.org/you/annai-backup) are understood.
 * @param {Record<string, unknown>} config @returns {Where}
 */
function where(config) {
  let server = String(config.server ?? '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
  let owner = String(config.owner ?? '').trim();
  let repo = String(config.repo ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!owner && /^[^/]+\/[^/]+$/.test(repo)) [owner, repo] = repo.split('/');
  /** @type {string} */
  let host = '';
  try {
    const u = new URL(server);
    host = u.host;
    const parts = u.pathname.split('/').filter(Boolean);
    const [o, r] = parts.slice(-2);
    if (parts.length >= 2 && ((!owner && !repo) || (o === owner && r.replace(/\.git$/, '') === repo))) {
      [owner, repo] = [o, r.replace(/\.git$/, '')];
      server = `${u.origin}${parts.slice(0, -2).map((p) => `/${p}`).join('')}`;
    }
  } catch {
    // not an address yet
  }
  return { server, host: host || 'the server', owner, repo, branch: String(config.branch ?? '').trim() };
}

/** @param {any} annai */
export function activate(annai) {
  const { TargetError, zip, readAnswer } = annai.helpers;
  /** @param {any} c @returns {F} */
  const client = (c) => {
    const w = where(c.config);
    return { ...w, base: `${w.server}/api/v1`, token: String(c.secret.token ?? '').trim(), device: c.device, app: c.app, TargetError, zip, read: readAnswer, net: annai.net.fetch };
  };
  return annai.storage.register({
    type: 'forgejo',
    name: 'Forgejo / Gitea',
    stores: 'tree',
    fields: [
      { key: 'server', label: 'Server address', placeholder: 'https://git.example.com' },
      { key: 'owner', label: 'Owner', placeholder: 'Found from the token if empty' },
      { key: 'repo', label: 'Repository', placeholder: 'Found from the token if empty' },
      { key: 'branch', label: 'Branch', placeholder: "The repository's own", advanced: true },
    ],
    secret: [{ key: 'token', label: 'Access token' }],
    help: "First make a new private repository on the server for annai's backups: annai doesn't make one. Then make an access token for it (your Settings, then Applications) with Repository: Read and write, and paste it here. Leave Owner and Repository empty, and annai finds the private repository the token can change. The token stays on this device; it is never in a backup. On Codeberg, the server address is https://codeberg.org.",
    where: (/** @type {any} */ config) => {
      const w = where(config);
      return w.owner && w.repo ? `${w.host}/${w.owner}/${w.repo}` : w.host;
    },
    browserAccess: (/** @type {string} */ origin) => ({
      text: `The server must let web apps at ${origin} use its API. Add these lines to its app.ini, then restart it. Codeberg allows this already.`,
      code: corsLines(origin),
    }),
    check: (/** @type {any} */ c) => check(client(c)),
    list: (/** @type {any} */ c) => list(client(c)),
    put: (/** @type {any} */ c, /** @type {any} */ archive, /** @type {any} */ o) => put(client(c), archive, o),
    get: (/** @type {any} */ c, /** @type {string} */ id, /** @type {any} */ o) => get(client(c), id, o),
  });
}

/** @param {string} path */
const top = (path) => path.split('/')[0];
/** The folders a path is in: "a/b/c" is in "a" and "a/b". @param {string} path */
const folders = (path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
/** A path as the user knows it: a trip's file without the trip's id. @param {string} path */
const shown = (path) => path.replace(/^trips\/[^/]+\//, '/');
/** @param {number} n */
const size = (n) => (n < 1_000_000 ? `${Math.max(1, Math.round(n / 1000))} KB` : `${Math.round(n / 1_000_000)} MB`);
/** @param {number} ms */
const minutes = (ms) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
};
/** @param {F} g */
const named = (g) => `${g.owner}/${g.repo}`;
/** An answer annai can't use: the server's doing, never a bug here (spec §5.5). @param {F} g */
const unreadable = (g) => new g.TargetError('other', `${g.host} answered something annai can't read. annai tries again later.`);
/** No answer at all: offline, or a server that doesn't let web apps use its API (no CORS), which a page can't tell apart. @param {F} g */
const unreachable = (g) => Object.assign(new g.TargetError('other',
  `annai couldn't reach ${g.host}. If this device is online, the server may not let web apps use its API yet: see Browser access on this place's screen. annai tries again later.`), { noAnswer: true });
/** A git object id from an answer, or unreadable. @param {F} g @param {unknown} v @returns {string} */
const shaOf = (g, v) => {
  if (typeof v === 'string' && HEX.test(v)) return v;
  throw unreadable(g);
};
/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {string} path */
const pathPart = (path) => path.split('/').map(encodeURIComponent).join('/');

/** @param {Uint8Array} bytes */
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The id a SHA-256 repository gives some content. @param {Uint8Array} bytes */
async function sha256Id(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const all = new Uint8Array(head.byteLength + bytes.byteLength);
  all.set(head);
  all.set(bytes, head.byteLength);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', all)), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Whether text is a web address annai may use: https, or http on this computer (for testing). @param {string} u */
function webAddress(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

/** What can be told without asking the server. empty: an owner or repository may be empty, to be found (fill). @param {F} g */
function ready(g, empty = false) {
  const E = g.TargetError;
  const named = (/** @type {string} */ v) => /^[\w.-]+$/.test(v) || (empty && !v);
  if (!webAddress(g.server)) throw new E('setup', "Check the server's address: it must be a web address that starts with https://.");
  if (!g.owner || !g.repo) {
    if (!empty) throw new E('setup', "Tap Save and test: annai finds the owner and the repository from the token. Or type them, for example you and annai-backup.");
  }
  if (!named(g.owner) || !named(g.repo)) throw new E('setup', "Type the owner and the repository's name, for example you and annai-backup.");
  if (g.branch && !/^(?!\/|.*(?:\/\/|\.\.|\/$|\.lock$))[\w./-]+$/.test(g.branch)) throw new E('setup', "Check the branch's name, or leave it empty for the repository's own.");
  if (!g.token) throw new E('setup', 'Paste an access token for the repository, then save.');
  if (!/^[\x21-\x7e]+$/.test(g.token)) throw new E('setup', 'The access token has letters no token has. Paste it again, then save.');
}

/**
 * One request to the server's API, with only the headers servers let web apps send:
 * Authorization, and Content-Type for a body. No answer at all is unreachable.
 * @param {F} g @param {string} method @param {string} path after /api/v1
 * @param {{ body?: any, signal?: AbortSignal }} [o] @returns {Promise<Response>}
 */
async function request(g, method, path, { body, signal } = {}) {
  try {
    return await g.net(`${g.base}${path}`, {
      method,
      signal,
      headers: { authorization: `token ${g.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
    throw unreachable(g);
  }
}

/** A request to the repository. @param {F} g @param {string} method @param {string} path after /repos/<owner>/<name> @param {{ body?: any, signal?: AbortSignal }} [o] */
const call = (g, method, path, o) => request(g, method, `/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}${path}`, o);

/** Whether a 413 is Forgejo's quota rather than a limit on a request's size. @param {F} g @param {Response} res */
async function overQuota(g, res) {
  return res.status === 413 && /quota/i.test(await g.read(res.clone(), 'text', g.host, { max: ERROR_MAX }).catch(() => ''));
}

/** A failed answer in plain words. @param {F} g @param {Response} res */
async function failure(g, res) {
  const E = g.TargetError;
  const quota = await overQuota(g, res);
  let said = '';
  try {
    said = String((await g.read(res, 'json', g.host, { max: ERROR_MAX }))?.message ?? '').slice(0, 200);
  } catch {
    // not JSON
  }
  const with_ = said ? `: ${said}` : '';
  if (res.status === 401) return new E('auth', `${g.host} didn't accept the access token. Make a new one, paste it here, and save.`);
  if (res.status === 403) return new E('refused', `The access token isn't allowed to change ${named(g)} on ${g.host}. Make one with Repository: Read and write, and check that the branch isn't protected.`);
  if (res.status === 404) return new E('missing', `There is no repository ${named(g)} on ${g.host} that this token can see. Create a private repository named ${g.repo} there first (annai doesn't make one), or check the owner and the name.`);
  if (quota) return new E('refused', `Your account on ${g.host} is out of space: its quota is used up. Free some there, or ask whoever runs the server for more, then back up again.`);
  if (res.status === 423) return new E('refused', `${named(g)} on ${g.host} is archived, so nothing can be added to it. Unarchive it in the repository's settings, or choose another.`);
  if (res.status === 429 || res.status === 503) {
    const after = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 5 * 60_000;
    return new E('rate', `${g.host} is busy. annai tries again in about ${minutes(wait)}.`, { retryAt: Date.now() + wait });
  }
  if (res.status >= 500) return new E('other', `${g.host} had a problem (HTTP ${res.status}${with_}). annai tries again later.`);
  return new E('other', `${g.host} refused this (HTTP ${res.status}${with_}). annai tries again later.`);
}

/** A request whose answer must be 200; its JSON. @param {F} g @param {string} path */
async function getJson(g, path) {
  const res = await call(g, 'GET', path);
  if (res.status !== 200) throw await failure(g, res);
  return g.read(res, 'json', g.host);
}

/** The repository, refused unless it is private and the token may change it. @param {F} g */
async function repoInfo(g) {
  ready(g);
  const E = g.TargetError;
  const r = await getJson(g, '');
  if (!isObject(r) || typeof r.full_name !== 'string' || typeof r.default_branch !== 'string') throw unreadable(g);
  if (r.private !== true) {
    throw new E('refused', `${r.full_name} on ${g.host} is public, so anyone could read your trips there. Make it private (the repository's settings), or choose a private repository.`);
  }
  if (r.archived === true) throw new E('refused', `${r.full_name} on ${g.host} is archived, so nothing can be added to it. Unarchive it in the repository's settings, or choose another.`);
  if (r.permissions?.push === false) throw new E('refused', `The access token can read ${r.full_name} but not change it. Make one with Repository: Read and write.`);
  return r;
}

/** The branch annai backs up to. @param {F} g @param {any} repo */
const branchOf = (g, repo) => g.branch || String(repo.default_branch);

/** @param {F} g @param {any} repo @param {string} branch */
const noBranch = (g, repo, branch) => new g.TargetError('setup',
  `${repo.full_name} has no branch ${branch}. Leave Branch empty to use ${repo.default_branch}, or make the branch on ${g.host} first.`);

/** @param {string} a @param {string} b */
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * An owner or a repository left empty, found from the token (the user's ask, 2026-10-18): among the
 * private repositories it can change, which the repository search lists for a token with only
 * Repository: Read and write. Whose the token is (GET /user) needs User: Read as well, refused (403)
 * without it on both servers; with it, the token's own account comes first. Public, archived and
 * mirror repositories are never offered. The facts: docs/superpowers/plans/2026-10-18-storage-forgejo.md.
 * @param {F} g @returns {Promise<{ owner: string, repo: string, of: string } | null>} what fills them in, or null when
 *   neither is empty; of: the owner it was the only one of, when there was one
 */
async function fill(g) {
  ready(g, true);
  if (g.owner && g.repo) return null;
  const E = g.TargetError;
  let login = '';
  if (!g.owner) {
    const res = await request(g, 'GET', '/user');
    if (res.status === 401) throw await failure(g, res);
    if (res.ok) login = String((await g.read(res, 'json', g.host))?.login ?? '');
  }
  /** @type {{ owner: string, repo: string }[]} */
  const found = [];
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    const res = await request(g, 'GET', `/repos/search?is_private=true&archived=false&limit=${COMMITS_PAGE}&page=${page}${g.repo ? `&q=${encodeURIComponent(g.repo)}` : ''}`);
    if (res.status === 403) throw new E('refused', `The access token can't list repositories on ${g.host}. Make one with Repository: Read and write, and paste it here.`);
    if (!res.ok) throw await failure(g, res);
    const data = (await g.read(res, 'json', g.host))?.data;
    if (!Array.isArray(data)) throw unreadable(g);
    for (const r of data) {
      const owner = r?.owner?.login;
      if (typeof owner !== 'string' || typeof r.name !== 'string' || r.private !== true || r.archived === true || r.mirror === true || r.permissions?.push !== true) continue;
      if ((!g.owner || same(owner, g.owner)) && (!g.repo || same(r.name, g.repo))) found.push({ owner, repo: r.name });
    }
    if (data.length < COMMITS_PAGE) break;
  }
  const own = found.filter((r) => login && same(r.owner, login));
  const pool = (own.length ? own : found).sort((a, b) => (`${a.owner}/${a.repo}` < `${b.owner}/${b.repo}` ? -1 : 1));
  if (pool.length === 1) return { ...pool[0], of: own.length ? login : g.owner };
  if (pool.length) {
    throw new E('setup', `This token can change ${pool.length} private repositories on ${g.host}. Choose the one for annai's backups, or type its owner and name.`,
      { choices: pool.slice(0, CHOICES).map((r) => ({ label: `${r.owner}/${r.repo}`, config: { owner: r.owner, repo: r.repo } })) });
  }
  if (g.repo) throw new E('missing', `There is no private repository named ${g.repo} on ${g.host} that this token can change. Create it there first (annai doesn't make one), or check the name.`);
  throw new E('missing', `This token can't change any private repository${g.owner ? ` of ${g.owner}` : ''} on ${g.host}. Create a private repository there first, named annai-backup for example (annai doesn't make one), then Save and test again.`);
}

/** Tests the place; what was found for an owner or repository left empty comes back as config, which annai keeps. @param {F} g */
async function check(g) {
  const filled = await fill(g);
  const w = filled ? { ...g, owner: filled.owner, repo: filled.repo } : g;
  const r = await repoInfo(w);
  const branch = branchOf(w, r);
  if (!r.empty && !(await headOf(w, branch))) throw noBranch(w, r, branch);
  const note = `Works: annai can reach ${r.full_name} on ${g.host}, a private repository.`;
  if (!filled) return { note };
  const how = g.repo ? ` annai filled in its owner, ${filled.owner}.` : ` It is the only private repository${filled.of ? ` of ${filled.of}` : ''} this token can change, so annai filled it in.`;
  return { note: note + how, config: { owner: filled.owner, repo: filled.repo } };
}

/** The branch's last commit, or null when there is no such branch. @param {F} g @param {string} branch @returns {Promise<Commit | null>} */
async function headOf(g, branch) {
  const res = await call(g, 'GET', `/branches/${pathPart(branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(g, res);
  const c = (await g.read(res, 'json', g.host))?.commit;
  return { sha: shaOf(g, c?.id), message: String(c?.message ?? ''), at: Date.parse(String(c?.timestamp ?? '')) || 0 };
}

/**
 * A commit's files, by path, page by page; null when it isn't a commit there. Forgejo says
 * truncated on every page once there are several, the last too, so the count decides.
 * @param {F} g @param {string} sha @param {AbortSignal} [signal] @returns {Promise<Map<string, RemoteFile> | null>}
 */
async function snapshot(g, sha, signal) {
  /** @type {Map<string, RemoteFile>} */
  const files = new Map();
  let seen = 0;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new g.TargetError('refused', `${named(g)} holds more files than annai reads, so annai can't use it. Choose a new private repository.`);
    const res = await call(g, 'GET', `/git/trees/${sha}?recursive=true&per_page=${PER_PAGE}&page=${page}`, { signal });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw await failure(g, res);
    const t = await g.read(res, 'json', g.host);
    if (!isObject(t) || !(t.tree === null || Array.isArray(t.tree))) throw unreadable(g);
    /** @type {unknown[]} */
    const entries = t.tree ?? [];
    seen += entries.length;
    for (const e of entries) {
      if (isObject(e) && e.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string') files.set(e.path, { sha: e.sha, size: Number(e.size) || 0 });
    }
    if (!entries.length || !t.truncated || seen >= Number(t.total_count)) return files;
  }
}

/** A commit as a backup annai lists. @param {Commit} c */
function describe(c) {
  const device = /^Device: (\S+)$/m.exec(c.message)?.[1];
  const label = /^(?:Part of an )?annai backup from (.+)$/m.exec(c.message)?.[1];
  return { id: c.sha, at: c.at, ...(device ? { device } : {}), ...(label ? { label } : {}) };
}

/** The backups on a branch, newest first: up to want of them, among its last few hundred commits. @param {F} g @param {string} branch @param {number} want */
async function backupsOn(g, branch, want) {
  /** @type {ReturnType<typeof describe>[]} */
  const out = [];
  for (let page = 1; page <= COMMIT_PAGES && out.length < want; page++) {
    const res = await call(g, 'GET', `/commits?sha=${encodeURIComponent(branch)}&limit=${COMMITS_PAGE}&page=${page}&stat=false&verification=false&files=false`);
    if (res.status === 409 || res.status === 404) return out; // an empty repository, or no such branch
    if (!res.ok) throw await failure(g, res);
    const commits = await g.read(res, 'json', g.host);
    if (!Array.isArray(commits)) throw unreadable(g);
    for (const c of commits) {
      const message = String(c?.commit?.message ?? '');
      if (isObject(c) && typeof c.sha === 'string' && HEX.test(c.sha) && BACKUP.test(message)) {
        out.push(describe({ sha: c.sha, message, at: Date.parse(String(c.commit?.author?.date ?? c.created ?? '')) || 0 }));
      }
    }
    if (commits.length < COMMITS_PAGE) break;
  }
  return out.slice(0, want);
}

/**
 * The newest backup at a branch whose head is this commit: the head itself, or the newest backup
 * before it, past parts and commits made by hand. A commit made by hand with no backup before it
 * counts as itself; parts with none before them are no backup, so null.
 * @param {F} g @param {string} branch @param {Commit} head
 */
async function newest(g, branch, head) {
  if (BACKUP.test(head.message)) return describe(head);
  return (await backupsOn(g, branch, 1))[0] ?? (PARTIAL.test(head.message) ? null : describe(head));
}

/** The backups on the branch, newest first. @param {F} g */
async function list(g) {
  const r = await repoInfo(g);
  return r.empty ? [] : backupsOn(g, branchOf(g, r), LISTED);
}

/** @param {F} g @param {boolean} last */
const message = (g, last) => `${last ? 'annai backup' : 'Part of an annai backup'} from ${g.device.label}\n\nDevice: ${g.device.id}\nannai ${g.app}\n`;

/**
 * The changes in requests: first the files in the way of new folders (or new files, of folders),
 * each request at most part's bytes and files, the new manifest last.
 * @param {Op[]} first @param {Op[]} changes @param {Op} manifest @param {{ bytes: number, files: number }} part @returns {Op[][]}
 */
function pack(first, changes, manifest, part) {
  /** @type {Op[][]} */
  const out = [];
  for (let i = 0; i < first.length; i += part.files) out.push(first.slice(i, i + part.files));
  /** @type {Op[]} */
  let now = [];
  let bytes = 0;
  for (const o of [...changes, manifest]) {
    if (now.length && (now.length >= part.files || bytes + o.size > part.bytes)) {
      out.push(now);
      now = [];
      bytes = 0;
    }
    now.push(o);
    bytes += o.size;
  }
  out.push(now);
  return out;
}

/**
 * Backs up the archive: its files on the branch, plus the README and the like the repository
 * holds, as one commit, or as parts and then the commit that is the backup.
 * @param {F} g @param {{ blob: Blob }} archive
 * @param {{ base?: string | null, maxUpload?: number, onProgress?: (p: any) => void, signal?: AbortSignal, maxFile?: number, part?: { bytes: number, files: number } }} [o]
 *   maxFile and part: smaller, for tests
 */
async function put(g, archive, { base = null, maxUpload = Infinity, onProgress = () => {}, signal, maxFile = MAX_FILE, part = PART } = {}) {
  const E = g.TargetError;
  const repo = await repoInfo(g);
  const branch = branchOf(g, repo);
  const head = repo.empty ? null : await headOf(g, branch);
  if (!repo.empty && !head) throw noBranch(g, repo, branch);
  /** @type {Map<string, RemoteFile>} */
  let old = new Map();
  if (head) {
    const snap = await snapshot(g, head.sha, signal);
    if (!snap) throw unreadable(g);
    old = snap;
    const remote = await newest(g, branch, head);
    if (remote && old.has(MANIFEST) && remote.id !== base && remote.device !== g.device.id) throw new E('newer', `There is a newer backup in ${repo.full_name}.`, { remote });
    const foreign = [...new Set([...old.keys()].map(top))].filter((t) => !OURS.has(t) && !EXTRAS.test(t));
    if (foreign.length) {
      throw new E('refused', `${repo.full_name} holds other files (${foreign.slice(0, 3).join(', ')}), so annai won't back up into it. Make a new private repository for annai's backups.`);
    }
  }
  // The backup's files, by the repository's own ids.
  const idOf = repo.object_format_name === 'sha256' ? sha256Id : blobId;
  const zipped = await g.zip.ZipReader.open(archive.blob);
  /** @type {string[]} */
  const names = zipped.names();
  /** @type {{ path: string, sha: string, size: number }[]} */
  const entries = [];
  for (const [i, path] of names.entries()) {
    const n = zipped.size(path);
    if (n > maxFile) throw new E('refused', `annai sends files of up to ${size(maxFile)} to this kind of place, and ${shown(path)} is ${size(n)}. Remove it from annai, or back up to another kind of place.`);
    entries.push({ path, sha: await idOf(await zipped.read(path)), size: n });
    onProgress({ phase: 'checking', done: i + 1, total: names.length });
  }
  const extras = [...old].filter(([path]) => EXTRAS.test(top(path)));
  try {
    nest([...entries, ...extras.map(([path, f]) => ({ path, sha: f.sha }))]);
  } catch (e) {
    if (e instanceof GitPathError) throw new E('refused', `${e.message} Rename it in annai, then back up again.`);
    throw e;
  }
  // What changed: files to create or update, each naming the one it replaces, and files to delete.
  const wanted = new Set(entries.map((e) => e.path));
  /** @type {Op[]} */
  const changes = [];
  /** @type {Op | null} */
  let manifest = null;
  for (const e of entries) {
    const had = old.get(e.path);
    if (had?.sha === e.sha && e.path !== MANIFEST) continue;
    const op = /** @type {Op} */ (had ? { operation: 'update', path: e.path, sha: had.sha, size: e.size } : { operation: 'create', path: e.path, size: e.size });
    if (e.path === MANIFEST) manifest = op;
    else changes.push(op);
  }
  if (!manifest) throw new E('other', "This backup has no annai-archive.json, so annai didn't send it. annai tries again later.");
  /** @type {Op[]} */
  const gone = [...old].filter(([path]) => !wanted.has(path) && !EXTRAS.test(top(path))).map(([path, f]) => ({ operation: 'delete', path, sha: f.sha, size: 0 }));
  // The server checks each change against the branch as it was, so a file where a new folder goes
  // (or a folder where a new file goes) is deleted in a commit before.
  const inFolders = new Set(entries.flatMap((e) => folders(e.path)));
  const first = gone.filter((d) => inFolders.has(d.path) || folders(d.path).some((f) => wanted.has(f)));
  const bytes = [...changes, manifest].reduce((n, op) => n + op.size, 0);
  if (bytes > maxUpload) throw new E('large', `This backup would upload ${size(bytes)}.`, { bytes });

  const total = changes.length + 1;
  let done = 0;
  /** The commit annai's last request made, or the head it started from. */
  let expected = head?.sha ?? null;
  /**
   * Sends ops as one commit (the backup when last), in halves when the request is too large for
   * the server or a proxy in front of it, or never gets an answer while the server still answers.
   * @param {Op[]} ops @param {boolean} last @returns {Promise<{ sha: string, at: number }>}
   */
  const send = async (ops, last) => {
    /** @type {any[]} */
    const files = [];
    for (const op of ops) {
      files.push({ operation: op.operation, path: op.path, ...(op.sha ? { sha: op.sha } : {}), ...(op.operation === 'delete' ? {} : { content: base64(await zipped.read(op.path)) }) });
    }
    /** @type {Response | null} */
    let res = null;
    try {
      res = await call(g, 'POST', '/contents', { body: { branch, message: message(g, last), files }, signal });
    } catch (e) {
      if (!(/** @type {any} */ (e)?.noAnswer)) throw e;
    }
    if (res?.status === 201) {
      // The answer repeats the files sent, in base64.
      const sent = ops.reduce((n, op) => n + op.size, 0);
      const made = await g.read(res, 'json', g.host, { max: Math.ceil((sent * 4) / 3) + 1024 * 1024 });
      const c = isObject(made) ? made.commit : null;
      expected = shaOf(g, c?.sha);
      done += ops.filter((op) => op.operation !== 'delete').length;
      onProgress({ phase: 'uploading', done, total });
      return { sha: expected, at: Date.parse(String(c?.author?.date ?? c?.committer?.date ?? '')) || Date.now() };
    }
    if (res === null || (res.status === 413 && !(await overQuota(g, res)))) {
      if (ops.length > 1) {
        const half = Math.ceil(ops.length / 2);
        await send(ops.slice(0, half), false);
        return send(ops.slice(half), last);
      }
      const [op] = ops;
      // One file alone: when the server still answers, it is this file's size that is refused.
      if (op.operation === 'delete' || (res === null && !(await answers(g, branch)))) throw unreachable(g);
      throw new E('refused', `${g.host} didn't take ${shown(op.path)} (${size(op.size)}): it, or a proxy in front of it, takes no uploads this large. Raise its limit (for nginx, client_max_body_size), then back up again.`);
    }
    // Any refusal may be the branch moving meanwhile, whatever its status says: a file's id that no longer
    // matches (409, 422 on Gitea), a file already there (422) or gone (500, 404 on Gitea), or a push refused
    // because the branch moved after the checks (403 on both). If it moved, that is another backup.
    const now = await headOf(g, branch).catch(() => null);
    if (now && now.sha !== expected) {
      const remote = await newest(g, branch, now).catch(() => null);
      if (remote && remote.device !== g.device.id && remote.id !== base) throw new E('newer', `Another device backed up to ${repo.full_name} at the same moment.`, { remote });
      throw new E('other', `${repo.full_name} changed while annai backed up. annai tries again later.`);
    }
    throw await failure(g, res);
  };
  const parts = pack(first, changes.concat(gone.filter((d) => !first.includes(d))), manifest, part);
  /** @type {{ sha: string, at: number }} */
  let made = { sha: '', at: 0 };
  for (const [i, ops] of parts.entries()) made = await send(ops, i === parts.length - 1);
  return { id: made.sha, at: made.at, uploaded: bytes, files: total };
}

/** Whether the server answers at all. @param {F} g @param {string} branch */
async function answers(g, branch) {
  try {
    await call(g, 'GET', `/branches/${pathPart(branch)}`);
    return true;
  } catch (e) {
    if (/** @type {any} */ (e)?.noAnswer) return false;
    throw e;
  }
}

/**
 * One backup, as an archive file annai opens on its import screen: the files the backup's
 * annai-archive.json names, read from that commit.
 * @param {F} g @param {string} id @param {{ onProgress?: (p: any) => void, signal?: AbortSignal }} [o]
 */
async function get(g, id, { onProgress = () => {}, signal } = {}) {
  ready(g);
  const E = g.TargetError;
  const commit = HEX.test(id) ? await call(g, 'GET', `/git/commits/${id}?stat=false&verification=false&files=false`, { signal }) : null;
  if (!commit || [400, 404, 422].includes(commit.status)) throw new E('missing', `That backup isn't in ${named(g)} on ${g.host}.`);
  if (!commit.ok) throw await failure(g, commit);
  const c = await g.read(commit, 'json', g.host);
  if (!isObject(c)) throw unreadable(g);
  if (PARTIAL.test(String(c.commit?.message ?? ''))) {
    throw new E('missing', "That commit is only part of a backup that was cut off half way, so it can't be opened. Open a whole backup instead.");
  }
  const files = await snapshot(g, id, signal);
  if (!files) throw new E('missing', `That backup isn't in ${named(g)} on ${g.host}.`);
  if (!files.has(MANIFEST)) throw new E('missing', "That commit isn't an annai backup.");
  const manifestBytes = await raw(g, MANIFEST, id, signal, MANIFEST_MAX);
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new E('other', 'This backup is damaged: its annai-archive.json is not readable.');
  }
  const lists = [manifest?.files, manifest?.blobs, manifest?.extras].map((l) => (Array.isArray(l) ? l : []));
  const names = [...new Set(lists.flat().map((x) => x?.name).filter((n) => typeof n === 'string' && n !== MANIFEST))];
  const out = new g.zip.ZipWriter();
  for (const [i, name] of names.entries()) {
    if (!files.has(name)) throw new E('missing', `This backup is damaged: ${shown(name)} is missing from ${named(g)}.`);
    await out.add(name, await raw(g, name, id, signal), { compress: false });
    onProgress({ phase: 'downloading', done: i + 1, total: names.length });
  }
  await out.add(MANIFEST, manifestBytes, { compress: false });
  return out.finish();
}

/**
 * One file's bytes at a commit, at most max of them. The media address gives a file stored with
 * Git LFS as itself, and git/blobs leaves out files over 10 MiB, so annai reads files there.
 * @param {F} g @param {string} path @param {string} ref @param {AbortSignal} [signal] @param {number} [max]
 */
async function raw(g, path, ref, signal, max = MAX_FILE) {
  const res = await call(g, 'GET', `/media/${pathPart(path)}?ref=${ref}`, { signal });
  if (res.status === 404) throw new g.TargetError('missing', `This backup is damaged: ${shown(path)} is missing from ${named(g)}.`);
  if (!res.ok) throw await failure(g, res);
  return /** @type {Uint8Array} */ (await g.read(res, 'bytes', g.host, { max }));
}
