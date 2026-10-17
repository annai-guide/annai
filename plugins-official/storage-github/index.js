import { blobId, treeId, GitPathError } from './git.js';

/**
 * GitHub as a place for annai's backups (spec §12.4), through its Git Data API, which accepts
 * browser calls. A backup is the archive's files as one commit on the repository's default branch,
 * and a file GitHub already has isn't sent again. The repository must be private and hold nothing
 * but annai's backups (a README and the like stay). The token is a fine-grained personal access
 * token with Contents: Read and write for that repository.
 * @typedef {{ base: string, repo: string, token: string, device: { id: string, label: string }, app: string,
 *   TargetError: any, zip: any, net: (url: string, init?: RequestInit) => Promise<Response>, seen: Set<string> }} G
 *   seen: blob ids GitHub confirmed in this session, so a later try sends nothing twice
 * @typedef {{ sha: string, size: number, mode: string }} RemoteFile
 */

const API = 'https://api.github.com';
/** GitHub holds files up to 100 MB. */
const MAX_FILE = 100 * 1024 * 1024;
/** Text files up to this size travel inside the tree request, many in one request. */
const INLINE_MAX = 256 * 1024;
/** At most this much text in one tree request; the rest goes as blobs. */
const INLINE_TOTAL = 4 * 1024 * 1024;
/** The longest wait GitHub may ask for that annai sits out; a longer one ends this backup for now. */
const MAX_WAIT = 5 * 60_000;
const MANIFEST = 'annai-archive.json';
/** The top-level files and folders of annai's backups. */
const OURS = new Set([MANIFEST, 'me', 'trips', 'system', 'blobs']);
/** What else a backup repository may hold at its top; kept as it is. */
const EXTRAS = /^(readme|license|licence|copying|notice)(\.[\w-]+)?$|^\.(gitignore|gitattributes|github)$/i;
const README = '# annai backups\n\nThis private repository holds backups made by annai (https://annai.guide). Each commit is a backup of everything on one device. To restore one, open annai, then Settings → Backups.\n';
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();
/** Blob ids GitHub confirmed in this session, by API address and repository. @type {Map<string, Set<string>>} */
const confirmed = new Map();

/** @param {any} annai */
export function activate(annai) {
  const { TargetError, zip } = annai.helpers;
  /** @param {any} c @returns {G} */
  const client = (c) => {
    const base = String(c.config.api || API).trim().replace(/\/+$/, '');
    const repo = String(c.config.repo ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const key = `${base} ${repo}`;
    const seen = confirmed.get(key) ?? new Set();
    confirmed.set(key, seen);
    return { base, repo, token: String(c.secret.token ?? '').trim(), device: c.device, app: c.app, TargetError, zip, net: annai.net.fetch, seen };
  };
  return annai.storage.register({
    type: 'github',
    name: 'GitHub',
    stores: 'tree',
    fields: [
      { key: 'repo', label: 'Repository', placeholder: 'you/annai-backup' },
      { key: 'api', label: 'GitHub API address', placeholder: API, advanced: true },
    ],
    secret: [{ key: 'token', label: 'Access token' }],
    help: "Make a new private repository on GitHub for annai's backups. Then make a fine-grained access token for that repository only, with Contents: Read and write, and paste it here. The token stays on this device; it is never in a backup.",
    helpUrl: 'https://github.com/settings/personal-access-tokens/new',
    helpLabel: 'Make a token on GitHub',
    where: (/** @type {any} */ config) => String(config.repo || 'GitHub'),
    check: (/** @type {any} */ c) => check(client(c)),
    list: (/** @type {any} */ c) => list(client(c)),
    put: (/** @type {any} */ c, /** @type {any} */ archive, /** @type {any} */ o) => put(client(c), archive, o),
    get: (/** @type {any} */ c, /** @type {string} */ id, /** @type {any} */ o) => get(client(c), id, o),
  });
}

/** @param {number} ms @param {AbortSignal} [signal] */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});
/** @param {string} path */
const top = (path) => path.split('/')[0];
/** A path as the user knows it: a trip's file without the trip's id. @param {string} path */
const shown = (path) => path.replace(/^trips\/[^/]+\//, '/');
/** @param {number} n */
const size = (n) => (n < 1_000_000 ? `${Math.max(1, Math.round(n / 1000))} KB` : `${Math.round(n / 1_000_000)} MB`);
/** @param {number} ms */
const minutes = (ms) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
};
/** @param {string} branch */
const refPath = (branch) => branch.split('/').map(encodeURIComponent).join('/');

