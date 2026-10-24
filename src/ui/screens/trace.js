import { h, t, plural, field } from '../dom.js';
import { formatCost, size, duration, num, when, list } from '../format.js';
import { costs } from '../../core/agent/budgets.js';
import { toolSwitchList } from './tools.js';
import { readBlob } from '../../core/reach.js';

/** The trace's time: numeric, to the second, as the phone writes it. */
const STAMP = /** @type {Intl.DateTimeFormatOptions} */ ({ year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** What each kind of entry is, for the Kind filter, by its name in a link (#/trace?kind=Plugins). */
const KINDS = /** @type {Record<string, string[] | null>} */ ({
  Everything: null,
  Conversation: ['wake', 'msg.user', 'heard', 'heard.text', 'out.speak', 'out.show', 'out.ask', 'grounded', 'paused'],
  // What Shiori's two halves tell each other, and the blocks annai gives Kokoro (the Koe and Kokoro design).
  Halves: ['note', 'halves'],
  Tools: ['tool.call', 'tool.result'],
  Web: ['net.request', 'pack.download'],
  Models: ['model.turn', 'net.request', 'decide', 'speech.browser', 'recap', 'live.session', 'live.turn', 'live.reply', 'voice.route'],
  Housekeeping: ['compaction'],
  // GPS is what live mode did; its location points (about one a second on a drive) are a kind of their own,
  // so they never crowd the firings out of the newest 300 (B5).
  'GPS': ['trigger.fired', 'state', 'reminder'],
  Location: ['location'],
  Errors: ['error', 'plugin.error', 'plugin.disabled', 'content.refused'],
  Plugins: ['plugin.install', 'plugin.update', 'plugin.reset', 'plugin.remove', 'plugin.error', 'plugin.disabled'],
  Backups: ['backup', 'backup.newer', 'backup.error', 'backup.download', 'backup.peek', 'backup.prune'],
  Notifications: ['push.sync', 'push.shown', 'push.opened'],
});
/** The kinds as the filter shows them. @type {Record<string, string>} */
const KIND_NAMES = {
  Everything: t`Everything`, Conversation: t`Conversation`, Halves: t`Halves`, Tools: t`Tools`, Web: t`Web`, Models: t`Models`, Housekeeping: t`Housekeeping`,
  GPS: /* en */ 'GPS', Location: t`Location`, Errors: t`Errors`, Plugins: t`Plugins`, Backups: t`Backups`, Notifications: t`Notifications`,
};

/**
 * Entries newest first, by when each was written (`at`), not by its event time, which a simulated trip's clock puts in
 * the future. An entry from before `at` existed is placed by its event time; ties go to the later entry.
 * @param {import('../../core/types.js').EventRecord[]} events @param {number} limit
 */
export function newestFirst(events, limit) {
  return [...events].sort((a, b) => (b.at ?? b.ts) - (a.at ?? a.ts) || b.seq - a.seq).slice(0, limit);
}

/** @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderTrace(ctx, route) {
  const scopes = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.listScopes());
  const titles = new Map(scopes.map((/** @type {any} */ s) => [s.id, s.kind === 'sys' ? t`System · ${s.title}` : s.title]));
  const select = h('select', { id: 'trace-scope' }, h('option', { value: '', text: t`Everything` }),
    ...scopes.map((/** @type {any} */ s) => h('option', { value: s.id, text: titles.get(s.id) })));
  select.value = route.params.scope ?? '';
  const kind = h('select', { id: 'trace-kind' }, ...Object.keys(KINDS).map((k) => h('option', { value: k, text: KIND_NAMES[k] ?? k })));
  kind.value = route.params.kind && KINDS[route.params.kind] !== undefined ? route.params.kind : /* en */ 'Everything';
  // An entry's type is a code, as the log writes it.
  const filter = h('input', { id: 'trace-type', autocomplete: 'off', placeholder: /* en */ 'file.write', value: route.params.type ?? '' });
  // aria-busy while the list reloads after a filter changes, so a screen reader (or a test) knows the rows are not yet the new ones.
  const entries = h('ol', { class: 'trace', 'aria-busy': 'true' });
  let pending = 0;
  const load = async () => {
    const my = ++pending;
    entries.setAttribute('aria-busy', 'true');
    const ids = select.value ? [select.value] : scopes.map((/** @type {any} */ s) => s.id);
    const f = filter.value.trim();
    const types = KINDS[kind.value];
    // A drive logs a location point about every second: "Everything" leaves them to the Location kind (choice 10).
    // With a kind, "Type contains" narrows the query itself, so the newest 300 are all of what is asked for.
    const wanted = types ? types.filter((type) => !f || type.includes(f)) : null;
    const query = wanted ? { types: wanted } : f && 'location'.includes(f) ? {} : { notTypes: ['location'] };
    const all = (await Promise.all(ids.map((/** @type {string} */ id) => ctx.store.tx(['events'], 'readonly', (/** @type {any} */ tx) => tx.listEvents(id, { reverse: true, limit: 300, ...query }))))).flat();
    if (my !== pending) return;
    /** @type {Map<string, number>} the cost of each wake shown (spec §6.6: cost is always visible) */
    const perWake = new Map();
    for (const id of ids) for (const [w, c] of (await costs(ctx.store, id)).byWake) perWake.set(w, c);
    if (my !== pending) return;
    const rows = newestFirst(all.filter((e) => (!types || types.includes(e.type)) && (!f || e.type.includes(f))), 300);
    entries.replaceChildren(...(rows.length ? rows.map((e) => row(ctx, e, titles, perWake)) : [h('li', { class: 'empty', text: t`Nothing here yet.` })]));
    entries.setAttribute('aria-busy', 'false');
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  select.addEventListener('change', load);
  kind.addEventListener('change', load);
  filter.addEventListener('input', () => { entries.setAttribute('aria-busy', 'true'); clearTimeout(timer); timer = setTimeout(load, 150); });
  await load();
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: t`Trace` }),
    h('p', { class: 'sub', text: t`Everything annai recorded: file changes, model calls, imports, plugin problems and errors. Newest first.` }),
    h('div', { class: 'row' }, field(t`Show`, select), field(t`Kind`, kind), field(t`Type contains`, filter)),
    entries,
    ctx.agent ? h('section', { class: 'panel', 'aria-label': t`Tool switches` }, h('h2', { class: 'section', text: t`Tool switches` }), await toolSwitchList(ctx)) : null);
}

