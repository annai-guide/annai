import { h, field } from '../dom.js';
import { formatCost, bytes, withArticle } from '../format.js';
import { costs } from '../../core/agent/budgets.js';
import { toolSwitchList } from './tools.js';

/** What each kind of entry is, for the Kind filter. */
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
  Errors: ['error', 'plugin.error', 'plugin.disabled'],
  Plugins: ['plugin.install', 'plugin.update', 'plugin.reset', 'plugin.remove', 'plugin.error', 'plugin.disabled'],
  Backups: ['backup', 'backup.newer', 'backup.error', 'backup.download', 'backup.prune'],
  Notifications: ['push.sync', 'push.shown', 'push.opened'],
});

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
  const titles = new Map(scopes.map((/** @type {any} */ s) => [s.id, s.kind === 'sys' ? `System · ${s.title}` : s.title]));
  const select = h('select', { id: 'trace-scope' }, h('option', { value: '', text: 'Everything' }),
    ...scopes.map((/** @type {any} */ s) => h('option', { value: s.id, text: titles.get(s.id) })));
  select.value = route.params.scope ?? '';
  const kind = h('select', { id: 'trace-kind' }, ...Object.keys(KINDS).map((k) => h('option', { value: k, text: k })));
  kind.value = route.params.kind && KINDS[route.params.kind] !== undefined ? route.params.kind : 'Everything';
  const filter = h('input', { id: 'trace-type', autocomplete: 'off', placeholder: 'file.write', value: route.params.type ?? '' });
  // aria-busy while the list reloads after a filter changes, so a screen reader (or a test) knows the rows are not yet the new ones.
  const list = h('ol', { class: 'trace', 'aria-busy': 'true' });
  let pending = 0;
  const load = async () => {
    const my = ++pending;
    list.setAttribute('aria-busy', 'true');
    const ids = select.value ? [select.value] : scopes.map((/** @type {any} */ s) => s.id);
    const f = filter.value.trim();
    const types = KINDS[kind.value];
    // A drive logs a location point about every second: "Everything" leaves them to the Location kind (choice 10).
    // With a kind, "Type contains" narrows the query itself, so the newest 300 are all of what is asked for.
    const wanted = types ? types.filter((t) => !f || t.includes(f)) : null;
    const query = wanted ? { types: wanted } : f && 'location'.includes(f) ? {} : { notTypes: ['location'] };
    const all = (await Promise.all(ids.map((/** @type {string} */ id) => ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(id, { reverse: true, limit: 300, ...query }))))).flat();
    if (my !== pending) return;
    /** @type {Map<string, number>} the cost of each wake shown (spec §6.6: cost is always visible) */
    const perWake = new Map();
    for (const id of ids) for (const [w, c] of (await costs(ctx.store, id)).byWake) perWake.set(w, c);
    if (my !== pending) return;
    const rows = newestFirst(all.filter((e) => (!types || types.includes(e.type)) && (!f || e.type.includes(f))), 300);
    list.replaceChildren(...(rows.length ? rows.map((e) => row(ctx, e, titles, perWake)) : [h('li', { class: 'empty', text: 'Nothing here yet.' })]));
    list.setAttribute('aria-busy', 'false');
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  select.addEventListener('change', load);
  kind.addEventListener('change', load);
  filter.addEventListener('input', () => { list.setAttribute('aria-busy', 'true'); clearTimeout(timer); timer = setTimeout(load, 150); });
  await load();
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Trace' }),
    h('p', { class: 'sub', text: 'Everything annai recorded: file changes, model calls, imports, plugin problems and errors. Newest first.' }),
    h('div', { class: 'row' }, field('Show', select), field('Kind', kind), field('Type contains', filter)),
    list,
    ctx.agent ? h('section', { class: 'panel', 'aria-label': 'Tool switches' }, h('h2', { class: 'section', text: 'Tool switches' }), await toolSwitchList(ctx)) : null);
}