/** @param {Uint8Array} bytes */
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The bytes as text, when they are UTF-8 that travels unchanged inside JSON; otherwise null. @param {Uint8Array} bytes */
function asText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * One request to the repository's API. A wait GitHub asks for is sat out (up to MAX_WAIT), then
 * the request goes again; a longer one ends the backup with TargetError "rate".
 * @param {G} g @param {string} method @param {string} path after /repos/<owner>/<name>
 * @param {{ body?: any, raw?: boolean, signal?: AbortSignal }} [o] @returns {Promise<Response>}
 */
async function call(g, method, path, { body, raw = false, signal } = {}) {
  for (let tries = 1; ; tries++) {
    const res = await g.net(`${g.base}/repos/${g.repo}${path}`, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${g.token}`,
        accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const wait = await rateWait(res);
    if (wait === null) return res;
    if (wait > MAX_WAIT || tries >= 6) {
      throw new g.TargetError('rate', `GitHub asked annai to slow down. The backup carries on by itself in about ${minutes(wait)}.`, { retryAt: Date.now() + wait });
    }
    await sleep(wait, signal);
  }
}

/** How long GitHub asks annai to wait, or null when this isn't a rate limit. @param {Response} res @returns {Promise<number | null>} */
async function rateWait(res) {
  if (res.status !== 403 && res.status !== 429) return null;
  const after = Number(res.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return after * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') return Math.max(1000, Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now());
  if (res.status === 429) return 60_000;
  return /rate limit/i.test(await res.clone().text().catch(() => '')) ? 60_000 : null;
}

/** A failed answer from GitHub in plain words. @param {G} g @param {Response} res */
async function failure(g, res) {
  let said = '';
  try {
    said = String((await res.json())?.message ?? '');
  } catch {
    // not JSON
  }
  const E = g.TargetError;
  if (res.status === 401) return new E('auth', "GitHub didn't accept the access token. Make a new one, paste it here, and save.");
  if (res.status === 403) return new E('refused', `The access token isn't allowed to do this in ${g.repo}. Give it Contents: Read and write for this repository.`);
  if (res.status === 404) return new E('missing', `annai can't find ${g.repo} on GitHub. Check the name, and that the token has access to it.`);
  if (res.status >= 500) return new E('other', `GitHub had a problem (HTTP ${res.status}). annai tries again later.`);
  return new E('other', `GitHub refused this (HTTP ${res.status}${said ? `: ${said}` : ''}). annai tries again later.`);
}

/** A request whose answer must have one of the ok statuses; its JSON. @param {G} g @param {string} method @param {string} path @param {any} [body] @param {number[]} [ok] */
async function json(g, method, path, body, ok = [200]) {
  const res = await call(g, method, path, { body });
  if (!ok.includes(res.status)) throw await failure(g, res);
  return res.json();
}

/** What can be told without asking GitHub. @param {G} g */
function ready(g) {
  const E = g.TargetError;
  if (!/^https:\/\/[^/]|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(g.base)) throw new E('setup', "GitHub's API address must start with https://.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(g.repo)) throw new E('setup', 'Write the repository as owner/name, for example you/annai-backup.');
  if (!g.token) throw new E('setup', 'Paste an access token for the repository, then save.');
}

/** The repository, refused unless it is private and the token may change it. @param {G} g */
async function repoInfo(g) {
  ready(g);
  const E = g.TargetError;
  const r = await json(g, 'GET', '');
  if (!r.private) {
    throw new E('refused', `${r.full_name} is public, so anyone could read your trips there. Make it private on GitHub (the repository's Settings, then Change visibility), or choose a private repository.`);
  }
  if (r.permissions?.push === false) throw new E('refused', `The access token can read ${r.full_name} but not change it. Give it Contents: Read and write.`);
  return r;
}

/** @param {G} g */
async function check(g) {
  const r = await repoInfo(g);
  return { note: `Works: annai can reach ${r.full_name}, a private repository.` };
}

/** The branch's last commit: its id, null when there is no such branch, or "empty" for a repository with no commits. @param {G} g @param {string} branch */
async function headOf(g, branch) {
  const res = await call(g, 'GET', `/git/ref/heads/${refPath(branch)}`);
  if (res.status === 404) return null;
  if (res.status === 409) return 'empty';
  if (!res.ok) throw await failure(g, res);
  return /** @type {string} */ ((await res.json()).object.sha);
}

/** A commit and its files, by path. @param {G} g @param {string} sha */
async function snapshot(g, sha) {
  const commit = await json(g, 'GET', `/git/commits/${sha}`);
  const tree = await json(g, 'GET', `/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new g.TargetError('refused', `${g.repo} holds more files than GitHub lists at once, so annai can't use it. Choose a new private repository.`);
  /** @type {Map<string, RemoteFile>} */
  const files = new Map();
  for (const e of tree.tree) if (e.type === 'blob') files.set(e.path, { sha: e.sha, size: e.size ?? 0, mode: e.mode });
  return { commit, files };
}

/** A commit as a backup annai lists. @param {{ sha: string, message: string, author?: { date?: string }, committer?: { date?: string } }} c */
function describe(c) {
  const device = /^Device: (\S+)$/m.exec(c.message)?.[1];
  const label = /^annai backup from (.+)$/m.exec(c.message)?.[1];
  return { id: c.sha, at: Date.parse(c.author?.date ?? c.committer?.date ?? '') || 0, ...(device ? { device } : {}), ...(label ? { label } : {}) };
}

/** @param {G} g */
const message = (g) => `annai backup from ${g.device.label}\n\nDevice: ${g.device.id}\nannai ${g.app}\n`;

/** An empty repository's first commit: GitHub's Git Data API needs one. @param {G} g @returns {Promise<string>} */
async function start(g) {
  const res = await call(g, 'PUT', '/contents/README.md', { body: { message: 'Start annai backups', content: base64(enc.encode(README)) } });
  if (res.status !== 201 && res.status !== 200) throw await failure(g, res);
  return (await res.json()).commit.sha;
}

/**
 * Backs up the archive as one commit: its files, plus the README and the like the repository holds.
 * @param {G} g @param {{ blob: Blob }} archive
 * @param {{ base?: string | null, maxUpload?: number, onProgress?: (p: any) => void, signal?: AbortSignal, maxFile?: number }} [o]
 */
async function put(g, archive, { base = null, maxUpload = Infinity, onProgress = () => {}, signal, maxFile = MAX_FILE } = {}) {
  const E = g.TargetError;
  const repo = await repoInfo(g);
  const branch = repo.default_branch;
  let parent = await headOf(g, branch);
  if (parent === 'empty') parent = await start(g);
  /** @type {Map<string, RemoteFile>} */
  let old = new Map();
  if (parent) {
    const snap = await snapshot(g, parent);
    old = snap.files;
    const remote = describe(snap.commit);
    if (old.has(MANIFEST) && parent !== base && remote.device !== g.device.id) throw new E('newer', `There is a newer backup in ${g.repo}.`, { remote });
    const foreign = [...new Set([...old.keys()].map(top))].filter((t) => !OURS.has(t) && !EXTRAS.test(t));
    if (foreign.length) {
      throw new E('refused', `${g.repo} holds other files (${foreign.slice(0, 3).join(', ')}), so annai won't back up into it. Make a new private repository for annai's backups.`);
    }
  }
  // The backup's files, by git's ids.
  const zipped = await g.zip.ZipReader.open(archive.blob);
  /** @type {string[]} */
  const names = zipped.names();
  /** @type {{ path: string, sha: string, size: number }[]} */
  const entries = [];
  for (const [i, path] of names.entries()) {
    const n = zipped.size(path);
    if (n > maxFile) throw new E('refused', `GitHub can't hold files over ${size(maxFile)}, and ${shown(path)} is ${size(n)}. Remove it from annai, or back up to another kind of place.`);
    entries.push({ path, sha: await blobId(await zipped.read(path)), size: n });
    onProgress({ phase: 'checking', done: i + 1, total: names.length });
  }
  const extras = [...old].filter(([path]) => EXTRAS.test(top(path))).map(([path, f]) => ({ path, sha: f.sha, mode: f.mode }));
  /** @type {string} */
  let want;
  try {
    want = await treeId([...entries, ...extras]);
  } catch (e) {
    if (e instanceof GitPathError) throw new E('refused', `${e.message} Rename it in annai, then back up again.`);
    throw e;
  }
  // What GitHub doesn't have yet, each content once.
  const have = new Set([...old.values()].map((f) => f.sha));
  /** @type {typeof entries} */
  const send = [];
  for (const e of entries) if (!have.has(e.sha) && !send.some((s) => s.sha === e.sha)) send.push(e);
  const bytes = send.reduce((n, e) => n + e.size, 0);
  if (bytes > maxUpload) throw new E('large', `This backup would upload ${size(bytes)}.`, { bytes });
  /** @type {Map<string, string>} content id → text sent inside the tree request */
  const inline = new Map();
  let room = INLINE_TOTAL;
  for (const [i, e] of send.entries()) {
    const content = await zipped.read(e.path);
    const text = e.size <= INLINE_MAX && e.size <= room && !g.seen.has(e.sha) ? asText(content) : null;
    if (text !== null) {
      inline.set(e.sha, text);
      room -= e.size;
    } else {
      await upload(g, e, content, signal);
    }
    onProgress({ phase: 'uploading', done: i + 1, total: send.length });
  }
  const tree = [
    ...entries.map((e) => (inline.has(e.sha)
      ? { path: e.path, mode: '100644', type: 'blob', content: inline.get(e.sha) }
      : { path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
    ...extras.map((e) => ({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha })),
  ];
  const made = await json(g, 'POST', '/git/trees', { tree }, [201]);
  if (made.sha !== want) throw new E('other', "GitHub stored this backup differently from what annai sent, so annai didn't keep it. annai tries again later.");
  for (const sha of inline.keys()) g.seen.add(sha);
  const commit = await json(g, 'POST', '/git/commits', { message: message(g), tree: made.sha, parents: parent ? [parent] : [] }, [201]);
  const moved = parent
    ? await call(g, 'PATCH', `/git/refs/heads/${refPath(branch)}`, { body: { sha: commit.sha, force: false } })
    : await call(g, 'POST', '/git/refs', { body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  if (moved.status === 422) {
    const [remote] = await list(g).catch(() => []);
    throw new E('newer', `Another device backed up to ${g.repo} at the same moment.`, { remote: remote ?? { id: '', at: Date.now() } });
  }
  if (!moved.ok) throw await failure(g, moved);
  return { id: commit.sha, at: Date.parse(commit.author?.date ?? '') || Date.now(), uploaded: bytes, files: send.length };
}

/** Sends one file as a blob, unless GitHub has it already (an unfinished try may have left it). @param {G} g @param {{ path: string, sha: string }} e @param {Uint8Array} bytes @param {AbortSignal} [signal] */
async function upload(g, e, bytes, signal) {
  if (g.seen.has(e.sha)) return;
  const there = await call(g, 'HEAD', `/git/blobs/${e.sha}`, { signal });
  if (there.status !== 200) {
    const res = await call(g, 'POST', '/git/blobs', { body: { content: base64(bytes), encoding: 'base64' }, signal });
    if (res.status !== 201) throw await failure(g, res);
    if ((await res.json()).sha !== e.sha) throw new g.TargetError('other', `GitHub stored ${shown(e.path)} differently from what annai sent. annai tries again later.`);
  }
  g.seen.add(e.sha);
}

/** The backups on the default branch, newest first. @param {G} g */
async function list(g) {
  const r = await repoInfo(g);
  const res = await call(g, 'GET', `/commits?sha=${encodeURIComponent(r.default_branch)}&per_page=30`);
  if (res.status === 409) return [];
  if (!res.ok) throw await failure(g, res);
  /** @type {any[]} */
  const commits = await res.json();
  return commits.filter((c) => /^annai backup\b/.test(c.commit?.message ?? ''))
    .map((c) => describe({ sha: c.sha, message: c.commit.message, author: c.commit.author, committer: c.commit.committer }));
}

/**
 * One backup, as an archive file annai opens on its import screen: the files the backup's
 * annai-archive.json names, read from that commit.
 * @param {G} g @param {string} id @param {{ onProgress?: (p: any) => void, signal?: AbortSignal }} [o]
 */
async function get(g, id, { onProgress = () => {}, signal } = {}) {
  ready(g);
  const E = g.TargetError;
  const { files } = await snapshot(g, id);
  const m = files.get(MANIFEST);
  if (!m) throw new E('missing', "That commit isn't an annai backup.");
  const manifestBytes = await blob(g, m.sha, signal);
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new E('other', 'This backup is damaged: its annai-archive.json is not readable.');
  }
  const named = [...(manifest?.files ?? []), ...(manifest?.blobs ?? []), ...(manifest?.extras ?? [])].map((x) => x?.name);
  const names = [...new Set(named.filter((n) => typeof n === 'string' && n !== MANIFEST))];
  const out = new g.zip.ZipWriter();
  for (const [i, name] of names.entries()) {
    const f = files.get(name);
    if (!f) throw new E('missing', `This backup is damaged: ${shown(name)} is missing from GitHub.`);
    await out.add(name, await blob(g, f.sha, signal), { compress: false });
    onProgress({ phase: 'downloading', done: i + 1, total: names.length });
  }
  await out.add(MANIFEST, manifestBytes, { compress: false });
  return out.finish();
}

/** @param {G} g @param {string} sha @param {AbortSignal} [signal] */
async function blob(g, sha, signal) {
  const res = await call(g, 'GET', `/git/blobs/${sha}`, { raw: true, signal });
  if (!res.ok) throw await failure(g, res);
  return new Uint8Array(await res.arrayBuffer());
}