/** @param {any} ctx @param {any} e @param {Map<string, string>} titles @param {Map<string, number>} [perWake] */
function row(ctx, e, titles, perWake) {
  return h('li', {}, h('details', {},
    h('summary', {},
      h('span', { class: 'tm', text: when(e.ts, undefined, STAMP) }),
      // Its type and who wrote it are codes, as the log keeps them (decision 11).
      h('span', { class: 'k', lang: 'en', text: e.type }),
      h('span', { class: 'sub' }, titles.get(e.scope) ?? e.scope, ' · ', h('span', { lang: 'en', text: e.actor })),
      h('span', { class: 'd', text: traceSummary(e, { costs: perWake }) })),
    // The entry as it is stored, a developer's words.
    h('pre', { lang: 'en', text: JSON.stringify(e, null, 2) }),
    e.refs?.length ? storedText(ctx, e) : null));
}

/** Which half wrote an entry, when Shiori is two: their names, the same in every language. @param {any} d */
const halfOf = (d) => (d.half === 'koe' ? /* en */ 'Koe · ' : d.half === 'kokoro' ? /* en */ 'Kokoro · ' : '');

/** Who a newer backup came from, by the label it was made with (platform.js's deviceName). */
const NEWER_FROM = /** @type {Record<string, string>} */ ({
  iPhone: t`a newer backup from an iPhone is there`, iPad: t`a newer backup from an iPad is there`, 'Android phone': t`a newer backup from an Android phone is there`,
  computer: t`a newer backup from a computer is there`,
});

/**
 * One line about an event: what Shiori did, sent and read (spec §15). costs: the cost of each wake. annai's words are the screens';
 * what the entry holds (types, names, codes, texts, addresses) is shown as it is kept.
 * @param {any} e @param {{ costs?: Map<string, number> }} [o]
 */
