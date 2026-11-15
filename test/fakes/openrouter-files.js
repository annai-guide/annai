/**
 * A stand-in for OpenRouter's Files API and its chat endpoint's answer to a dead file id, as a fetch, ids made up. Its shapes are what the
 * real API answered on 2026-11-14 (.superpowers/evidence/openrouter-files-r1 and openrouter-uploads-r1):
 * - POST /files: 200 `{ _shape: "openrouter", id: "or_file_…", type: "file", filename, mime_type, size_bytes, created_at, downloadable }`,
 *   the multipart name kept as filename and created_at an ISO time;
 * - GET /files?limit=1000: `{ _shape, data, has_more, first_id, last_id, cursor }`, seen empty and with annai's one file (has_more false, cursor null);
 * - DELETE /files/{id}: 200 `{ _shape, id, type: "file_deleted" }`, 404 `{ error: { message: "File not found: …", code: 404 } }`;
 * - POST /chat/completions naming a file_id it doesn't have: 400 `{ error: { message: "Invalid file_id: …", code: 400 } }`; one it has
 *   streams a short reply.
 * What the real API was never seen to do, and rests here on its published schema alone (openapi.json) or on nothing: a list of more than one
 * page (the cursor's name and its format, here base64 JSON, and the page size), the order of a list (here oldest first), and other apps'
 * files among annai's. The opt-in real check (test/live/providers.test.js) reads such a list for real.
 * status(method, path) may answer for any request first (a 401, a 503, a 404 on the list; 0: no answer, the request fails); delay(method, path)
 * may hold a request back until its promise settles; page: files per list page; list: what a list page answers instead (a shape annai can't read).
 * @param {{ files?: { id?: string, filename: string, created_at: string | number }[], page?: number, status?: (method: string, path: string) => number | null, delay?: (method: string, path: string) => Promise<unknown> | undefined, now?: () => number, list?: (page: any) => any }} [o]
 */
export function openRouterFiles({ files = [], page = 1000, status = () => null, delay = () => undefined, now = Date.now, list = (x) => x } = {}) {
  let n = 0;
  const id = () => `or_file_test${String(++n).padStart(8, '0')}`;
  /** @type {{ id: string, filename: string, created_at: string | number, mime_type: string, size_bytes: number }[]} */
  const held = files.map((f) => ({ mime_type: 'image/webp', size_bytes: 1000, ...f, id: f.id ?? id() }));
  /** @type {{ method: string, url: string, headers: Record<string, string> }[]} */
  const requests = [];
  /** @type {any[]} chat bodies */
  const chats = [];
  const json = (/** @type {number} */ s, /** @type {any} */ body) => new Response(JSON.stringify(body), { status: s, headers: { 'content-type': 'application/json' } });
  /** @param {string} url @param {RequestInit} [init] */
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const path = u.pathname.replace(/^\/api\/v1/, '');
    requests.push({ method, url, headers: /** @type {Record<string, string>} */ ({ ...(init.headers ?? {}) }) });
    await delay(method, path);
    const forced = status(method, path);
    if (forced === 0) throw new TypeError('Failed to fetch');
    if (forced) return json(forced, { error: { message: forced === 401 ? 'No cookie auth credentials found' : `HTTP ${forced}`, code: forced } });
    if (path === '/files' && method === 'POST') {
      const file = /** @type {FormData} */ (init.body).get('file');
      if (!(file instanceof Blob)) return json(400, { error: { message: 'No file', code: 400 } });
      const f = { id: id(), filename: /** @type {any} */ (file).name ?? 'blob', mime_type: file.type, size_bytes: file.size, created_at: new Date(now()).toISOString() };
      held.push(f);
      return json(200, { _shape: 'openrouter', ...f, type: 'file', downloadable: false });
    }
    if (path === '/files' && method === 'GET') {
      const limit = Number(u.searchParams.get('limit') ?? 100);
      const cursor = u.searchParams.get('cursor');
      const from = cursor ? JSON.parse(atob(cursor)).at : 0;
      const take = held.slice(from, from + Math.min(limit, page));
      const more = from + take.length < held.length;
      return json(200, list({
        _shape: 'openrouter',
        data: take.map((f) => ({ _shape: 'openrouter', ...f, type: 'file', downloadable: false })),
        has_more: more, first_id: take[0]?.id ?? null, last_id: take.at(-1)?.id ?? null, cursor: more ? btoa(JSON.stringify({ at: from + take.length })) : null,
      }));
    }
    const one = /^\/files\/([^/]+)$/.exec(path);
    if (one && method === 'DELETE') {
      const fid = decodeURIComponent(one[1]);
      const i = held.findIndex((f) => f.id === fid);
      if (i < 0) return json(404, { error: { message: `File not found: ${fid}`, code: 404 } });
      held.splice(i, 1);
      return json(200, { _shape: 'openrouter', id: fid, type: 'file_deleted' });
    }
    if (path === '/chat/completions' && method === 'POST') {
      const body = JSON.parse(String(init.body));
      chats.push(body);
      const named = body.messages.flatMap((/** @type {any} */ m) => (Array.isArray(m.content) ? m.content : [])).filter((/** @type {any} */ b) => b.type === 'file' && b.file?.file_id).map((/** @type {any} */ b) => b.file.file_id);
      const dead = named.find((/** @type {string} */ x) => !held.some((f) => f.id === x));
      if (dead) return json(400, { error: { message: `Invalid file_id: ${dead}`, code: 400 } });
      const chunk = (/** @type {any} */ x) => `data: ${JSON.stringify(x)}\n\n`;
      const sse = chunk({ choices: [{ index: 0, delta: { content: 'A red square.' } }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 4 } }) + 'data: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json(404, { error: { message: 'Not Found', code: 404 } });
  };
  return { fetch, held, requests, chats };
}
