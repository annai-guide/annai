/**
 * WebDAV as a place for annai's backups (spec §12.4): a folder on a server that speaks WebDAV and
 * allows browser access (CORS). Each backup is one archive file in the folder.
 * @typedef {{ url: string, user: string, password: string, TargetError: any,
 *   xml: { elements: (x: string, n: string) => string[], text: (x: string, n: string) => string | null },
 *   backupFiles: { parse: (name: string) => any }, read: (res: Response, how: string, where: string) => Promise<any>,
 *   net: (url: string, init?: RequestInit) => Promise<Response>, l10n: any }} W
 *   read: annai's reader of a server's answer: whatever is wrong with an answer is the server's doing, never a bug here; l10n: annai.l10n
 */

const enc = new TextEncoder();
const PROPS = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

/** The headers a server must send for annai at this origin, as Apache (mod_headers) writes them. @param {string} origin */
export function headerLines(origin) {
  return [
    `Header always set Access-Control-Allow-Origin "${origin}"`,
    'Header always set Access-Control-Allow-Methods "GET, PUT, DELETE, PROPFIND, MKCOL, OPTIONS"',
    'Header always set Access-Control-Allow-Headers "Authorization, Content-Type, Depth"',
    'Header always set Access-Control-Max-Age "3600"',
  ].join('\n');
}

/** A folder's address, ending in "/". @param {unknown} u */
const folderOf = (u) => {
  const s = String(u ?? '').trim();
  return s && !s.endsWith('/') ? `${s}/` : s;
};

/** @param {string} url */
const shownOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${decodeURIComponent(u.pathname)}`;
  } catch {
    return 'WebDAV';
  }
};

/**
 * A refusal of kind: its English for the log and a hold, and the screens' words beside it (annai's shown rule; annai.l10n.both).
 * @param {{ TargetError: any }} c @param {string} kind @param {{ message: string, shown: string }} w @param {object} [extra]
 */
const refuse = (c, kind, w, extra = {}) => new c.TargetError(kind, w.message, { ...extra, shown: w.shown });

/** @param {any} annai */
export function activate(annai) {
  const { TargetError, xml, backupFiles, readAnswer } = annai.helpers;
  /** @param {any} c @returns {W} */
  const client = (c) => ({ url: folderOf(c.config.url), user: String(c.config.user ?? '').trim(), password: String(c.secret.password ?? ''), TargetError, xml, backupFiles, read: readAnswer, net: annai.net.fetch, l10n: annai.l10n });
  const { t } = annai.l10n;
  return annai.storage.register({
    type: 'webdav',
    name: 'WebDAV',
    stores: 'file',
    fields: [
      { key: 'url', label: t`Folder address`, placeholder: 'https://dav.example.com/annai/' },
      { key: 'user', label: t`User name` },
    ],
    secret: [{ key: 'password', label: t`Password` }],
    help: t`Use a folder of its own for annai's backups; annai makes it if it isn't there. Where the server offers app passwords, use one rather than your own. The server must allow browser access: see below.`,
    where: (/** @type {any} */ config) => shownOf(folderOf(config.url)),
    browserAccess: (/** @type {string} */ origin) => ({
      text: t`The server must answer requests from ${origin} with these headers, and answer OPTIONS requests without asking for a password. For Apache with mod_headers, in the folder's configuration:`,
      code: headerLines(origin),
    }),
    check: (/** @type {any} */ c) => check(client(c)),
    list: (/** @type {any} */ c) => list(client(c)),
    put: (/** @type {any} */ c, /** @type {any} */ a, /** @type {any} */ o) => put(client(c), a, o),
    get: (/** @type {any} */ c, /** @type {string} */ id, /** @type {any} */ o) => get(client(c), id, o),
    delete: (/** @type {any} */ c, /** @type {string} */ id) => remove(client(c), id),
  });
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

/** What can be told without asking the server. @param {W} w */
function ready(w) {
  const { both } = w.l10n;
  if (!webAddress(w.url)) throw refuse(w, 'setup', both`Check the folder's address: it must be a web address that starts with https://.`);
  if (!w.user || !w.password) throw refuse(w, 'setup', both`Type the user name and the password, then save.`);
}