export function traceSummary(e, { costs: perWake } = {}) {
  const d = e.data ?? {};
  const cut = (/** @type {unknown} */ s, n = 100) => {
    const text = String(s ?? '');
    return text.length > n ? `${text.slice(0, n)}…` : text;
  };
  /** Words said, quoted. @param {unknown} s */
  const quoted = (s) => t`"${cut(s)}"`;
  /** @param {...unknown} parts */
  const line = (...parts) => parts.filter((x) => x !== null && x !== undefined && x !== '' && x !== false).join(' · ');
  if (e.type.startsWith('file.')) return d.path ?? '';
  if (e.type === 'wake') {
    // The model's own wake reasons are kept in English; the user's two are the screens' words.
    const why = (d.reasons ?? []).map((/** @type {any} */ r) => (r.kind === 'user' ? t`the user wrote` : r.kind === 'choice' ? t`the user tapped a choice` : r.text)).join('; ');
    const c = perWake?.get(d.id);
    return `${halfOf(d)}${c !== undefined ? `${why} · ${formatCost(c)}` : why}`;
  }
  if (e.type === 'note') return line(d.from === 'koe' ? t`Koe to Kokoro` : t`Kokoro to Koe`, d.mode, d.why && d.why !== 'tool' ? d.why : null, cut(d.text));
  if (e.type === 'halves') return line(t`annai to Kokoro`, d.state, cut(d.text));
  if (e.type === 'msg.user' || e.type === 'out.speak') return cut(d.text);
  if (e.type === 'heard') {
    return line(d.source === 'dictation' ? t`phone dictation` : t`${duration(d.ms ?? 0)} from the microphone`, d.text ? quoted(d.text) : null,
      d.answer ? t`an answer` : d.meanwhile ? t`while she was thinking` : null, d.dismissed ? t`not for Shiori` : null,
      d.clip ? (d.clipFormat ? t`clip kept: ${d.clipFormat}, ${size(d.clipBytes ?? 0)}` : t`clip kept`) : null);
  }
  if (e.type === 'heard.text') return line(quoted(d.text), d.by ? t`written down by ${d.by}` : null);
  if (e.type === 'out.show') return cut(d.card?.title ?? d.card?.text ?? '');
  if (e.type === 'out.ask') return cut(d.question);
  if (e.type === 'grounded') return line(t`from ${d.source}`, cut(d.text), plural((d.links ?? []).length, '# link', '# links'));
  if (e.type === 'tool.call') return `${d.name} ${cut(JSON.stringify(d.input ?? {}), 120)}`;
  if (e.type === 'tool.result') return line(d.name, d.ok ? t`ok` : t`error`, `${d.ms ?? 0} ms`, d.content ? cut(d.content) : null);
  if (e.type === 'net.request' && d.kind === 'web') return line(d.tool, `${d.method ?? 'GET'} ${d.url}`, d.status || null, d.error || null, `${d.ms ?? '?'} ms`);
  if (e.type === 'net.request' && d.kind === 'upload') return line(t`upload`, d.endpoint, d.url, d.error ?? d.status, `${d.ms ?? '?'} ms`);
  // A deletion of a turn the provider kept (G2).
  if (e.type === 'net.request' && d.kind === 'forget') return line(d.outcome === 'ok' ? t`kept turn deleted` : t`kept turn not deleted yet`, d.endpoint, d.status || t`no answer`, `${d.ms ?? '?'} ms`);
  if (e.type === 'net.request' && d.kind === 'look') return line(t`kept turn looked up`, d.endpoint, d.status || t`no answer`, `${d.ms ?? '?'} ms`);
  if (e.type === 'photo.replace') return t`a refused photo sent again as a new copy (${d.mediaType})`;
  if (e.type === 'import') {
    const n = Number(d.uncarried) || 0;
    const app = d.app ?? '?';
    return line(d.kind === 'trip' ? t`from a trip's file, annai ${app}` : t`from a backup, annai ${app}`,
      n ? plural(n, "# piece of content it didn't hold left out", "# pieces of content it didn't hold left out") : null);
  }
  // Another trip's content, asked for here by its hash (reach.js): not given.
  if (e.type === 'content.refused') return line(d.via, e.scope?.startsWith('trip-') ? t`asked for content that isn't this trip's, and got none` : t`asked for content that isn't here, and got none`);
  if (e.type === 'paused') return t`a turn cut off by opening another conversation`;
  if (e.type === 'compaction') return d.mode === 'fresh' ? t`started fresh after event ${d.to}` : t`events ${d.from}–${d.to} summarized (${d.mode})`;
  if (e.type === 'location') return /* en */ `${d.lat}, ${d.lng} ±${d.accuracy} m${typeof d.speed === 'number' && d.speed > 0 ? ` · ${Math.round(d.speed * 3.6)} km/h` : ''}${d.source ? ` · ${d.source}` : ''}`;
  if (e.type === 'trigger.fired') return line(d.watch, cut(d.text), d.late ? t`late by ${d.late} min` : null, d.offline ? t`no connection` : null);
  if (e.type === 'reminder') return line(d.aloud ? t`said aloud` : t`shown`, cut(d.text));
  if (e.type === 'voice.route') {
    const unnamed = t`no name`;
    return line(t`audio route ${d.route}`, d.using === null ? t`from the devices present` : t`the microphone in use: ${d.using || unnamed}`,
      (d.devices ?? []).map((/** @type {string} */ x) => x || unnamed).join(', ') || t`no devices`);
  }
  if (e.type === 'state') {
    // As live mode and the voice log them: on or off, and the voice's reason, a code.
    if (d.live) return d.live === 'on' ? t`GPS on` : d.live === 'off' ? t`GPS off` : `GPS ${d.live}`;
    if (!d.voice) return '';
    const voice = d.voice === 'on' ? t`voice on` : d.voice === 'off' ? t`voice off` : `voice ${d.voice}`;
    return d.why ? `${voice} (${d.why})` : voice;
  }
  if (e.type === 'push.sync') return line(d.relay, t`${d.sent ?? 0} sent, ${d.calledOff ?? 0} called off`, t`${d.waiting ?? 0} waiting`, d.error ? cut(d.error) : null);
  if (e.type === 'push.shown') return line(t`notification shown`, d.watch);
  if (e.type === 'push.opened') return line(t`notification opened`, d.watch);
  if (e.type === 'decide') {
    const [best, p] = Object.entries(d.result ?? {}).sort((a, b) => Number(b[1]) - Number(a[1]))[0] ?? ['?', 0];
    return line(`${best} (${Math.round(Number(p) * 100)}%)`, t`by ${d.by}`);
  }
  if (e.type === 'error') return `${d.kind ?? /* en */ 'error'}: ${cut(d.message)}`;
  if (e.type === 'model.turn') {
    const n = (d.attempts ?? []).length;
    // Whose turn: Koe's, Kokoro's, or Shiori's as one half.
    const who = d.tag === 'koe' ? /* en */ 'Koe · ' : d.half === 'kokoro' ? /* en */ 'Kokoro · ' : d.tag === 'conversation' ? /* en */ 'Shiori · ' : '';
    return `${who}${line(`${d.role}: ${d.answeredBy ?? t`no answer`}`, plural(n, '# attempt', '# attempts'), d.cost !== undefined ? formatCost(d.cost) : null)}`;
  }
  // A live session's life (K4): never its address or key, which annai never keeps.
  if (e.type === 'live.session') {
    const latency = [d.baseLatency === undefined || d.baseLatency === null ? null : t`${Math.round(d.baseLatency * 1000)} ms processing latency`,
      d.outputLatency === undefined || d.outputLatency === null ? null : t`${Math.round(d.outputLatency * 1000)} ms output latency`].filter((x) => x !== null);
    return line(t`live session ${d.state}`, d.model, d.ms !== undefined ? duration(d.ms) : null, d.why ? cut(d.why) : null, d.kind,
      d.bytesIn !== undefined ? t`${size(d.bytesIn)} in, ${size(d.bytesOut ?? 0)} out` : null, d.cost !== undefined ? formatCost(d.cost) : null,
      d.sampleRate ? list([t`sound at ${num(d.sampleRate / 1000, { maximumFractionDigits: 1 })} kHz`, ...latency], 'plain') : null);
  }
  // How her voice played in a live session, in numbers only (the pops investigation, 2026-10-23).
  if (e.type === 'live.reply') {
    const before = d.cut && !d.ms;
    return line(before ? t`her voice: cut before it played` : t`her voice: ${duration(d.ms ?? 0)} played`, d.cut && !before ? t`cut` : null,
      d.stalled ? t`stalled` : null, d.waitMs !== undefined && !before ? t`started after ${d.waitMs} ms` : null,
      d.holes === undefined ? null : d.holes ? plural(d.holes, '# hole, {0} ms', '# holes, {0} ms', d.holeMs ?? 0) : plural(0, '# hole', '# holes'),
      d.player ? t`on ${d.player}` : null);
  }
  // How the user's turn in a live session ended, in numbers only (the voice investigation, 2026-10-22).
  if (e.type === 'live.turn') return t`your turn ended: ${d.end} · ${duration(d.ms ?? 0)} sent · floor ${d.floorDb ?? '?'} dB, loudest ${d.peakDb ?? '?'} dB`;
  if (e.type === 'net.request') {
    // Each clip's format and size (spec §10.6).
    const clips = d.format ? `${d.format}, ${size(d.bytes ?? 0)}` : d.audio?.length ? t`audio: ${d.audio.map((/** @type {any} */ a) => `${a.format}, ${size(a.bytes)}`).join('; ')}` : null;
    // How much it sent, and whether after a kept turn (G2).
    const sent = !d.format && d.bytes ? (d.kept ? t`${size(d.bytes)} sent, after a kept turn` : t`${size(d.bytes)} sent`) : null;
    return line(d.model ?? '', `${d.outcome ?? ''}${d.status ? ` (${d.status})` : ''}`, `${d.ms ?? '?'} ms`, clips, sent);
  }
  if (e.type === 'pack.download') {
    return line(plural(d.files ?? 0, '# file', '# files'), size(d.bytes ?? 0), plural(d.guides ?? 0, '# guide', '# guides'), d.failed ? t`${d.failed} failed` : null,
      d.full ? t`at its limit` : null, d.stopped ? t`stopped` : null, d.auto ? t`by itself on Wi-Fi` : null);
  }
  if (e.type === 'backup') return line(d.type, d.reason, t`${d.files ?? '?'} files sent, ${size(d.uploaded ?? 0)}`, `${d.ms ?? '?'} ms`);
  if (e.type === 'backup.newer') return line(d.type, NEWER_FROM[d.remote?.label] ?? t`a newer backup from another device is there`);
  if (e.type === 'backup.error') return `${d.type} · ${d.kind}: ${cut(d.message)}`;
  if (e.type === 'backup.download') return line(d.type, d.stopped ? t`downloaded ${d.backup}, ${size(d.bytes ?? 0)}, then stopped: thrown away` : t`downloaded ${d.backup}, ${size(d.bytes ?? 0)}`);
  if (e.type === 'backup.peek') return line(d.type, t`${d.backup} can't be opened: ${cut(d.problem)}`);
  if (e.type === 'backup.prune') return line(d.type, t`deleted an older backup, ${d.backup}`);
  if (e.type === 'plugin.reset') {
    const counts = [plural((d.settings?.length ?? 0) + (d.otherSettings ?? 0), '# setting', '# settings'), plural((d.secrets?.length ?? 0) + (d.otherSecrets ?? 0), '# secret', '# secrets')];
    return line(d.name ?? d.plugin, list(counts, 'plain'), size(d.bytes ?? 0));
  }
  return d.message ?? d.title ?? '';
}

