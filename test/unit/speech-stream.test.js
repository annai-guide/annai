import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { Speaker } from '../../src/core/voice/speaker.js';
import { fakePlatform } from './voice-fakes.js';

// Streamed voices (G3, "Streamed, sentence by sentence" and "Never stutters"): a voice type that reads its reply as it
// comes gives 16-bit PCM pieces; annai traces the clip once it has all come, holds it until the start rule says it
// won't stutter, plays it through the stream player, and gives up on a voice that fails partway, as on a whole clip.

const RATE = 1000; // samples a second: a piece of 100 samples is 0.1 s
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A fetch whose answer's body sends these pieces at these times (ms after the request), then ends, or drops where a
 * piece says fail. It stops when the request is aborted. @param {{ at: number, samples?: number, fail?: boolean }[]} pieces
 */
const slowFetch = (pieces) => async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
  const signal = init.signal;
  const t0 = Date.now();
  const body = new ReadableStream({
    async start(ctl) {
      signal?.addEventListener('abort', () => { try { ctl.error(signal.reason); } catch { /* closed */ } }, { once: true });
      for (const p of pieces) {
        await tick(t0 + p.at - Date.now());
        if (signal?.aborted) return;
        if (p.fail) return void ctl.error(new TypeError('terminated'));
        ctl.enqueue(new Uint8Array((p.samples ?? 100) * 2));
      }
      ctl.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};

/** A voice type that streams: its body's bytes as 16-bit PCM at RATE, a dropped connection a network error. */
const streams = {
  type: 'test-stream', name: 'Test streamed voice', speech: 'out', pluginId: 'test', tunables: { stream: true },
  speechRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/say`, headers: {}, body: JSON.stringify({ text: c.text }) }),
  readSpeech: async (/** @type {Response} */ res) => ({ data: new Uint8Array(await res.arrayBuffer()), mediaType: 'audio/wav' }),
  /** @param {Response} res */
  async* readSpeechStream(res) {
    const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
    for (;;) {
      /** @type {ReadableStreamReadResult<Uint8Array>} */
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        if (/** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError') throw e;
        throw new ProviderError('network', 'The connection dropped.');
      }
      if (r.done) return;
      yield { pcm: new Int16Array(r.value.buffer, r.value.byteOffset, r.value.length / 2), rate: RATE };
    }
  },
};
/** @param {any} [tunables] */
const endpoint = (tunables = {}) => ({ id: 'pv-1/voice', provider: 'pv-1', ability: 'voice', type: 'test-stream', name: 'Voice', baseUrl: 'https://voice.test/v1', headers: {}, tunables: { stream: true, ...tunables }, extraBody: {} });
const model = /** @type {any} */ ({ id: 'm-1', provider: 'pv-1', ability: 'voice', name: 'Streamer', providerId: 'tts-1', input: ['text'], prices: { perMillionChars: 10 }, tunables: {}, extraBody: {} });
/** @param {any} store */
const traced = async (store) => (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS, {}))).filter((/** @type {any} */ e) => e.type === 'net.request').map((/** @type {any} */ e) => e.data);
/** @param {AsyncIterable<Int16Array>} chunks */
const drain = async (chunks) => {
  let n = 0;
  for await (const pcm of chunks) n += pcm.length;
  return n;
};

test('a streamed voice: asked for, it resolves at its first piece with its rate; its pieces come as they arrive; it is traced once, when all of it is in, with its cost (G3)', async () => {
  const store = createMemoryStore();
  const r = await speechCall({ type: /** @type {any} */ (streams), endpoint: endpoint(), model, key: null, text: 'Hello there.', stream: true, trace: modelTrace(store, SYS),
    fetch: slowFetch([{ at: 0 }, { at: 20 }, { at: 40, samples: 50 }]) });
  assert.equal(r.clip, undefined);
  assert.equal(r.stream?.rate, RATE);
  assert.deepEqual(await traced(store), [], 'nothing traced before it has all come');
  assert.equal(await drain(/** @type {any} */ (r.stream).chunks), 250);
  const [req] = await traced(store);
  assert.equal(req.kind, 'speech-out');
  assert.equal(req.outcome, 'ok');
  assert.equal(req.format, 'streamed PCM at 1 kHz');
  assert.equal(req.bytes, 500);
  assert.ok(req.firstMs >= 0 && req.firstMs < req.ms, 'when the first audio came, and when the last did');
  assert.ok(Math.abs(req.cost - 12 * 10 / 1e6) < 1e-12, 'per character, as a whole clip');
});

test("stream off: with the voice's stream tunable off, or a caller that didn't ask, the whole clip comes, as before", async () => {
  const off = await speechCall({ type: /** @type {any} */ (streams), endpoint: endpoint({ stream: false }), model, key: null, text: 'Hi.', stream: true, fetch: slowFetch([{ at: 0 }]) });
  assert.equal(off.stream, undefined);
  assert.equal(off.clip?.data.length, 200);
  const unasked = await speechCall({ type: /** @type {any} */ (streams), endpoint: endpoint(), model, key: null, text: 'Hi.', fetch: slowFetch([{ at: 0 }]) });
  assert.equal(unasked.clip?.mediaType, 'audio/wav');
});

test('the first piece must come within the time limit, and then no gap may be longer; a slow clip of short gaps is fine', async () => {
  const store = createMemoryStore();
  const trace = modelTrace(store, SYS);
  await assert.rejects(speechCall({ type: /** @type {any} */ (streams), endpoint: endpoint(), model, key: null, text: 'Hi.', stream: true, timeoutMs: 60, trace, fetch: slowFetch([{ at: 150 }]) }),
    (e) => e instanceof ProviderError && e.kind === 'timeout');
  const gap = await speechCall({ type: /** @type {any} */ (streams), endpoint: endpoint(), model, key: null, text: 'Hi.', stream: true, timeoutMs: 60, trace, fetch: slowFetch([{ at: 0 }, { at: 200 }]) });
  await assert.rejects(drain(/** @type {any} */ (gap.stream).chunks), (e) => e instanceof ProviderError && e.kind === 'timeout' && /stopped arriving/.test(e.message));
  const slow = await speechCall({ type: /** @type {any} */ (streams), endpoint: endpoint(), model, key: null, text: 'Hi.', stream: true, timeoutMs: 60, trace,
    fetch: slowFetch([{ at: 0 }, { at: 30 }, { at: 60 }, { at: 90 }, { at: 120 }]) });
  assert.equal(await drain(/** @type {any} */ (slow.stream).chunks), 500);
  assert.deepEqual((await traced(store)).map((d) => d.outcome), ['timeout', 'timeout', 'ok']);
});

test('a stream that fails partway is traced as failed, without its cost: the sentence is paid for once, by the voice that says it', async () => {
  const store = createMemoryStore();
  const r = await speechCall({ type: /** @type {any} */ (streams), endpoint: endpoint(), model, key: null, text: 'Hello there.', stream: true, trace: modelTrace(store, SYS),
    fetch: slowFetch([{ at: 0 }, { at: 10, fail: true }]) });
  await assert.rejects(drain(/** @type {any} */ (r.stream).chunks), (e) => e instanceof ProviderError && e.kind === 'network');
  const [req] = await traced(store);
  assert.equal(req.outcome, 'network');
  assert.equal(req.cost, undefined);
});

/**
 * A stream of PCM pieces of 0.1 s at RATE, the i-th arriving at at(i) (ms, on the test's clock), failing after failAfter pieces.
 * @param {{ n: number, at: (i: number) => number, now: () => number, failAfter?: number, signal?: AbortSignal }} o
 */
function fakeStream({ n, at, now, failAfter, signal }) {
  return {
    rate: RATE,
    chunks: (async function* chunks() {
      for (let i = 0; i < n; i++) {
        if (failAfter !== undefined && i === failAfter) throw new ProviderError('network', 'The connection dropped.');
        while (now() < at(i)) {
          if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
          await tick(1);
        }
        yield Int16Array.from({ length: 100 }, () => 1000);
      }
    })(),
  };
}

/**
 * A player that records, for each piece pushed, when it was pushed and when it would start and end, on the test's clock.
 * @param {() => number} now ms
 */
function recordingPlayer(now) {
  const p = fakePlatform();
  /** @type {{ pushed: number, start: number, end: number }[][]} */
  const streams = [];
  p.player.stream = /** @type {any} */ (({ rate }) => {
    /** @type {{ pushed: number, start: number, end: number }[]} */
    const pieces = [];
    streams.push(pieces);
    let next = 0;
    let ended = false;
    let stopped = false;
    /** @type {(r: { playedMs: number }) => void} */
    let settle = () => {};
    const done = new Promise((r) => { settle = r; });
    const played = () => pieces.reduce((s, x) => s + Math.max(0, Math.min(now(), x.end) - x.start), 0);
    const timer = setInterval(() => { if (ended && now() >= next) { clearInterval(timer); settle({ playedMs: played() }); } }, 1);
    return {
      push(/** @type {Int16Array} */ pcm) {
        if (stopped) return;
        const start = Math.max(next, now());
        next = start + (pcm.length / rate) * 1000;
        pieces.push({ pushed: now(), start, end: next });
      },
      end() { ended = true; },
      stop() { stopped = true; clearInterval(timer); const r = { playedMs: played() }; settle(r); p.log.push('stream stop'); return r; },
      queued: () => pieces.length,
      done,
    };
  });
  return { p, streams };
}

test('a stream arriving at half real time starts late, and then plays without a gap (Review Focus 4)', async () => {
  const t0 = Date.now();
  const now = () => (Date.now() - t0) * 10; // the test's clock runs ten times faster than real time
  const { p, streams } = recordingPlayer(now);
  // 4 s of speech (60 characters at 15 a second), its pieces of 0.1 s arriving every 0.2 s: at half real time.
  const text = 'This sentence has sixty characters in it, as Shiori says it.';
  assert.equal(text.length, 60);
  let from = 0;
  const speaker = new Speaker({ entries: async () => [{ id: 'v1', name: 'v1', kind: 'api' }], bench: () => {}, platform: () => /** @type {any} */ (p), locale: 'en', now,
    synthesize: async (_e, _t, signal) => {
      from = now(); // arrivals timed from the stream's start, not the test's (fix pass: a loaded machine started it late)
      return fakeStream({ n: 40, at: (i) => from + 200 * i, now, signal });
    } });
  const u = speaker.begin();
  u.end(text);
  const done = await u.done;
  assert.equal(done.said, 1);
  const [pieces] = streams;
  assert.equal(pieces.length, 40);
  assert.ok(pieces[0].start - from >= 4000, `it waited for enough to be in: started ${pieces[0].start - from} ms after the stream did`);
  for (let i = 1; i < pieces.length; i++) assert.ok(pieces[i].pushed <= pieces[i - 1].end, `piece ${i} came at ${pieces[i].pushed} ms, before the one before it ended at ${pieces[i - 1].end} ms`);
});

test('on a good connection a stream starts at once, and the next sentence reads ahead while one plays', async () => {
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const { p, streams } = recordingPlayer(now);
  /** @type {string[]} */
  const asked = [];
  const speaker = new Speaker({ entries: async () => [{ id: 'v1', name: 'v1', kind: 'api' }], bench: () => {}, platform: () => /** @type {any} */ (p), locale: 'en', now,
    synthesize: async (_e, text, signal) => {
      asked.push(`${text} at ${now()}`);
      const from = now();
      return fakeStream({ n: 5, at: (i) => from + 5 * i, now, signal }); // 0.5 s of sound in 20 ms
    } });
  const u = speaker.begin();
  u.end('First thing. Second thing.');
  await u.done;
  assert.equal(streams.length, 2);
  assert.ok(streams[0][0].start < 100, `started in ${streams[0][0].start} ms`);
  assert.equal(asked.length, 2);
  assert.ok(Number(asked[1].split(' at ')[1]) < streams[0].at(-1).end, 'the second was asked for while the first played');
});

test('a stream that fails after some of its audio: its player stream stops, the voice is benched, and the same sentence goes to the next voice', async () => {
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const { p, streams } = recordingPlayer(now);
  /** @type {string[]} */
  const benched = [];
  /** @type {string[]} */
  const said = [];
  const speaker = new Speaker({
    entries: async () => [{ id: 'v1', name: 'v1', kind: /** @type {const} */ ('api') }, { id: 'v2', name: 'v2', kind: /** @type {const} */ ('api') }].filter((e) => !benched.includes(e.id)),
    bench: (id) => { benched.push(id); }, platform: () => /** @type {any} */ (p), locale: 'en', now,
    synthesize: async (entry, text, signal) => {
      said.push(`${entry.id}: ${text}`);
      const from = now();
      // v1's pieces come every 30 ms, so it has started playing (after a quarter second of measuring) when it fails at 0.45 s.
      return entry.id === 'v1' ? fakeStream({ n: 20, at: (i) => from + 30 * i, now, signal, failAfter: 15 }) : fakeStream({ n: 10, at: (i) => from + 2 * i, now, signal });
    },
  });
  const u = speaker.begin();
  u.end('Only one sentence here.');
  const done = await u.done;
  assert.deepEqual(benched, ['v1']);
  assert.deepEqual(said, ['v1: Only one sentence here.', 'v2: Only one sentence here.']);
  assert.ok(p.log.includes('stream stop'), "the failed voice's player stream stopped");
  assert.equal(streams.length, 2);
  assert.equal(streams[1].length, 10);
  assert.equal(done.said, 1);
  assert.deepEqual(done.voices, ['v1', 'v2']);
});

test('cut off mid-stream: the player stream stops at once, and what was heard is kept by the fraction played', async () => {
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const { p } = recordingPlayer(now);
  const text = 'Bixby Bridge is two miles ahead.';
  const speaker = new Speaker({ entries: async () => [{ id: 'v1', name: 'v1', kind: 'api' }], bench: () => {}, platform: () => /** @type {any} */ (p), locale: 'en', now,
    synthesize: async (_e, _t, signal) => { const from = now(); return fakeStream({ n: 20, at: (i) => from + i, now, signal }); } }); // 2 s of sound
  const u = speaker.begin();
  u.end(text);
  await tick(1000);
  u.stop();
  const done = await u.done;
  assert.ok(p.log.includes('stream stop'));
  assert.equal(done.said, 0);
  assert.ok(done.cut && done.cut.at > 0 && done.cut.at < text.length, `cut at ${done.cut?.at}, by the fraction heard`);
});

test("cut off before the stream has all come: what was heard is a fraction of the whole sentence, not of what had arrived (fix pass)", async () => {
  const t0 = Date.now();
  const now = () => (Date.now() - t0) * 10; // the test's clock runs ten times faster than real time
  const { p, streams } = recordingPlayer(now);
  // 97 characters, about 6.5 s aloud, arriving at 1.25 times real time: a piece of 0.1 s every 80 ms.
  const text = 'Bixby Bridge is two miles ahead, and the view from the pullout on the north side is the best one.';
  assert.equal(text.length, 97);
  const speaker = new Speaker({ entries: async () => [{ id: 'v1', name: 'v1', kind: 'api' }], bench: () => {}, platform: () => /** @type {any} */ (p), locale: 'en', now,
    synthesize: async (_e, _t, signal) => { const from = now(); return fakeStream({ n: 65, at: (i) => from + 80 * i, now, signal }); } });
  const u = speaker.begin();
  u.end(text);
  while (!streams[0]?.length) await tick(1);
  const started = streams[0][0].start;
  while (now() < started + 2000) await tick(1);
  u.stop();
  const done = await u.done;
  // 2 s of about 6.5: some 30 characters, back to a word; heard out of what had arrived (about 2.8 s), it would be some 65.
  assert.ok(done.cut && done.cut.at >= 20 && done.cut.at <= 36, `cut at ${done.cut?.at}: ${text.slice(0, done.cut?.at)}`);
});

test("a voice whose stream fails drops what it read ahead, unpaid: the next voice says both sentences, and the trace has each sentence paid for once (fix pass)", async () => {
  const store = createMemoryStore();
  const trace = modelTrace(store, SYS);
  const { p } = recordingPlayer(Date.now);
  /** @type {string[]} */
  const benched = [];
  const fast = [{ at: 0 }, { at: 5 }, { at: 10 }, { at: 15 }, { at: 20 }];
  const speaker = new Speaker({
    entries: async () => [{ id: 'v1', name: 'v1', kind: /** @type {const} */ ('api') }, { id: 'v2', name: 'v2', kind: /** @type {const} */ ('api') }].filter((e) => !benched.includes(e.id)),
    bench: (id) => { benched.push(id); }, platform: () => /** @type {any} */ (p), locale: 'en',
    synthesize: async (entry, text, signal) => {
      // v1: the first sentence drops after half a second; the second, read ahead meanwhile, would take 0.8 s to come.
      const pieces = entry.id === 'v2' ? fast : text.startsWith('First')
        ? [...Array.from({ length: 10 }, (_, i) => ({ at: 50 * i })), { at: 500, fail: true }]
        : Array.from({ length: 20 }, (_, i) => ({ at: 40 * i }));
      const r = await speechCall({ type: /** @type {any} */ (streams), endpoint: endpoint(), model: { ...model, name: entry.id }, key: null, text, stream: true, trace, signal, fetch: slowFetch(pieces) });
      return /** @type {any} */ (r.stream ?? r.clip);
    },
  });
  const u = speaker.begin();
  u.end('First thing. Second thing.');
  const done = await u.done;
  assert.equal(done.said, 2);
  assert.deepEqual(benched, ['v1']);
  await tick(900); // anything v1 still read would be in by now
  const reqs = await traced(store);
  assert.deepEqual(reqs.filter((d) => d.cost !== undefined).map((d) => `${d.model} ${d.chars}`).sort(), ['v2 12', 'v2 13'], 'each sentence paid for once, by the voice that said it');
  assert.deepEqual(reqs.filter((d) => d.model === 'v1').map((d) => d.outcome).sort(), ['cancelled', 'network'], "v1's read-ahead stopped, traced cancelled");
});

/** A player whose clock never moves, as an iPhone's suspended audio: nothing it is given plays, or ends. @param {{ running?: boolean }} [o] */
function stuckPlayer({ running } = {}) {
  const p = fakePlatform();
  p.player.stream = /** @type {any} */ (() => ({
    push() {}, end() {}, queued: () => 1, done: new Promise(() => {}),
    stop() { p.log.push('stream stop'); return { playedMs: 0 }; },
    ...(running === undefined ? {} : { running: Promise.resolve(running) }),
  }));
  return p;
}

test('a stream the player never plays (its audio suspended) gives up a moment after it should have ended, as a page that may not play sound: no utterance waits for ever (fix pass)', { timeout: 5000 }, async () => {
  const p = stuckPlayer();
  /** @type {string[]} */
  const blocked = [];
  const speaker = new Speaker({ entries: async () => [{ id: 'v1', name: 'v1', kind: 'api' }], bench: () => {}, platform: () => /** @type {any} */ (p), locale: 'en', stallMs: 100,
    onBlocked: () => { blocked.push('blocked'); },
    synthesize: async (_e, _t, signal) => fakeStream({ n: 3, at: () => 0, now: Date.now, signal }) }); // 0.3 s of sound, all at once
  const u = speaker.begin();
  u.end('One sentence. And another.');
  const t0 = Date.now();
  const done = await u.done;
  assert.ok(Date.now() - t0 < 1500, `it gave up in ${Date.now() - t0} ms`);
  assert.equal(done.failed, 'blocked', 'shown on screen instead, as a whole clip the page may not play');
  assert.equal(done.said, 0);
  assert.ok(p.log.includes('stream stop'));
  assert.deepEqual(blocked, ['blocked'], 'the Voice is told, so the next tap unlocks sound again');
  // A player that says its audio isn't running gives up at once.
  const q = stuckPlayer({ running: false });
  const s2 = new Speaker({ entries: async () => [{ id: 'v1', name: 'v1', kind: 'api' }], bench: () => {}, platform: () => /** @type {any} */ (q), locale: 'en',
    synthesize: async (_e, _t, signal) => fakeStream({ n: 3, at: () => 0, now: Date.now, signal }) });
  const u2 = s2.begin();
  u2.end('Hello.');
  const t1 = Date.now();
  assert.equal((await u2.done).failed, 'blocked');
  assert.ok(Date.now() - t1 < 500, 'without waiting for the watchdog');
});