/** @param {Uint8Array} bytes */
function base64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** One request to the folder (name: a file in it, or "" for the folder). @param {W} w @param {string} method @param {string} name @param {{ body?: BodyInit, headers?: Record<string, string>, signal?: AbortSignal }} [o] */
function call(w, method, name, { body, headers = {}, signal } = {}) {
  return w.net(w.url + (name ? encodeURIComponent(name) : ''), {
    method, signal,
    headers: { authorization: `Basic ${base64(enc.encode(`${w.user}:${w.password}`))}`, ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

/** @param {W} w @param {string} depth @param {AbortSignal} [signal] */
const propfind = (w, depth, signal) => call(w, 'PROPFIND', '', { body: PROPS, headers: { depth, 'content-type': 'application/xml; charset=utf-8' }, signal });

/** A refusal from the server in plain words. @param {W} w @param {Response} res */
function failure(w, res) {
  const { both } = w.l10n;
  const host = new URL(w.url).host;
  if (res.status === 401) return refuse(w, 'auth', both`${host} didn't accept the user name and password. Check them, then save.`);
  if (res.status === 403) return refuse(w, 'refused', both`${host} doesn't let this user change the folder. Use a folder the user may write to.`);
  if (res.status === 404) return refuse(w, 'missing', both`That backup is no longer in the folder.`);
  if (res.status === 507) return refuse(w, 'refused', both`${host} is out of space. Free some there, or keep fewer backups.`);
  if (res.status === 429 || res.status === 503) return refuse(w, 'rate', both`${host} is busy. annai tries again in a few minutes.`, { retryAt: Date.now() + 5 * 60_000 });
  return refuse(w, 'other', both`${host} refused this (HTTP ${res.status}). annai tries again later.`);
}

/** @param {W} w */
async function check(w) {
  ready(w);
  /** @type {Response} */
  let res;
  try {
    res = await propfind(w, '0');
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
    // To a web page, a server that doesn't allow browser access looks like no answer at all.
    throw refuse(w, 'setup', w.l10n.both`annai couldn't reach ${new URL(w.url).host}. If this device is online, the server doesn't allow browser access yet: see what it needs below, then test again.`);
  }
  if (res.status === 404) {
    const made = await call(w, 'MKCOL', '');
    if (made.status === 409) throw refuse(w, 'missing', w.l10n.both`The folder above ${shownOf(w.url)} doesn't exist on the server, so annai can't make this one. Check the address.`);
    if (made.status !== 201) throw failure(w, made);
    return { note: w.l10n.t`Works: annai made the folder ${shownOf(w.url)} and can keep its backups there.` };
  }
  if (res.status !== 207) throw failure(w, res);
  return { note: w.l10n.t`Works: annai can keep its backups in ${shownOf(w.url)}.` };
}

/** The backups in the folder, newest first; other files are left alone. @param {W} w */
async function list(w) {
  ready(w);
  const res = await propfind(w, '1');
  if (res.status === 404) return [];
  if (res.status !== 207) throw failure(w, res);
  /** @type {any[]} */
  const out = [];
  for (const r of w.xml.elements(await w.read(res, 'text', new URL(w.url).host), 'response')) {
    if (w.xml.elements(r, 'collection').length) continue;
    let name = '';
    try {
      name = decodeURIComponent((w.xml.text(r, 'href') ?? '').replace(/\/+$/, '').split('/').pop() ?? '');
    } catch {
      continue;
    }
    const b = w.backupFiles.parse(name);
    if (b) out.push(b);
  }
  return out.sort((a, b) => b.at - a.at);
}

/** @param {W} w @param {{ blob: Blob, name: string }} archive @param {{ onProgress?: (p: any) => void, signal?: AbortSignal }} [o] */
async function put(w, archive, { onProgress = () => {}, signal } = {}) {
  ready(w);
  onProgress({ phase: 'uploading', done: 0, total: 1 });
  const send = () => call(w, 'PUT', archive.name, { body: archive.blob, headers: { 'content-type': 'application/octet-stream' }, signal });
  let res = await send();
  if (res.status === 404 || res.status === 409) {
    // The folder is gone: make it, then send again.
    if ((await call(w, 'MKCOL', '')).status === 201) res = await send();
  }
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) throw failure(w, res);
  onProgress({ phase: 'uploading', done: 1, total: 1 });
  return { id: archive.name, at: w.backupFiles.parse(archive.name)?.at ?? Date.now(), uploaded: archive.blob.size, files: 1 };
}

/** @param {W} w @param {string} id @param {{ onProgress?: (p: any) => void, signal?: AbortSignal }} [o] */
async function get(w, id, { onProgress = () => {}, signal } = {}) {
  ready(w);
  onProgress({ phase: 'downloading', done: 0, total: 1 });
  const res = await call(w, 'GET', id, { signal });
  if (!res.ok) throw failure(w, res);
  const blob = await w.read(res, 'blob', new URL(w.url).host);
  onProgress({ phase: 'downloading', done: 1, total: 1 });
  return blob;
}

/** Deletes one backup; one that is already gone is no error. @param {W} w @param {string} id */
async function remove(w, id) {
  ready(w);
  const res = await call(w, 'DELETE', id);
  if (!res.ok && res.status !== 404) throw failure(w, res);
}
