import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { restoreGroup } from '../../src/core/trip-files.js';
import { freeableDeleted, deleteForGood } from '../../src/ui/file-delete.js';
import { record } from '../../src/core/agent/log.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';
import { snapshot } from '../contract/snapshot.js';

// Delete for good over random histories (seeded, so every run is the same). The invariant that matters: a listed deleted file that is
// not an exact copy of the one tapped (the same stored versions, no more, no fewer) survives whole: its history entries, and every
// version's content. Beside it: the dry run changes nothing and agrees with the real tap; a kept tap changes nothing; no live file or
// content anything still names is lost; the toast's figure is what left the store.

const SEEDS = 1500;
const PDF = { author: 'user', type: 'application/pdf' };
// Few distinct contents, so versions are often shared between files: the cases a wrong copy rule gets wrong.
const CONTENTS = ['x', 'y', 'x', 'y', 'z'];
const FILES = ['/files/p0.pdf', '/files/p1.pdf', '/files/p2.pdf', '/files/p3.pdf'];
const BOOKS = ['/bookings/b0.json', '/bookings/b1.json'];
const BASE = 1_700_000_000_000;

/** A seeded generator (mulberry32). @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {() => number} rnd @returns {any[][]} */
function genOps(rnd) {
  /** @param {any[]} xs */
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const ops = [];
  const n = 6 + Math.floor(rnd() * 10);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.34) ops.push(['w', pick(FILES), pick(CONTENTS)]);
    else if (r < 0.68) ops.push(['d', pick(FILES)]);
    else if (r < 0.74) ops.push(['g', pick(FILES), pick(BOOKS)]);
    else if (r < 0.78) ops.push(['wb', pick(BOOKS), Math.floor(rnd() * 3)]);
    else if (r < 0.81) ops.push(['db', pick(BOOKS)]);
    else if (r < 0.87) ops.push(['rs', pick(FILES)]);
    else if (r < 0.90) ops.push(['cv', pick(CONTENTS)]);
    else if (r < 0.96) ops.push(['ow', pick(CONTENTS)]);
    else ops.push(['od', pick(CONTENTS)]);
  }
  return ops;
}

/** @param {any} W @param {any[]} op */
async function apply({ ws, store, T, T2 }, op) {
  switch (op[0]) {
    case 'w': return ws.write(T, op[1], op[2], PDF);
    case 'd': case 'db': return ws.delete(T, op[1], { author: 'shiori' });
    case 'g': return ws.writeMany(T, [op[1], op[2]].map((path) => ({ path, content: null })), { author: 'user', with: op[1] });
    case 'wb': return ws.write(T, op[1], { id: 'b', v: op[2] }, { author: 'shiori' });
    case 'rs': return restoreGroup(ws, T, op[1]);
    case 'cv': { // the conversation reads a content
      const hash = await sha256Hex(utf8(op[1]));
      return record(store, T, { type: 'tool.result', actor: 'system', data: { id: `c${op[1]}`, name: 'read', ok: true, document: { hash, mediaType: 'application/pdf' } }, blobs: [{ hash, type: 'application/pdf' }] });
    }
    case 'ow': return ws.write(T2, '/files/o.pdf', op[1], PDF); // another trip has some content
    case 'od': await ws.write(T2, '/files/o.pdf', op[1], PDF); return ws.delete(T2, '/files/o.pdf', { author: 'shiori' });
    default: throw new Error(`unknown op ${op[0]}`);
  }
}

/** Replays a history on a fresh store from the same clock start, so every replay is identical. @param {any[][]} ops */
async function build(ops) {
  let now = BASE;
  const real = Date.now;
  Date.now = () => ++now;
  try {
    const store = createMemoryStore();
    const ws = new Workspace(store);
    await ensureBaseScopes(ws);
    const T = await createTrip(ws, { title: 'Fuzz' });
    const T2 = await createTrip(ws, { title: 'Other' });
    const W = { store, ws, T, T2 };
    for (const op of ops) await apply(W, op).catch(() => {}); // a step that can't happen (already gone, not there yet) changes nothing
    return W;
  } finally {
    Date.now = real;
  }
}

/** What the invariants compare. @param {any} W */
async function capture({ store, ws, T, T2 }) {
  /** @type {Map<string, string[]>} */
  const perPath = new Map();
  /** @type {Map<string, Set<string>>} */
  const versions = new Map();
  const refs = new Set();
  for (const scope of [T, T2]) {
    for (const e of await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope))) {
      for (const h of [e.data?.old, e.data?.new, ...(e.refs ?? [])]) if (typeof h === 'string') refs.add(h);
      if ((e.type !== 'file.write' && e.type !== 'file.delete') || typeof e.data?.path !== 'string') continue;
      const k = `${scope}|${e.data.path}`;
      perPath.set(k, [...(perPath.get(k) ?? []), JSON.stringify([e.seq, e.type, e.data])]);
      if (scope === T) for (const h of [e.data.old, e.data.new]) if (typeof h === 'string') versions.set(e.data.path, (versions.get(e.data.path) ?? new Set()).add(h));
    }
  }
  /** @type {Map<string, string>} */
  const live = new Map();
  for (const s of [T, T2]) for (const f of await ws.list(s, '/')) { live.set(`${s}|${f.path}`, f.hash); refs.add(f.hash); }
  const listed = await store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.listBlobs());
  return { perPath, versions, refs, live, blobs: new Set(listed.map((/** @type {any} */ b) => b.hash)), sizes: new Map(listed.map((/** @type {any} */ b) => [b.hash, b.size])) };
}

