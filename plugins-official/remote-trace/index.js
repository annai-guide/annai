/**
 * Remote trace (for developers): sends annai's trace, as the Trace screen shows it, to a server the
 * user runs, so a developer can watch a phone's entries, requests and errors as they happen. It is
 * off until the user gives it a server and a token and turns Send on (spec §15: no telemetry), and
 * leaves location points out unless asked. Every entry goes through annai's own secret blanking
 * (annai.secrets.blank) first, which blanks the keys annai keeps. Stored content (texts over 2,000
 * characters, photos) stays on the device. scripts/trace-sink.mjs is a server that receives it;
 * docs/plugins.md, "Remote trace (for developers)", says what it sends and never sends.
 * Detailed trace, a switch of its own for at most 24 hours, adds recordings, a text copy of the screen and a Flag button (in the Trace chip's place);
 * it goes off at once, and drops all it holds, when it is switched off, expires, or the server address changes.
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
/** The most entries, and the most bytes of them, kept while the server can't take them; the oldest go first. */
export const KEEP_MAX = 2000;
export const KEEP_BYTES = 4 * 1024 * 1024;
/** After a failed try, the next waits this long, twice as long each time, up to RETRY_MAX_MS. */
export const RETRY_MS = 3000;
export const RETRY_MAX_MS = 60_000;
/** Refusals in a row before one card says so. */
export const REFUSALS = 3;
/** Detailed trace turns itself off this long after it is turned on. */
export const DETAIL_MS = 24 * 60 * 60 * 1000;
/** The most bytes of recordings kept while the server can't take them; the oldest go first, and the log says so. */
export const CLIPS_KEEP_BYTES = 16 * 1024 * 1024;
/** A clip that arrives this long after a flag is marked with its time. */
export const FLAG_MS = 30_000;
/** The most characters of a screen's text in one entry; well within ENTRY_BYTES in any language. */
export const SCREEN_CHARS = 16_000;
/** A new screen draws for about this long before its text is copied. */
export const SCREEN_SETTLE_MS = 500;
const SETTINGS_SCOPE = 'sys:settings';
/** Screen copies and flags stay out of backups, as voice.route's device names do. */
const DEVICE_SCOPE = 'sys:device';
const PAGE = `#/plugins/${ID}`;
/** What a screen copy leaves out: fields and what they hold (typed words, keys), and what has no text to read. */
const NOT_COPIED = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CANVAS', 'AUDIO', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED']);
/** A line that looks like a key by its prefix (Anthropic, Google, GitHub); annai's blanking knows only the keys it keeps, so these never get that far. */
const KEY_LIKE = /(?:sk-ant-|AIza|ghp_)[\w-]{8,}/;
/** The Trace screen shows the log's rows, with every request and place in them: its text is never copied. */
const TRACE_ROUTE = /^#\/?trace(?:[/?]|$)/i;
/** The elements a screen copy names as landmarks; a section only with a name. */
const LANDMARKS = /** @type {Record<string, string>} */ ({ HEADER: 'header', NAV: 'nav', MAIN: 'main', ASIDE: 'aside', FOOTER: 'footer', DIALOG: 'dialog', FORM: 'form' });
const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'dialog', 'alertdialog', 'region', 'form', 'search', 'alert', 'status']);
/** sw.js names its offline copy annai-shell-<version>-<build>. */
const SHELL = /^annai-shell-(.+)-([0-9a-f]{12})$/;
/** What a Bearer token can hold: visible ASCII, no spaces (anything else, a request can't carry). */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;
/** A batch, or a single entry, the server found too big or not to its liking: it gets half, or that entry goes. */
const TOO_MUCH = new Set([400, 413]);
const encoder = new TextEncoder();
/**
 * @typedef {{ code: 'offline' | 'no-token' | 'token' | 'status' | 'unreachable' | 'unready', status?: number }} Problem
 *   why entries wait, as data: offline; no token, or one a request can't carry; the server's status; no answer; the batch not made ready
 */

/**
 * Why annai can't send to an address, in plain words (annai.l10n's: they are only shown), or null: https anywhere, http only on
 * this device (annai's CSP allows nothing else), and no name or password in it. @param {unknown} address @param {any} l10n annai.l10n
 */