/** @param {any} ctx @param {any} e @param {Map<string, string>} titles @param {Map<string, number>} [perWake] */
function row(ctx, e, titles, perWake) {
  return h('li', {}, h('details', {},
    h('summary', {},
      h('span', { class: 'tm', text: new Date(e.ts).toLocaleString() }),
      h('span', { class: 'k', text: e.type }),
      h('span', { class: 'sub', text: `${titles.get(e.scope) ?? e.scope} · ${e.actor}` }),
      h('span', { class: 'd', text: traceSummary(e, { costs: perWake }) })),
    h('pre', { text: JSON.stringify(e, null, 2) }),
    e.refs?.length ? storedText(ctx, e) : null));
}

/** Which half wrote an entry, when Shiori is two. @param {any} d */
const halfOf = (d) => (d.half === 'koe' ? 'Koe · ' : d.half === 'kokoro' ? 'Kokoro · ' : '');

/**
 * One line about an event: what Shiori did, sent and read (spec §15). costs: the cost of each wake.
 * @param {any} e @param {{ costs?: Map<string, number> }} [o]
 */
export function traceSummary(e, { costs: perWake } = {}) {
  const d = e.data ?? {};
  const cut = (/** @type {unknown} */ s, n = 100) => {
    const t = String(s ?? '');
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  if (e.type.startsWith('file.')) return d.path ?? '';
  if (e.type === 'wake') {
    const why = (d.reasons ?? []).map((/** @type {any} */ r) => (r.kind === 'user' ? 'the user wrote' : r.kind === 'choice' ? 'the user tapped a choice' : r.text)).join('; ');
    const c = perWake?.get(d.id);
    return `${halfOf(d)}${c !== undefined ? `${why} · ${formatCost(c)}` : why}`;
  }
  if (e.type === 'note') return `${d.from === 'koe' ? 'Koe to Kokoro' : 'Kokoro to Koe'} · ${d.mode}${d.why && d.why !== 'tool' ? ` · ${d.why}` : ''} · ${cut(d.text)}`;
  if (e.type === 'halves') return `annai to Kokoro · ${d.state} · ${cut(d.text)}`;
  if (e.type === 'msg.user' || e.type === 'out.speak') return cut(d.text);
  if (e.type === 'heard') {
    return [d.source === 'dictation' ? 'phone dictation' : `${((d.ms ?? 0) / 1000).toFixed(1)} s from the microphone`, d.text ? `"${cut(d.text)}"` : null,
      d.answer ? 'an answer' : d.meanwhile ? 'while she was thinking' : null, d.dismissed ? 'not for Shiori' : null,
      d.clip ? `clip kept${d.clipFormat ? `: ${d.clipFormat}, ${bytes(d.clipBytes ?? 0)}` : ''}` : null].filter(Boolean).join(' · ');
  }
  if (e.type === 'heard.text') return `"${cut(d.text)}"${d.by ? ` · written down by ${d.by}` : ''}`;
  if (e.type === 'out.show') return cut(d.card?.title ?? d.card?.text ?? '');
  if (e.type === 'out.ask') return cut(d.question);
  if (e.type === 'grounded') return `from ${d.source} · ${cut(d.text)} · ${(d.links ?? []).length} link${(d.links ?? []).length === 1 ? '' : 's'}`;
  if (e.type === 'tool.call') return `${d.name} ${cut(JSON.stringify(d.input ?? {}), 120)}`;
  if (e.type === 'tool.result') return `${d.name} · ${d.ok ? 'ok' : 'error'} · ${d.ms ?? 0} ms${d.content ? ` · ${cut(d.content)}` : ''}`;
  if (e.type === 'net.request' && d.kind === 'web') return `${d.tool} · ${d.method ?? 'GET'} ${d.url}${d.status ? ` · ${d.status}` : ''}${d.error ? ` · ${d.error}` : ''} · ${d.ms ?? '?'} ms`;
  if (e.type === 'net.request' && d.kind === 'upload') return `upload · ${d.endpoint} · ${d.url} · ${d.error ?? d.status} · ${d.ms ?? '?'} ms`;
  // A deletion of a turn the provider kept (G2).
  if (e.type === 'net.request' && d.kind === 'forget') return `kept turn ${d.outcome === 'ok' ? 'deleted' : 'not deleted yet'} · ${d.endpoint} · ${d.status || 'no answer'} · ${d.ms ?? '?'} ms`;
  if (e.type === 'photo.replace') return `a refused photo sent again as a new copy (${d.mediaType})`;
  if (e.type === 'paused') return 'a turn cut off by opening another conversation';
  if (e.type === 'compaction') return d.mode === 'fresh' ? `started fresh after event ${d.to}` : `events ${d.from}–${d.to} summarized (${d.mode})`;
  if (e.type === 'location') return `${d.lat}, ${d.lng} ±${d.accuracy} m${typeof d.speed === 'number' && d.speed > 0 ? ` · ${Math.round(d.speed * 3.6)} km/h` : ''}${d.source ? ` · ${d.source}` : ''}`;
  if (e.type === 'trigger.fired') return `${d.watch} · ${cut(d.text)}${d.late ? ` · late by ${d.late} min` : ''}${d.offline ? ' · no connection' : ''}`;
  if (e.type === 'reminder') return `${d.aloud ? 'said aloud' : 'shown'} · ${cut(d.text)}`;
  if (e.type === 'voice.route') return `audio route ${d.route} · ${d.using === null ? 'from the devices present' : `the microphone in use: ${d.using || 'no name'}`} · ${(d.devices ?? []).map((/** @type {string} */ x) => x || 'no name').join(', ') || 'no devices'}`;
  if (e.type === 'state') return d.live ? `GPS ${d.live}` : d.voice ? `voice ${d.voice}${d.why ? ` (${d.why})` : ''}` : '';
  if (e.type === 'push.sync') return `${d.relay} · ${d.sent ?? 0} sent, ${d.calledOff ?? 0} called off · ${d.waiting ?? 0} waiting${d.error ? ` · ${cut(d.error)}` : ''}`;
  if (e.type === 'push.shown') return `notification shown · ${d.watch}`;
  if (e.type === 'push.opened') return `notification opened · ${d.watch}`;
  if (e.type === 'decide') {
    const [best, p] = Object.entries(d.result ?? {}).sort((a, b) => Number(b[1]) - Number(a[1]))[0] ?? ['?', 0];
    return `${best} (${Math.round(Number(p) * 100)}%) · by ${d.by}`;
  }
  if (e.type === 'error') return `${d.kind ?? 'error'}: ${cut(d.message)}`;
  if (e.type === 'model.turn') {
    const n = (d.attempts ?? []).length;
    // Whose turn: Koe's, Kokoro's, or Shiori's as one half.
    const who = d.tag === 'koe' ? 'Koe · ' : d.half === 'kokoro' ? 'Kokoro · ' : d.tag === 'conversation' ? 'Shiori · ' : '';
    return `${who}${d.role}: ${d.answeredBy ?? 'no answer'} · ${n} attempt${n === 1 ? '' : 's'}${d.cost !== undefined ? ` · ${formatCost(d.cost)}` : ''}`;
  }
  // A live session's life (K4): never its address or key, which annai never keeps.
  if (e.type === 'live.session') {
    return [`live session ${d.state}`, d.model, d.ms !== undefined ? (d.ms >= 60_000 ? `${(d.ms / 60_000).toFixed(1)} min` : `${(d.ms / 1000).toFixed(1)} s`) : null, d.why ? cut(d.why) : null, d.kind,
      d.bytesIn !== undefined ? `${bytes(d.bytesIn)} in, ${bytes(d.bytesOut ?? 0)} out` : null, d.cost !== undefined ? formatCost(d.cost) : null,
      d.sampleRate ? [`sound at ${(d.sampleRate / 1000).toFixed(1)} kHz`, ...[['processing', d.baseLatency], ['output', d.outputLatency]]
        .filter(([, x]) => x !== undefined && x !== null).map(([name, x]) => `${Math.round(x * 1000)} ms ${name} latency`)].join(', ') : null].filter(Boolean).join(' · ');
  }
  // How her voice played in a live session, in numbers only (the pops investigation, 2026-10-23).
  if (e.type === 'live.reply') {
    const before = d.cut && !d.ms;
    return [before ? 'her voice: cut before it played' : `her voice: ${((d.ms ?? 0) / 1000).toFixed(1)} s played`, d.cut && !before ? 'cut' : null,
      d.stalled ? 'stalled' : null, d.waitMs !== undefined && !before ? `started after ${d.waitMs} ms` : null,
      d.holes !== undefined ? `${d.holes} hole${d.holes === 1 ? '' : 's'}${d.holes ? `, ${d.holeMs ?? 0} ms` : ''}` : null, d.player ? `on ${d.player}` : null].filter(Boolean).join(' · ');
  }
  // How the user's turn in a live session ended, in numbers only (the voice investigation, 2026-10-22).
  if (e.type === 'live.turn') return `your turn ended: ${d.end} · ${((d.ms ?? 0) / 1000).toFixed(1)} s sent · floor ${d.floorDb ?? '?'} dB, loudest ${d.peakDb ?? '?'} dB`;
  if (e.type === 'net.request') {
    // Each clip's format and size (spec §10.6).
    const clips = d.format ? ` · ${d.format}, ${bytes(d.bytes ?? 0)}` : d.audio?.length ? ` · audio: ${d.audio.map((/** @type {any} */ a) => `${a.format}, ${bytes(a.bytes)}`).join('; ')}` : '';
    // How much it sent, and whether after a kept turn (G2).
    const sent = !d.format && d.bytes ? ` · ${bytes(d.bytes)} sent${d.kept ? ', after a kept turn' : ''}` : '';
    return `${d.model ?? ''} · ${d.outcome ?? ''}${d.status ? ` (${d.status})` : ''} · ${d.ms ?? '?'} ms${clips}${sent}`;
  }
  if (e.type === 'pack.download') {
    return [`${d.files ?? 0} files`, bytes(d.bytes ?? 0), `${d.guides ?? 0} guide${d.guides === 1 ? '' : 's'}`, d.failed ? `${d.failed} failed` : null,
      d.full ? 'at its limit' : null, d.stopped ? 'stopped' : null, d.auto ? 'by itself on Wi-Fi' : null].filter(Boolean).join(' · ');
  }
  if (e.type === 'backup') return `${d.type} · ${d.reason} · ${d.files ?? '?'} files sent, ${bytes(d.uploaded ?? 0)} · ${d.ms ?? '?'} ms`;
  if (e.type === 'backup.newer') return `${d.type} · a newer backup from ${d.remote?.label ? withArticle(d.remote.label) : 'another device'} is there`;
  if (e.type === 'backup.error') return `${d.type} · ${d.kind}: ${cut(d.message)}`;
  if (e.type === 'backup.download') return `${d.type} · downloaded ${d.backup}, ${bytes(d.bytes ?? 0)}`;
  if (e.type === 'backup.prune') return `${d.type} · deleted an older backup, ${d.backup}`;
  if (e.type === 'plugin.reset') {
    const n = (/** @type {number} */ c, /** @type {string} */ w) => `${c} ${w}${c === 1 ? '' : 's'}`;
    return `${d.name ?? d.plugin} · ${n((d.settings?.length ?? 0) + (d.otherSettings ?? 0), 'setting')}, ${n((d.secrets?.length ?? 0) + (d.otherSecrets ?? 0), 'secret')} · ${bytes(d.bytes ?? 0)}`;
  }
  return d.message ?? d.title ?? '';
}

/**
 * Shows the content an event names: a model's reply and its reasoning, say (spec §15: the trace
 * makes everything the agent read visible). Text is shown; anything else is described.
 * @param {any} ctx @param {any} e an event with refs; data.stored names them, when it is there
 */
function storedText(ctx, e) {
  const out = h('pre', { hidden: true });
  const btn = h('button', {
    class: 'btn ghost', type: 'button',
    onclick: async () => {
      /** @type {string[]} */
      const texts = [];
      for (const [i, hash] of e.refs.entries()) {
        const b = await ctx.store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.getBlob(hash));
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
        const body = !b ? '(no longer stored)'
          : /^text\/|json/.test(b.type) ? new TextDecoder().decode(new Uint8Array(b.data).subarray(0, 200_000))
            : `(${b.type}, ${b.size} bytes)`;
        const label = e.data?.stored?.[i];
        texts.push(label ? `${label}:\n${body}` : body);
      }
      out.textContent = texts.join('\n\n');
      out.hidden = false;
      btn.hidden = true;
    },
  }, 'Show what was stored');
  return h('div', {}, btn, out);
}