/**
 * Shows the content an event names: a model's reply and its reasoning, say (spec §15: the trace
 * makes everything the agent read visible). Text is shown; anything else is described.
 * @param {any} ctx @param {any} e an event with refs; data.stored names them, when it is there
 */
function storedText(ctx, e) {
  // What was sent and read, as it was kept: a developer's words (decision 11).
  const out = h('pre', { hidden: true, lang: 'en' });
  const btn = h('button', {
    class: 'btn ghost', type: 'button',
    onclick: async () => {
      /** @type {string[]} */
      const texts = [];
      for (const [i, hash] of e.refs.entries()) {
        // The entry's own names, read for its scope (reach.js).
        const b = await readBlob(ctx.store, e.scope, hash, { named: e });
        // A kept voice clip plays here, as it was kept (spec §10.2); its address goes with the player.
        if (b?.type.startsWith('audio/')) {
          const src = URL.createObjectURL(new Blob([b.data], { type: b.type }));
          const player = h('audio', { controls: true, src });
          out.after(player);
          const gone = new MutationObserver(() => {
            if (player.isConnected) return;
            gone.disconnect();
            URL.revokeObjectURL(src);
          });
          gone.observe(document.body, { childList: true, subtree: true });
        }
        const body = !b ? t`(no longer stored)`
          : /^text\/|json/.test(b.type) ? new TextDecoder().decode(new Uint8Array(b.data).subarray(0, 200_000))
            : plural(b.size, '({0}, # byte)', '({0}, # bytes)', b.type);
        const label = e.data?.stored?.[i];
        texts.push(label ? `${label}:\n${body}` : body);
      }
      out.textContent = texts.join('\n\n');
      out.hidden = false;
      btn.hidden = true;
    },
  }, t`Show what was stored`);
  return h('div', {}, btn, out);
}