export function serverProblem(address, { t }) {
  const text = String(address ?? '').trim();
  if (!text) return t`It needs the address of your server.`;
  /** @type {URL} */
  let u;
  try {
    u = new URL(text);
  } catch {
    return t`Its server address must start with https:// (http:// only for localhost or 127.0.0.1).`;
  }
  if (u.username || u.password) return t`Its server address has a name or password in it, which a request can't carry. Take it out, and give the server's token as the Token.`;
  if (u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return null;
  return t`Its server address must start with https:// (http:// only for localhost or 127.0.0.1).`;
}

/**
 * annai's version and build, from the names of the caches its service worker keeps: the oldest offline
 * copy, the one running while an update waits. @param {string[]} names @returns {{ app: string, build: string | null }}
 */
export function shellBuild(names) {
  const m = names.map((n) => SHELL.exec(n)).find(Boolean);
  return m ? { app: `annai ${m[1]}`, build: m[2] } : { app: 'annai', build: null };
}

/** Where a clip goes: <server>/clips, which scripts/trace-sink.mjs takes on any path. @param {string} server @param {Record<string, string>} what */
export function clipAddress(server, what) {
  const u = new URL(server);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/clips`;
  for (const [k, v] of Object.entries(what)) u.searchParams.set(k, v);
  return u.href;
}

/**
 * The text a person can see under root, a line per piece, with its landmarks as [main] or [nav: name]. Never what is in a field: no value is
 * read, and a textarea's or a contenteditable's words are left out with it; nor a closed <details>' body, nor a line that looks like a key. No pixels.
 * @param {any} root @param {{ gone: (el: any) => boolean, seen: (el: any, text: any) => boolean }} look
 *   gone: the element and all in it draw nothing (display: none); seen: this text node, directly in the element, is on the screen now
 */
export function screenText(root, look) {
  /** @type {string[]} */
  const lines = [];
  /** @param {any} el */
  const walk = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const text = String(n.nodeValue ?? '').replace(/\s+/g, ' ').trim();
        if (text && !KEY_LIKE.test(text) && look.seen(el, n)) lines.push(text);
      } else if (n.nodeType === 1 && !NOT_COPIED.has(n.tagName) && !n.hasAttribute('contenteditable') && !look.gone(n)) {
        if (n.tagName === 'DETAILS' && !n.hasAttribute('open')) {
          // Closed: its summary is what shows, and nothing else (the Trace screen's rows are closed ones).
          for (const c of n.childNodes) if (c.nodeType === 1 && c.tagName === 'SUMMARY') walk({ childNodes: [c] });
          continue;
        }
        const role = n.getAttribute('role');
        const name = n.getAttribute('aria-label');
        const kind = role && LANDMARK_ROLES.has(role) ? role : role ? null : LANDMARKS[n.tagName] ?? (n.tagName === 'SECTION' && name ? 'section' : null);
        const mark = kind ? `[${kind}${name ? `: ${name}` : ''}]` : null;
        const at = lines.length;
        if (mark) lines.push(mark);
        walk(n);
        if (mark && lines.length === at + 1) lines.pop(); // nothing seen in it
      }
    }
  };
  walk(root);
  return lines.join('\n');
}

/** The screen as this browser shows it now, as text. */
function browserScreen() {
  if (typeof document === 'undefined') return { route: '', text: '' };
  const text = screenText(document.body, {
    gone: (el) => getComputedStyle(el).display === 'none',
    seen: (el, node) => {
      const style = getComputedStyle(el);
      if (style.visibility !== 'visible') return false;
      // Where the text itself is: its parent may be a tall block, scrolled mostly away.
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    },
  });
  return { route: location.hash, text };
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
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

/** @typedef {{ e: any, bytes: number, at: number }} Item */

/**
 * Starts following the log and sending it. timers, now, cacheNames, online and onOnline are the browser's,
 * unless a test gives its own. Returns the cleanup, which stops everything at once.
 * @param {any} annai
 * @param {{ timers?: { set: (fn: () => void, ms: number) => any, clear: (h: any) => void }, now?: () => number, cacheNames?: () => Promise<string[]>,
 *   online?: () => boolean, onOnline?: (fn: () => void) => () => void, screen?: () => { route: string, text: string }, onRoute?: (fn: () => void) => () => void }} [o]
 */
export function start(annai, {
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
  now = () => Date.now(),
  cacheNames = async () => (typeof caches === 'undefined' ? [] : caches.keys()),
  // Only "offline" is believed: a phone that says it is online may still not be.
  online = () => typeof navigator === 'undefined' || navigator.onLine !== false,
  onOnline = (fn) => {
    if (typeof addEventListener !== 'function') return () => {};
    addEventListener('online', fn);
    return () => removeEventListener('online', fn);
  },
  screen = browserScreen,
  onRoute = (fn) => {
    if (typeof addEventListener !== 'function') return () => {};
    addEventListener('hashchange', fn);
    return () => removeEventListener('hashchange', fn);
  },
} = {}) {
  /** @type {{ server: string, location: boolean } | null} where it sends, while it is on */
  let on = null;
  /** @type {string | null} */
  let device = null;
  /** @type {Item[]} entries waiting, oldest first */
  let queue = [];
  let queueBytes = 0;
  /** @type {{ items: Item[], bytes: number, abort: AbortController } | null} the batch being sent */
  let flight = null;
  let dropped = 0;
  /** The most entries a batch holds now: halved while the server finds batches too big, doubled back as it takes them. */
  let limit = BATCH_MAX;
  /** @type {any} */
  let timer = null;
  let timerAt = 0;
  let retryAt = 0;
  let failures = 0;
  let refusals = 0;
  let carded = false;
  /** @type {string | null} the card about its own settings shown last (no token, a token a request can't carry), so it shows once */
  let told = null;
  /** @type {Problem | null} why entries wait, for the chip's name */
  let problem = null;
  const { t, plural, format } = annai.l10n;
  /** Where its settings are, in the screens' words. */
  const settingsAt = () => t`Change it in Settings → Plugins → Remote trace (for developers).`;
  /** Why entries wait, in a sentence. @param {Problem} p */
  const problemWords = (p) => (p.code === 'offline' ? t`The phone is offline.` : p.code === 'no-token' ? t`It has no token.` : p.code === 'token' ? t`Its token can't be sent.`
    : p.code === 'status' ? t`The server answered ${p.status}.` : p.code === 'unreachable' ? t`The server can't be reached.` : t`annai couldn't get the batch ready.`);
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
  /** @type {{ until: number, timer: any, ends: (() => void)[] } | null} Detailed trace, while it is on: when it ends, and what stops it */
  let detail = null;
  /** @typedef {{ id: string, kind: string, format: string, mediaType: string, data: Uint8Array, ms: number }} Clip */
  /** @type {Clip[]} recordings waiting, oldest first */
  let clips = [];
  let clipsBytes = 0;
  /** @type {{ clip: Clip, abort: AbortController } | null} the one being sent, still in clips */
  let clipFlight = null;
  /** @type {any} */
  let clipTimer = null;
  let clipFailures = 0;
  let clipRetryAt = 0;
  /** @type {string | null} the last recording heard */
  let lastClip = null;
  /** @type {number | null} when Flag was last tapped */
  let flagAt = null;
  /** @type {any} */
  let screenTimer = null;

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
    const words = problem && waiting ? format.sentences(plural(waiting, 'Sending trace: # waiting.', 'Sending trace: # waiting.'), problemWords(problem)) : t`Sending trace`;
    chipEl.setAttribute('aria-label', words);
    chipEl.title = words;
  };

  /** A chip that works as a button; returns what undoes it. @param {any} el @param {() => void} run */
  const chipButton = (el, run) => {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    const key = (/** @type {KeyboardEvent} */ k) => {
      if (k.key !== 'Enter' && k.key !== ' ') return;
      k.preventDefault();
      run();
    };
    el.addEventListener('click', run);
    el.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('click', run);
      el.removeEventListener('keydown', key);
    };
  };

  /** The dock's chip, there only while it is on (a hidden one would leave the row's separator). @param {boolean} show */
  const showChip = (show) => {
    if (show && !chip) {
      chip = annai.ui.slot('status-chip', {
        id: 'sending',
        render: (/** @type {any} */ el, /** @type {any} */ dock) => {
          chipEl = el;
          ui = dock;
          el.textContent = t`Trace`;
          const end = chipButton(el, () => dock.go(PAGE));
          label();
          return () => {
            end();
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

  /** The Trace chip shows while it sends, except while Detailed trace is on: its Flag chip takes the place, so the dock's row is no wider (it wraps, and the bar jumps). */
  const chipNow = () => showChip(on !== null && !detail);

  /** A fresh start on what the user changed: try now, and a new run of refusals may give a card. */
  const afresh = () => {
    failures = 0;
    refusals = 0;
    carded = false;
    told = null;
    retryAt = 0;
    problem = null;
    limit = BATCH_MAX;
  };

  /** The entries of Detailed trace's own that wait go, as the recordings do: text of the screen must not leave after it is off. */
  const dropTrace = () => {
    queue = queue.filter((x) => !String(x.e.type).startsWith('trace.'));
    queueBytes = queue.reduce((sum, x) => sum + x.bytes, 0);
  };

  /** Detailed trace off: nothing more heard or copied, no flag, nothing waiting, at once. */
  const detailOff = () => {
    if (detail) {
      timers.clear(detail.timer);
      for (const end of detail.ends) end();
    }
    detail = null;
    if (clipTimer !== null) timers.clear(clipTimer);
    if (screenTimer !== null) timers.clear(screenTimer);
    clipTimer = screenTimer = flagAt = lastClip = null;
    clipFlight?.abort.abort();
    clipFlight = null;
    clips = [];
    clipsBytes = 0;
    clipFailures = 0;
    clipRetryAt = 0;
    dropTrace();
    chipNow();
  };

  /** Off: no timer, no request, nothing waiting, no chip, at once. */
  const halt = () => {
    detailOff();
    on = null;
    device = null;
    if (timer !== null) timers.clear(timer);
    timer = null;
    flight?.abort.abort();
    flight = null;
    queue = [];
    queueBytes = 0;
    dropped = 0;
    afresh();
    chipNow();
  };

  /** Drops the oldest entries waiting while there are more than KEEP_MAX, or more than KEEP_BYTES, counting them. */
  const trim = () => {
    const inFlight = flight?.items.length ?? 0;
    const flightBytes = flight?.bytes ?? 0;
    let n = 0;
    while (n < queue.length && (queue.length - n + inFlight > KEEP_MAX || queueBytes + flightBytes > KEEP_BYTES)) queueBytes -= queue[n++].bytes;
    if (!n) return;
    queue.splice(0, n);
    dropped += n;
  };

  /** Sets the timer for the next batch: 3 s after the oldest entry waiting, at once for 100, never before a retry is due; never while offline. */
  const schedule = () => {
    if (!on || holding || flight || stopped || !queue.length) return;
    if (!online()) {
      // The browser tells annai when it is back (onOnline below): no tries until then.
      problem = { code: 'offline' };
      label();
      return;
    }
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

  /** A failed try: the next waits longer. @param {Problem} why */
  const failed = (why) => {
    failures++;
    retryAt = now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (failures - 1));
    problem = why;
  };

  /** A setting of its own a request can't go without: one card, and tries again, since the form can fix it without a settings entry. @param {Problem} why @param {string} body */
  const needs = (why, body) => {
    failed(why);
    if (told === why.code) return;
    told = why.code;
    card({ tone: 'warn', title: t`Remote trace isn't sending`, body });
  };

  /** Its device id, made at the first send. */
  const ownDevice = async () => {
    if (device) return;
    device = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await annai.settings.set({ device });
  };

  /** Sends the oldest entries waiting, one batch, and keeps them when the server doesn't take them. */
  const flush = async () => {
    if (!on || holding || flight || stopped || !queue.length) return;
    if (!online()) {
      schedule();
      return;
    }
    const to = on;
    let n = 0;
    let bytes = 0;
    while (n < queue.length && n < limit && (n === 0 || bytes + queue[n].bytes <= BATCH_BYTES)) bytes += queue[n++].bytes;
    const items = queue.splice(0, n);
    queueBytes -= bytes;
    const abort = new AbortController();
    const mine = () => flight?.abort === abort;
    flight = { items, bytes, abort };
    const toldDropped = dropped;
    /** Whether the batch is done with: taken, or its one entry dropped. */
    let done = false;
    let asking = false;
    try {
      // Read at every send: the form saves it apart from the settings file, so no entry says it changed.
      const token = String((await annai.secrets.get('token')) ?? '').trim();
      if (!mine()) return;
      if (!token) {
        needs({ code: 'no-token' }, t`It needs the server's token. Add it in Settings → Plugins → Remote trace (for developers).`);
        return;
      }
      if (!TOKEN_CHARS.test(token)) {
        needs({ code: 'token' }, format.sentences(t`Its token has characters a request can't carry: letters, digits and punctuation only, no spaces.`, settingsAt()));
        return;
      }
      await ownDevice();
      const { app, build } = await shell;
      // annai's own blanking, a second guard: every secret annai keeps, and anything shaped like a credential (spec §9.9).
      // It rejects when the secrets can't be read, so nothing goes out unchecked: the batch waits for the next try.
      const entries = await annai.secrets.blank(items.map((x) => x.e));
      if (!mine()) return;
      asking = true;
      const res = await annai.net.fetch(to.server, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ app, build, device, dropped: toldDropped, entries }), signal: abort.signal,
      });
      res.body?.cancel().catch(() => {});
      if (!mine()) return;
      if (res.ok) {
        done = true;
        dropped -= toldDropped;
        failures = 0;
        refusals = 0;
        carded = false;
        told = null;
        retryAt = 0;
        problem = null;
        limit = Math.min(BATCH_MAX, limit * 2);
        return;
      }
      refusals++;
      if (TOO_MUCH.has(res.status)) {
        // Half the batch next, soon; one entry it still refuses alone goes, so it can't hold up the rest.
        if (items.length > 1) limit = Math.max(1, Math.floor(items.length / 2));
        else {
          done = true;
          dropped++;
        }
        retryAt = now() + RETRY_MS;
        problem = { code: 'status', status: res.status };
      } else {
        failed({ code: 'status', status: res.status });
      }
      if (refusals >= REFUSALS && !carded) {
        carded = true;
        const host = hostOf(to.server);
        const kept = format.num(KEEP_MAX);
        card({
          tone: 'warn', title: t`The trace server refuses what annai sends`,
          body: format.sentences(res.status === 401 || res.status === 403 ? t`${host} answered ${res.status} ${refusals} times in a row: the token may be wrong.` : t`${host} answered ${res.status} ${refusals} times in a row.`,
            t`annai keeps trying about once a minute, and keeps the newest ${kept} entries until they go. Check the server address and the token in Settings → Plugins → Remote trace (for developers), or turn Send off there.`),
          actions: ui ? [{ label: t`Open Remote trace`, primary: true, run: () => ui.go(PAGE) }] : [],
        });
      }
    } catch {
      // Offline, or no answer; or the batch couldn't be made ready (its keys unread): tried again later, never at once.
      if (mine()) failed(asking ? { code: 'unreachable' } : { code: 'unready' });
    } finally {
      if (mine()) {
        flight = null;
        if (!done) {
          // Kept, before what came since, within the caps.
          queue = [...items, ...queue];
          queueBytes += bytes;
          if (!detail) dropTrace(); // it went off while this batch was on its way
          trim();
        }
        schedule();
      }
      label();
    }
  };

  /** One log entry, as the hook hands it: kept to send while it is on, location points only when asked. @param {any} e */
  const take = (e) => {
    if (!on || (e.type === 'location' && !on.location)) return;
    const item = { ...sized(e), at: now() };
    queue.push(item);
    queueBytes += item.bytes;
    trim();
    if (problem) label();
    schedule();
  };

  /**
   * An entry of Detailed trace's own, in this device's log and on its way: a plugin's entries don't reach its hook. Secrets are blanked before it is even
   * kept here. @param {string} type @param {any} data @returns {Promise<boolean>} whether it was written
   */
  const note = async (type, data) => {
    try {
      const clean = await annai.secrets.blank(data);
      if (!detail) return false;
      const written = await annai.events.append(DEVICE_SCOPE, type, clean);
      if (!detail) return false; // off while it was being written: it does not leave
      take(written);
      return true;
    } catch {
      return false; // the database closed under it, as an iPhone's can
    }
  };

  /** The saved switch goes off, and its form's, if it is on the screen: the form draws what is saved only when it opens. */
  const saveOff = () => {
    const box = globalThis.document?.getElementById(`setting-${ID}-detailed`);
    if (box) /** @type {HTMLInputElement} */ (box).checked = false;
    annai.settings.set({ detailed: false, detailedUntil: null }).catch(() => {});
  };

  /** 24 hours are up: off, and saved so, with one card. */
  const expire = () => {
    detailOff();
    saveOff();
    card({ tone: 'info', title: t`Detailed trace turned itself off`, body: format.sentences(t`It stops after 24 hours, so it can't be forgotten.`, settingsAt()) });
  };

  /** Its 24 hours may have passed while the phone slept, with the timer yet to run. */
  const expired = () => {
    if (!detail || now() < detail.until) return false;
    expire();
    return true;
  };

  /** The screen as text, cut to size. */
  const screenNow = () => {
    const { route, text: all } = screen();
    const text = TRACE_ROUTE.test(route) ? '' : all;
    return { route, text: text.slice(0, SCREEN_CHARS), ...(text.length > SCREEN_CHARS ? { cut: true } : {}) };
  };

  /** A tap on Flag: the moment, what's on screen and the last clip, findable by this time; clips in the next FLAG_MS say it too. */
  const flag = async () => {
    if (!detail || expired()) return;
    const at = (flagAt = now());
    const { route, text, ...more } = screenNow();
    const copied = await note('trace.screen', { route, text, ...more, flag: at, message: route });
    const flagged = await note('trace.flag', { at, route, lastClip, message: route });
    annai.ui.toast(copied && flagged ? t`Flagged` : t`Not flagged`);
  };

  /** Sends the oldest clip, unless one is going or a failure's wait isn't over. */
  const clipsSoon = () => {
    if (!detail || clipFlight || clipTimer !== null || !clips.length || !online()) return;
    clipTimer = timers.set(() => {
      clipTimer = null;
      sendClip();
    }, Math.max(0, clipRetryAt - now()));
  };

  /** A clip is gone from those waiting. @param {Clip} clip */
  const forgetClip = (clip) => {
    clips = clips.filter((c) => c !== clip);
    clipsBytes -= clip.data.length;
  };

  /** A clip that won't reach the server, counted in the log. @param {Clip} clip @param {string} why */
  const dropClip = (clip, why) => {
    forgetClip(clip);
    note('trace.clip.dropped', { id: clip.id, kind: clip.kind, bytes: clip.data.length, why, message: `${clip.id}: ${why}` });
  };

  const sendClip = async () => {
    if (!detail || !on || clipFlight || !clips.length || expired()) return;
    const clip = clips[0];
    const abort = new AbortController();
    const flight = (clipFlight = { clip, abort });
    const mine = () => clipFlight === flight;
    let ok = false;
    try {
      // A token that's missing or can't go: the batches' card says so; the clip waits like them.
      const token = String((await annai.secrets.get('token')) ?? '').trim();
      if (!mine() || !TOKEN_CHARS.test(token)) return;
      await ownDevice();
      if (!mine() || !on) return;
      const res = await annai.net.fetch(clipAddress(on.server, { device: /** @type {string} */ (device), id: clip.id, format: clip.format }), {
        method: 'POST', headers: { 'content-type': clip.mediaType, authorization: `Bearer ${token}` }, body: clip.data, signal: abort.signal,
      });
      res.body?.cancel().catch(() => {});
      if (!mine()) return;
      if (res.ok) {
        ok = true;
        forgetClip(clip);
      } else if (TOO_MUCH.has(res.status)) {
        // The server will never take this one: it can't hold up the rest.
        ok = true;
        dropClip(clip, `the server answered ${res.status}`);
      }
    } catch {
      // Offline, or no answer: tried again later.
    } finally {
      if (mine()) {
        clipFlight = null;
        clipFailures = ok ? 0 : clipFailures + 1;
        clipRetryAt = ok ? 0 : now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (clipFailures - 1));
        clipsSoon();
      }
    }
  };

  /** A recording from annai's voice ('heard-clips'), kept to send, within the cap; its entry names it and any flag it follows. @param {Clip} c */
  const heardClip = (c) => {
    if (!detail || expired()) return;
    const flagged = flagAt !== null && now() - flagAt <= FLAG_MS ? flagAt : null;
    lastClip = c.id;
    clips.push(c);
    clipsBytes += c.data.length;
    note('trace.clip', { id: c.id, kind: c.kind, format: c.format, bytes: c.data.length, ms: c.ms, ...(flagged === null ? {} : { flag: flagged }), message: `${c.kind}, ${c.format}, ${c.data.length} bytes${flagged === null ? '' : ', after a flag'}` });
    const going = clipFlight?.clip;
    while (clipsBytes > CLIPS_KEEP_BYTES) {
      const oldest = clips.find((x) => x !== going && x !== c);
      if (!oldest) break;
      dropClip(oldest, 'over the cap on what waits on the phone');
    }
    clipsSoon();
  };

  /** Detailed trace on, or still on: until when. @param {number} until */
  const detailOn = (until) => {
    if (detail) {
      timers.clear(detail.timer);
      detail.until = until;
    } else {
      /** @type {(() => void)[]} */
      const ends = [annai.register('heard-clips', { clip: heardClip })];
      ends.push(annai.ui.slot('status-chip', {
        id: 'flag',
        render: (/** @type {any} */ el) => {
          el.textContent = t`Flag`;
          const words = t`Flag this moment`;
          el.setAttribute('aria-label', words);
          el.title = words;
          return chipButton(el, () => void flag());
        },
      }));
      ends.push(onRoute(() => {
        if (screenTimer !== null) timers.clear(screenTimer);
        screenTimer = timers.set(() => {
          screenTimer = null;
          if (expired()) return;
          const copy = screenNow();
          note('trace.screen', { ...copy, message: copy.route });
        }, SCREEN_SETTLE_MS);
      }));
      detail = { until, timer: null, ends };
      chipNow();
    }
    detail.timer = timers.set(expire, Math.max(0, until - now()));
  };

  /** The Detailed trace switch, with Remote trace on: its clock starts when first seen on, and is kept across reloads. @param {any} s */
  const applyDetail = (s) => {
    if (s?.detailed !== true) {
      detailOff();
      if (s?.detailedUntil != null) saveOff(); // the next turn on starts a fresh 24 hours
      return;
    }
    // Never more than 24 hours from now: a saved end further off (a clock set ahead) is cut back.
    const until = typeof s.detailedUntil === 'number' ? Math.min(s.detailedUntil, now() + DETAIL_MS) : now() + DETAIL_MS;
    if (now() >= until) {
      expire();
      return;
    }
    if (s.detailedUntil !== until) annai.settings.set({ detailedUntil: until }).catch(() => {});
    detailOn(until);
  };

  /** Its settings, applied: on with a server it may use, else off (with a card when Send is on). @param {any} s */
  const apply = (s) => {
    if (s?.send !== true) {
      halt();
      if (s?.detailed === true) {
        // There's nothing to turn on without somewhere to send to, and it can't start by itself later.
        saveOff();
        card({ tone: 'warn', title: t`Detailed trace stayed off`, body: t`It needs a server address and Send on. Set those, then turn it on.` });
      }
      return;
    }
    const why = serverProblem(s.server, annai.l10n);
    if (why) {
      halt();
      if (s.detailed === true) saveOff();
      card({ tone: 'warn', title: t`Remote trace isn't sending`, body: format.sentences(why, settingsAt()) });
      return;
    }
    const moved = on !== null && on.server !== String(s.server).trim();
    on = { server: String(s.server).trim(), location: s.location === true };
    if (typeof s.device === 'string' && s.device.trim()) device = s.device.trim();
    if (!on.location) {
      queue = queue.filter((x) => x.e.type !== 'location');
      queueBytes = queue.reduce((sum, x) => sum + x.bytes, 0);
    }
    afresh();
    chipNow();
    label();
    if (moved && detail) {
      // Recordings and screen text were agreed for the old address: not one byte goes to the new one unless it is turned on again.
      detailOff();
      saveOff();
      card({ tone: 'info', title: t`Detailed trace turned off`, body: format.sentences(t`The server address changed, and recordings go only where you turned it on.`, settingsAt()) });
      return;
    }
    applyDetail(s);
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
  // Back online: what waits goes now, whatever retry was due.
  const unlisten = onOnline(() => {
    if (!on || stopped) return;
    retryAt = 0;
    if (problem?.code === 'offline') problem = null;
    schedule();
    label();
    clipRetryAt = 0;
    clipsSoon();
  });
  reload();
  return () => {
    stopped = true;
    reads++;
    halt();
    unhook();
    unlisten();
  };
}

/** @param {any} annai */
export function activate(annai) {
  return start(annai);
}