/** The exact copies of F: F, and every deleted file whose stored versions are the very same. @param {Awaited<ReturnType<typeof capture>>} pre @param {string} T @param {string} F */
function copiesOf(pre, T, F) {
  const mine = pre.versions.get(F);
  return FILES.filter((p) => {
    const vs = pre.versions.get(p);
    return p === F || (vs && mine && !pre.live.has(`${T}|${p}`) && vs.size === mine.size && [...vs].every((h) => mine.has(h)));
  });
}

test(`Delete for good over ${SEEDS} random histories: exact copies go together, every other deleted file survives whole`, async () => {
  /** @type {string[]} */
  const failures = [];
  const stats = { taps: 0, freed: 0, withCopies: 0, spared: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const ops = genOps(rng(seed));
    const first = await capture(await build(ops));
    const deleted = FILES.filter((p) => first.versions.has(p) && ![...first.live.keys()].some((k) => k.endsWith(`|${p}`)));
    for (const F of deleted) {
      /** @param {string} what @param {unknown} [detail] */
      const fail = (what, detail) => failures.push(`seed ${seed} ${F}: ${what} ${JSON.stringify(detail) ?? ''} ops ${JSON.stringify(ops)}`);
      const W = await build(ops);
      const pre = await capture(W);
      const before = JSON.stringify(await snapshot(W.store));
      const free = await freeableDeleted(W.ws, W.T, F);
      if (JSON.stringify(await snapshot(W.store)) !== before) fail('the dry run changed the store');
      const copies = copiesOf(pre, W.T, F);
      if (free && JSON.stringify([...free.copies].sort()) !== JSON.stringify(copies.filter((p) => p !== F).sort())) fail('the dry run found other copies than the exact ones', { found: free.copies, copies });
      /** @type {string[]} */
      const toasts = [];
      const got = await deleteForGood({ ws: W.ws, store: W.store, notices: { toast: (/** @type {string} */ m) => toasts.push(m) } }, W.T, F, F);
      stats.taps++;
      if (Boolean(free) !== Boolean(got)) fail('the button and the tap disagree', { free, got, toasts });
      if (!got) {
        if (JSON.stringify(await snapshot(W.store)) !== before) fail('a tap that freed nothing changed the store', toasts);
        continue;
      }
      stats.freed++;
      if (copies.length > 1) stats.withCopies++;
      const post = await capture(W);
      // Only the exact copies' files go; any other path freed is a booking or plan item of their groups.
      for (const p of got) if (p.startsWith('/files/') && !copies.includes(p)) fail('freed a file that is no exact copy', p);
      for (const p of copies) if (post.perPath.has(`${W.T}|${p}`)) fail('a copy kept history', p);
      // The invariant: every other listed deleted file survives whole, history entries and every version's content.
      for (const G of FILES) {
        if (copies.includes(G) || !pre.versions.has(G) || pre.live.has(`${W.T}|${G}`)) continue;
        stats.spared++;
        if (JSON.stringify(pre.perPath.get(`${W.T}|${G}`)) !== JSON.stringify(post.perPath.get(`${W.T}|${G}`))) fail('a deleted file that is no copy lost history', G);
        for (const h of pre.versions.get(G) ?? []) if (pre.blobs.has(h) && !post.blobs.has(h)) fail('a deleted file that is no copy lost a version', { G, h });
      }
      if (JSON.stringify([...pre.live]) !== JSON.stringify([...post.live])) fail('a live file changed');
      for (const h of post.refs) if (pre.blobs.has(h) && !post.blobs.has(h)) fail('a content something still names was freed', h);
      for (const [k, entries] of pre.perPath) {
        const path = k.split('|')[1];
        if (!got.includes(path) && JSON.stringify(entries) !== JSON.stringify(post.perPath.get(k))) fail('the history of a path not freed changed', path);
      }
      const others = copies.length - 1;
      const m = (others ? new RegExp(`^Deleted .+ and ${others} other ${others === 1 ? 'copy' : 'copies'} for good\\. (\\d+) bytes? freed\\.$`) : /^Deleted .+ for good\. (\d+) bytes? freed\.$/).exec(toasts[0] ?? '');
      let bytes = 0;
      for (const [h, size] of pre.sizes) if (!post.blobs.has(h)) bytes += size;
      if (!m || Number(m[1]) !== bytes) fail('the toast does not match what was freed', { toast: toasts[0], bytes });
    }
  }
  assert.ok(stats.freed > 200 && stats.withCopies > 20 && stats.spared > 50, `the seeds cover the cases: ${JSON.stringify(stats)}`);
  assert.equal(failures.length, 0, `${failures.length} invariant failures; first: ${failures[0]}`);
});
