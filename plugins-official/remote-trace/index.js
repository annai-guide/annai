/**
 * Remote trace (for developers): sends annai's trace, as the Trace screen shows it, to a server the
 * user runs, so a developer can watch a phone's entries, requests and errors as they happen. It is
 * off until the user gives it a server and a token and turns Send on (spec §15: no telemetry), and
 * leaves location points out unless asked. Every entry goes through annai's own secret blanking
 * (annai.secrets.blank) first, though entries never hold keys. Stored content (texts over 2,000
 * characters, photos) stays on the device. scripts/trace-sink.mjs is a server that receives it;
 * docs/plugins.md, "Remote trace (for developers)", says what it sends and never sends.
 */

export const ID = 'remote-trace';
/** Where the user's settings are saved (sys:settings), which its hook watches. */
export const SETTINGS_FILE = `/plugin-settings/${ID}.json`;
/** A batch goes this long after the oldest entry waiting arrived, */
export const BATCH_MS = 3000;
/** or as soon as this many wait; a batch holds at most this many, */
export const BATCH_MAX = 100;
/** and at most this much JSON, half of what scripts/trace-sink.mjs reads. */
export const BATCH_BYTES = 512 * 1024;
/** An entry longer than this goes with its data cut. */
export const ENTRY_BYTES = 64 * 1024;
/** The most entries kept while the server can't take them; the oldest go first. */
export const KEEP_MAX = 2000;
/** After a failed try, the next waits this long, twice as long each time, up to RETRY_MAX_MS. */
export const RETRY_MS = 3000;
export const RETRY_MAX_MS = 60_000;
/** Refusals in a row before one card says so. */
export const REFUSALS = 3;
const SETTINGS_SCOPE = 'sys:settings';
const PAGE = `#/plugins/${ID}`;
const WHERE = 'Settings → Plugins → Remote trace (for developers)';
/** sw.js names its offline copy annai-shell-<version>-<build>. */
const SHELL = /^annai-shell-(.+)-([0-9a-f]{12})$/;
const encoder = new TextEncoder();

/**
 * Why annai can't send to an address, in plain words, or null: https anywhere, http only on this
 * device (annai's CSP allows nothing else). @param {unknown} address
 */
export function serverProblem(address) {
  const text = String(address ?? '').trim();
  if (!text) return 'It needs the address of your server.';
  /** @type {URL} */
  let u;
  try {
    u = new URL(text);
  } catch {
    return 'Its server address must start with https:// (http:// only for localhost or 127.0.0.1).';
  }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return null;
  return 'Its server address must start with https:// (http:// only for localhost or 127.0.0.1).';
}

/**
 * annai's version and build, from the names of the caches its service worker keeps: the oldest offline
 * copy, the one running while an update waits. @param {string[]} names @returns {{ app: string, build: string | null }}
 */
export function shellBuild(names) {
  const m = names.map((n) => SHELL.exec(n)).find(Boolean);
  return m ? { app: `annai ${m[1]}`, build: m[2] } : { app: 'annai', build: null };
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'The server';
  }
}

/**
 * An entry as it is sent: as stored, or, past ENTRY_BYTES, its head with a note instead of its data.
 * @param {any} e @returns {{ e: any, bytes: number }}
 */
function sized(e) {
  const bytes = encoder.encode(JSON.stringify(e)).length;
  if (bytes <= ENTRY_BYTES) return { e, bytes };
  const cut = { scope: e.scope, seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, data: { cut: `${bytes} bytes, more than the ${ENTRY_BYTES} one entry may send` } };
  return { e: cut, bytes: encoder.encode(JSON.stringify(cut)).length };
}

/**
 * Starts following the log and sending it. timers, now and cacheNames are the browser's, unless a test
 * gives its own. Returns the cleanup, which stops everything at once.
 * @param {any} annai
 * @param {{ timers?: { set: (fn: () => void, ms: number) => any, clear: (h: any) => void }, now?: () => number, cacheNames?: () => Promise<string[]> }} [o]
 */
export function start(annai, {
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
  now = () => Date.now(),
  cacheNames = async () => (typeof caches === 'undefined' ? [] : caches.keys()),
} = {}) {
  /** @type {{ server: string, location: boolean } | null} where it sends, while it is on */
  let on = null;
  /** @type {string | null} */
  let device = null;
  /** @type {{ e: any, bytes: number, at: number }[]} entries waiting, oldest first */
  let queue = [];
  /** @type {{ items: { e: any, bytes: number, at: number }[], abort: AbortController } | null} the batch being sent */
  let flight = null;
  let dropped = 0;
  /** @type {any} */
  let timer = null;
  let timerAt = 0;
  let retryAt = 0;
  let failures = 0;
  let refusals = 0;
  let carded = false;
  /** @type {string | null} why entries wait, for the chip's name */
  let problem = null;
  /** Settings being read again: no batch starts meanwhile. */
  let holding = 0;
  let reads = 0;
  let stopped = false;
  /** @type {(() => void) | null} */
  let chip = null;
  /** @type {any} */
  let chipEl = null;
  /** @type {any} the dock's ui object, once the chip has been drawn: what the card's action goes with */
  let ui = null;
  const shell = cacheNames().then(shellBuild, () => shellBuild([]));

  const card = (/** @type {any} */ c) => {
    try {
      annai.ui.card(c);
    } catch {
      // annai isn't ready for cards: the chip's name still says it
    }
  };

  /** The chip's name and title: what it does, and what waits and why when it is stuck. */
  const label = () => {
    if (!chipEl) return;
    const waiting = queue.length + (flight?.items.length ?? 0);
    const words = problem && waiting ? `Sending trace: ${waiting} waiting, ${problem}` : 'Sending trace';
    chipEl.setAttribute('aria-label', words);
    chipEl.title = words;
  };

  /** The dock's chip, there only while it is on (a hidden one would leave the row's separator). @param {boolean} show */
  const showChip = (show) => {
    if (show && !chip) {
      chip = annai.ui.slot('status-chip', {
        id: 'sending',
        render: (/** @type {any} */ el, /** @type {any} */ dock) => {
          chipEl = el;
          ui = dock;
          el.textContent = 'Trace';
          el.setAttribute('role', 'button');
          el.tabIndex = 0;
          const open = () => dock.go(PAGE);
          const key = (/** @type {KeyboardEvent} */ k) => {
            if (k.key !== 'Enter' && k.key !== ' ') return;
            k.preventDefault();
            open();
          };
          el.addEventListener('click', open);
          el.addEventListener('keydown', key);
          label();
          return () => {
            el.removeEventListener('click', open);
            el.removeEventListener('keydown', key);
            if (chipEl === el) chipEl = null;
          };
        },
      });
    } else if (!show && chip) {
      chip();
      chip = null;
      chipEl = null;
    }
  };

  /** Off: no timer, no request, nothing waiting, no chip, at once. */
  const halt = () => {
    on = null;
    device = null;
    if (timer !== null) timers.clear(timer);
    timer = null;
    flight?.abort.abort();
    flight = null;
    queue = [];
    dropped = 0;
    retryAt = 0;
    failures = 0;
    refusals = 0;
    carded = false;
    problem = null;
    showChip(false);
  };

  /** Keeps what a batch didn't send, before what came since, within KEEP_MAX. @param {{ e: any, bytes: number, at: number }[]} items */
  const giveBack = (items) => {
    queue = [...items, ...queue];
    const over = queue.length - KEEP_MAX;
    if (over > 0) {
      queue.splice(0, over);
      dropped += over;
    }
  };

  /** Sets the timer for the next batch: 3 s after the oldest entry waiting, at once for 100, never before a retry is due. */
  const schedule = () => {
    if (!on || holding || flight || stopped || !queue.length) return;
    const t = now();
    const due = Math.max(queue.length >= BATCH_MAX ? t : queue[0].at + BATCH_MS, retryAt);
    if (timer !== null) {
      if (timerAt <= due) return;
      timers.clear(timer);
    }
    timerAt = due;
    timer = timers.set(() => {
      timer = null;
      flush();
    }, Math.max(0, due - t));
  };

  /** A failed try: the next waits longer. @param {string} why */
  const failed = (why) => {
    failures++;
    retryAt = now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (failures - 1));
    problem = why;
  };

  /** Sends the oldest entries waiting, one batch, and keeps them when the server doesn't take them. */
  const flush = async () => {
    if (!on || holding || flight || stopped || !queue.length) return;
    const to = on;
    let n = 0;
    let bytes = 0;
    while (n < queue.length && n < BATCH_MAX && (n === 0 || bytes + queue[n].bytes <= BATCH_BYTES)) bytes += queue[n++].bytes;
    const items = queue.splice(0, n);
    const abort = new AbortController();
    const mine = () => flight?.abort === abort;
    flight = { items, abort };
    const told = dropped;
    let sent = false;
    try {
      const token = await annai.secrets.get('token');
      if (!mine()) return;
      if (!token) {
        halt();
        card({ tone: 'warn', title: "Remote trace isn't sending", body: `It needs the server's token. Add it in ${WHERE}.` });
        return;
      }
      if (!device) {
        device = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
        await annai.settings.set({ device });
      }
      const { app, build } = await shell;
      // annai's own blanking, a second guard: every secret annai keeps, and anything shaped like a credential (spec §9.9).
      const entries = await annai.secrets.blank(items.map((x) => x.e));
      if (!mine()) return;
      const res = await annai.net.fetch(to.server, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ app, build, device, dropped: told, entries }), signal: abort.signal,
      });
      res.body?.cancel().catch(() => {});
      if (!mine()) return;
      if (res.ok) {
        sent = true;
        dropped -= told;
        failures = 0;
        refusals = 0;
        carded = false;
        retryAt = 0;
        problem = null;
        return;
      }
      refusals++;
      failed(`the server answered ${res.status}`);
      if (refusals >= REFUSALS && !carded) {
        carded = true;
        const hint = res.status === 401 || res.status === 403 ? ': the token may be wrong' : '';
        card({
          tone: 'warn', title: 'The trace server refuses what annai sends',
          body: `${hostOf(to.server)} answered ${res.status} ${refusals} times in a row${hint}. annai keeps trying about once a minute, and keeps the newest ${KEEP_MAX.toLocaleString('en-US')} entries until they go. Check the server address and the token in ${WHERE}, or turn Send off there.`,
          actions: ui ? [{ label: 'Open Remote trace', primary: true, run: () => ui.go(PAGE) }] : [],
        });
      }
    } catch {
      // Offline, or no answer: tried again later. Anything else that throws is too, never at once.
      if (mine()) failed("the server can't be reached");
    } finally {
      if (mine()) {
        flight = null;
        if (!sent) giveBack(items);
        schedule();
      }
      label();
    }
  };

  /** One log entry, as the hook hands it: kept to send while it is on, location points only when asked. @param {any} e */
  const take = (e) => {
    if (!on || (e.type === 'location' && !on.location)) return;
    queue.push({ ...sized(e), at: now() });
    const over = queue.length + (flight?.items.length ?? 0) - KEEP_MAX;
    if (over > 0) {
      queue.splice(0, over);
      dropped += over;
    }
    if (problem) label();
    schedule();
  };

  /** Its settings, applied: on with a server it may use, else off (with a card when Send is on). @param {any} s */
  const apply = (s) => {
    if (s?.send !== true) {
      halt();
      return;
    }
    const why = serverProblem(s.server);
    if (why) {
      halt();
      card({ tone: 'warn', title: "Remote trace isn't sending", body: `${why} Change it in ${WHERE}.` });
      return;
    }
    on = { server: String(s.server).trim(), location: s.location === true };
    if (typeof s.device === 'string' && s.device) device = s.device;
    if (!on.location) queue = queue.filter((x) => x.e.type !== 'location');
    // The user changed something: try again now, and a new run of refusals may give a card.
    failures = 0;
    refusals = 0;
    carded = false;
    retryAt = 0;
    problem = null;
    showChip(true);
    label();
  };

  /** Reads its settings again; no batch starts until they are applied. */
  const reload = async () => {
    const mineRead = ++reads;
    holding++;
    try {
      const s = await annai.settings.get();
      if (mineRead === reads && !stopped) apply(s);
    } catch {
      if (mineRead === reads && !stopped) halt();
    } finally {
      holding--;
      schedule();
    }
  };

  const unhook = annai.hooks.on((/** @type {any} */ e) => {
    take(e);
    // The user saved its form, or reset it: Send may be off now, so nothing goes until it is read again.
    const saved = e.scope === SETTINGS_SCOPE && e.data?.path === SETTINGS_FILE;
    if (saved || (e.type === 'plugin.reset' && e.data?.plugin === ID)) reload();
  });
  reload();
  return () => {
    stopped = true;
    reads++;
    halt();
    unhook();
  };
}

/** @param {any} annai */
export function activate(annai) {
  return start(annai);
}
