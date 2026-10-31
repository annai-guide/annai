// Claude's thinking between the steps of a turn, end to end through the loop (the keep-reasoning design, "Tests" 1–12 and 14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { useClock } from './clock.js';
import { anthropicStandIn } from '../fakes/anthropic-binding.js';
import { Agent, KEPT_SENT_MAX } from '../../src/core/agent/loop.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { setToolSwitch } from '../../src/core/agent/tools.js';
import { readConfig, saveRoles } from '../../src/core/llm/config.js';
import { storedTexts } from '../../src/core/agent/log.js';
import { exportArchive, PRESETS } from '../../src/core/archive.js';
import { readZip } from '../../src/core/zip.js';

const AT = { type: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', tunables: { cacheTtl: '5m' } };
const PLACES = ['/trip/', '/trip/notes/', '/me/', '/trip/files/', '/trip/plan/', '/me/notes/', '/trip/a/', '/trip/b/'];
const SONNET = { providerId: 'claude-sonnet-5-5', contextWindow: 1000000, input: ['text', 'image', 'pdf'] };
let n = 0;
/** A tool call. @param {string} name @param {any} input */
const use = (name, input = {}) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });
/** What the last message holds: its words, and the tools whose results it brings. @param {any} body */
function last(body) {
  const m = body.messages.at(-1);
  const called = new Map(body.messages.flatMap((/** @type {any} */ x) => x.content).filter((/** @type {any} */ b) => b.type === 'tool_use').map((/** @type {any} */ b) => [b.id, b.name]));
  return {
    role: m.role,
    text: m.content.filter((/** @type {any} */ b) => b.type === 'text').map((/** @type {any} */ b) => b.text).join('\n'),
    results: m.content.filter((/** @type {any} */ b) => b.type === 'tool_result').map((/** @type {any} */ b) => called.get(b.tool_use_id)),
  };
}
/** A body without its cache markers. @param {any} x */
const bare = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)));
/** Every thinking block a body sends back. @param {any} body */
const thoughts = (body) => body.messages.flatMap((/** @type {any} */ m) => m.content.filter((/** @type {any} */ b) => b.type === 'thinking'));
/** The kept now blocks a body holds: every <now> text but the tail. @param {any} body */
const nows = (body) => body.messages.flatMap((/** @type {any} */ m) => m.content.filter((/** @type {any} */ b) => b.type === 'text' && b.text.startsWith('<now>'))).slice(0, -1);
/** A turn's requests only grow at the end: each earlier one, less its cache markers, begins the next. @param {any[]} bodies */
function appendOnly(bodies) {
  for (let i = 1; i < bodies.length; i++) {
    const [a, b] = [bare(bodies[i - 1]), bare(bodies[i])];
    assert.deepEqual(b.system, a.system, `request ${i + 1}: the same system text`);
    assert.deepEqual(b.tools, a.tools, `request ${i + 1}: the same tools`);
    // A paused reply's continuation goes into the message it continues.
    const end = a.messages.length - 1;
    assert.deepEqual(b.messages.slice(0, end), a.messages.slice(0, end), `request ${i + 1} begins with request ${i}, now block and all`);
    assert.deepEqual(b.messages[end].content.slice(0, a.messages[end].content.length), a.messages[end].content, `request ${i + 1}'s message ${end}`);
  }
}
/** Kokoro's three steps for one question: list, read, then speak. @param {any} body */
const threeSteps = (body) => {
  const { results, text } = last(body);
  if (/housekeeping/.test(text)) return [{ type: 'text', text: 'Summary.' }];
  if (results.includes('read')) return [use('speak', { text: 'Your hotel is in Monterey.' }), use('sleep')];
  if (results.includes('list')) return [use('read', { path: '/trip/notes/hotel.md' })];
  if (results.includes('speak') || results.includes('sleep')) return [use('sleep')];
  return [use('list', { path: '/trip/' })];
};
/** @param {any} k */
const turns = async (k) => (await k.events(['model.turn'])).filter((/** @type {any} */ e) => e.data.tag === 'conversation');
/** @param {any} k */
const requests = async (k) => (await k.events(['net.request'])).filter((/** @type {any} */ e) => e.data.kind === 'model');

test('1. a three-step Kokoro turn on Claude: requests 2 and 3 carry the earlier replies as Claude wrote them and the now blocks where they were sent; nothing refused or fell back', async (t) => {
  useClock(t);
  const claude = anthropicStandIn(threeSteps);
  const k = await agentKit([{ ability: AT }], { models: [SONNET], fetch: claude.fetch });
  await k.ws.write(k.trip, '/notes/hotel.md', 'Hotel in Monterey.', { author: 'user' });
  k.agent.send('Where is our hotel?');
  await k.agent.idle();
  assert.deepEqual(claude.refused, []);
  assert.equal(claude.bodies.length, 3);
  appendOnly(claude.bodies);
  assert.deepEqual(claude.bodies.map((b) => thoughts(b).length), [0, 1, 2]);
  assert.deepEqual(claude.bodies.map((b) => nows(b).length), [0, 1, 2]);
  // The now block kept is the tail request 1 ended with.
  assert.equal(nows(claude.bodies[1])[0].text, claude.bodies[0].messages.at(-1).content.at(-1).text);
  assert.ok((await turns(k)).every((e) => e.data.attempts.length === 1 && e.data.attempts[0].outcome === 'ok'), 'nothing fell back');
  assert.deepEqual((await requests(k)).map((e) => e.data.natives?.sent ?? 0), [0, 1, 2]);
  assert.deepEqual(k.notices, []);
});

test('2. Shiori as one half: a line logged during a call goes after the reply, and nothing is refused', async (t) => {
  useClock(t);
  const claude = anthropicStandIn(threeSteps);
  /** @type {any} */
  let k = null;
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    // While the second request is being answered, a line of her own is logged (a reminder annai showed itself).
    if (claude.bodies.length === 1) await k.agent.log({ type: 'reminder', actor: 'system', data: {}, texts: [['text', 'Lunch at noon']] });
    return claude.fetch(url, init);
  };
  k = await agentKit([{ ability: AT }], { models: [SONNET], fetch });
  await k.ws.write(k.trip, '/notes/hotel.md', 'Hotel in Monterey.', { author: 'user' });
  k.agent.send('Where is our hotel?');
  await k.agent.idle();
  assert.deepEqual(claude.refused, []);
  assert.equal(claude.bodies.length, 3);
  appendOnly(claude.bodies);
  const line = JSON.stringify(claude.bodies[2].messages.at(-1));
  assert.match(line, /Lunch at noon/, 'it follows the reply it came during');
  assert.equal(thoughts(claude.bodies[2]).length, 2);
});

test('3. the next turn carries no thinking or now block from the one before, and is marked where that turn began; after a six-step turn it reads the cache there', async (t) => {
  useClock(t);
  let steps = 0;
  const claude = anthropicStandIn((body) => {
    const { results, text } = last(body);
    if (/Thanks/.test(text) && !results.length) return [use('speak', { text: 'Enjoy!' }), use('sleep')];
    if (results.includes('speak') || results.includes('sleep')) return [use('sleep')];
    // Six steps: five lookups, then the answer.
    return ++steps < 6 ? [use('list', { path: PLACES[steps] })] : [use('speak', { text: 'Done.' }), use('sleep')];
  });
  const k = await agentKit([{ ability: AT }], { models: [SONNET], fetch: claude.fetch });
  k.agent.send('Look around, please.');
  await k.agent.idle();
  const first = claude.bodies.length;
  assert.ok(first >= 6);
  appendOnly(claude.bodies);
  k.agent.send('Thanks!');
  await k.agent.idle();
  const next = claude.bodies[first];
  assert.deepEqual(claude.refused, []);
  assert.equal(thoughts(next).length, 0, 'no thinking from the turn before');
  assert.equal(nows(next).length, 0, 'no now block from the turn before');
  // Three marks: the system, where the last turn began (its first message, as its first request marked it), and the end.
  assert.equal(JSON.stringify(next).split('cache_control').length - 1, 3);
  const marked = next.messages.findIndex((/** @type {any} */ m) => m.content.some((/** @type {any} */ b) => b.cache_control));
  assert.equal(marked, 0, 'where the previous turn began');
  assert.deepEqual(bare(next.messages[0]), { ...bare(claude.bodies[0].messages[0]), content: bare(claude.bodies[0].messages[0]).content.slice(0, -1) }, 'as that request sent it, less its tail');
  assert.ok(claude.usage[first].cache_read_input_tokens > 0, 'the next turn reads the cache where the last began');
  // Within the turn, every step after the first read from the cache.
  assert.ok(claude.usage.slice(1, first).every((u) => u.cache_read_input_tokens > 0));
});

test('4. Koe on Claude: wait, the answer, speak: its second request carries its first step\'s thinking, the now block unescaped; nothing refused or fell back', async (t) => {
  useClock(t);
  const claude = anthropicStandIn((body) => {
    const { results } = last(body);
    if (results.includes('wait')) return [use('speak', { text: 'Monterey it is.' }), use('sleep')];
    if (results.length) return [use('sleep')];
    return [use('wait', { seconds: 60 })];
  });
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { koe: { type: { ability: AT }, model: SONNET }, fetch: claude.fetch });
  k.agent.send('Where should we stay?');
  await until(() => k.agent.koe.waiting, 3000);
  k.agent.send('Monterey');
  await k.agent.idle();
  assert.deepEqual(claude.refused, []);
  const koe = claude.bodies.filter((b) => b.model === 'claude-sonnet-5-5');
  assert.ok(koe.length >= 2);
  appendOnly(koe.slice(0, 2));
  assert.equal(thoughts(koe[1]).length, 1);
  assert.equal(nows(koe[1])[0].text, koe[0].messages.at(-1).content.at(-1).text, 'as it was sent, not escaped');
  assert.match(nows(koe[1])[0].text, /^<now>/);
  const said = (await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text);
  assert.ok(said.includes('Monterey it is.'));
  assert.ok((await k.events(['model.turn'])).filter((/** @type {any} */ e) => e.data.tag === 'koe').every((/** @type {any} */ e) => e.data.attempts.every((/** @type {any} */ a) => a.outcome === 'ok')));
});

test("5. two halves on Claude, then Summarize now: tidy-up's system text is Kokoro's, byte for byte; nothing refused", async (t) => {
  useClock(t);
  const claude = anthropicStandIn((body) => {
    const { text, results } = last(body);
    if (/housekeeping/.test(text)) return [{ type: 'text', text: 'The user asked about Nepenthe.' }];
    if (body.model === 'claude-sonnet-5-5') return results.length ? [use('sleep')] : [use('speak', { text: 'Hi!' }), use('tell_kokoro', { text: 'Anything on Nepenthe?' }), use('sleep')];
    return results.length ? [use('sleep')] : [use('tell_koe', { text: 'Nepenthe is open till 10.' })];
  });
  const k = await agentKit([{ ability: AT }], { koe: { type: { ability: AT }, model: SONNET }, models: [{ providerId: 'claude-opus-5-5', contextWindow: 1000000 }], fetch: claude.fetch });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  k.agent.send('Thanks!');
  await k.agent.idle();
  assert.equal(await k.agent.kokoro.summarizeNow(), 'done');
  assert.deepEqual(claude.refused, []);
  const opus = claude.bodies.filter((b) => b.model === 'claude-opus-5-5');
  const tidy = opus.find((b) => /housekeeping/.test(last(b).text));
  const turn = opus.find((b) => !/housekeeping/.test(last(b).text));
  assert.ok(tidy && turn);
  assert.deepEqual(bare(tidy.system), bare(turn.system), "Kokoro's own instructions");
  assert.deepEqual(tidy.tools, turn.tools);
});

test("6. a photo past the model's limit mid-turn: no thinking from there to the turn's end, nothing refused, and the request says it changed", async (t) => {
  useClock(t);
  const claude = anthropicStandIn((body) => {
    const { results } = last(body);
    if (results.includes('read')) return [use('list', { path: '/trip/' })];
    if (results.includes('list')) return [use('speak', { text: 'Two photos.' }), use('sleep')];
    if (results.length) return [use('sleep')];
    return [use('read', { path: '/trip/files/q.webp' })];
  });
  const k = await agentKit([{ ability: AT }], { models: [{ ...SONNET, images: { maxCount: 1 } }], fetch: claude.fetch });
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
  await k.ws.write(k.trip, '/files/q.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.deepEqual(claude.refused, []);
  assert.ok(claude.bodies.length >= 3);
  assert.deepEqual(claude.bodies.slice(1).map((b) => thoughts(b).length), claude.bodies.slice(1).map(() => 0), 'none after the change');
  const natives = (await requests(k)).map((e) => e.data.natives);
  assert.deepEqual(natives[1], { sent: 0, changed: true });
  assert.ok(natives.slice(2).every((x) => x === undefined), 'none kept after it');
});

test('7. Claude refuses the thinking once: the same model again without it, no other model; the Trace has the refused attempt; the rest of the turn sends none', async (t) => {
  useClock(t);
  const claude = anthropicStandIn(threeSteps);
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (claude.bodies.length === 1) claude.refuseOnce();
    return claude.fetch(url, init);
  };
  const k = await agentKit([{ ability: AT }, [{ text: 'never asked' }]], { models: [SONNET], fetch });
  await k.ws.write(k.trip, '/notes/hotel.md', 'Hotel in Monterey.', { author: 'user' });
  k.agent.send('Where is our hotel?');
  await k.agent.idle();
  assert.equal(claude.refused.length, 1);
  assert.equal(k.requests.length, 0, 'the other model was never asked');
  const second = (await turns(k))[1];
  assert.deepEqual(second.data.attempts.map((/** @type {any} */ a) => a.outcome), ['reasoning', 'ok']);
  assert.match(second.data.attempts[0].error, /signature/);
  assert.equal(k.llm.bench.until('m-0'), 0, 'it rests not');
  assert.deepEqual(claude.bodies.slice(2).map((b) => thoughts(b).length), claude.bodies.slice(2).map(() => 0));
  assert.deepEqual(k.notices, []);
});

test('8. a paused turn with server tools: the continuation ends with her own message, has no tail, and carries the reply as it came; then one assistant message holds both, and the next step goes through', async (t) => {
  useClock(t);
  const search = [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'nepenthe hours' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://www.nepenthe.com/', title: 'Nepenthe', encrypted_content: 'EqgfCio' }] },
  ];
  const claude = anthropicStandIn((body) => {
    const l = last(body);
    if (l.role === 'assistant') return [{ type: 'text', text: 'Open till 10.' }, use('speak', { text: 'Open till 10.' })];
    if (l.results.includes('speak')) return [use('sleep')];
    if (l.results.length) return [use('sleep')];
    return { content: search, stop: 'pause_turn' };
  });
  const k = await agentKit([{ ability: AT }], { models: [SONNET], fetch: claude.fetch });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.deepEqual(claude.refused, []);
  const [, cont, after] = claude.bodies;
  assert.equal(cont.messages.at(-1).role, 'assistant');
  assert.ok(!JSON.stringify(cont.messages.at(-1)).includes('<now>'), 'no tail');
  assert.deepEqual(bare(cont.messages.at(-1).content).slice(1), search, 'as it came');
  const assistants = after.messages.filter((/** @type {any} */ m) => m.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.deepEqual(assistants[0].content.map((/** @type {any} */ b) => b.type), ['thinking', 'server_tool_use', 'web_search_tool_result', 'thinking', 'text', 'tool_use']);
  appendOnly(claude.bodies);
});

test('9. a fallback mid-turn to another model and back: the other model gets no native or kept now block; Claude gets its own', async (t) => {
  useClock(t);
  const claude = anthropicStandIn(threeSteps);
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (claude.bodies.length === 1 && !claude.refused.length) {
      claude.bodies.push(JSON.parse(String(init.body)));
      claude.refused.push('too long once');
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 999999 tokens > 200000 maximum' } }), { status: 400 });
    }
    return claude.fetch(url, init);
  };
  // The other model answers one step, then fails, so the turn goes back to Claude.
  const k = await agentKit([{ ability: AT }, [{ toolCalls: [{ name: 'read', input: { path: '/trip/notes/hotel.md' } }] }, { error: 'bad-request', status: 400, message: 'Not now.' }]], { models: [SONNET], fetch });
  await k.ws.write(k.trip, '/notes/hotel.md', 'Hotel in Monterey.', { author: 'user' });
  k.agent.send('Where is our hotel?');
  await k.agent.idle();
  const other = k.sent['model-1'];
  assert.ok(other.length >= 1);
  assert.ok(!JSON.stringify(other).includes('"native"') && !other.some((/** @type {any} */ r) => r.messages.some((/** @type {any} */ m) => m.parts.some((/** @type {any} */ p) => p.now))), 'exactly as before');
  const back = claude.bodies[2];
  assert.equal(thoughts(back).length, 1, "Claude's own reply as it came");
  assert.equal(nows(back).length, 1, 'the now block before it, not the one before the other model');
  assert.deepEqual(claude.refused, ['too long once']);
});

test("10. a tool switched off between steps: the tools stay, its call is refused in words, the next turn leaves it out; a role's level changed keeps the turn's", async (t) => {
  useClock(t);
  const claude = anthropicStandIn((body) => {
    const { results, text } = last(body);
    if (/Again/.test(text) && !results.length) return [use('speak', { text: 'Ok.' }), use('sleep')];
    if (results.includes('list') && results.length === 1 && body.messages.length < 5) return [use('list', { path: '/trip/' })];
    if (results.includes('list')) return [use('speak', { text: 'Done.' }), use('sleep')];
    if (results.length) return [use('sleep')];
    return [use('list', { path: '/trip/' })];
  });
  /** @type {any} */
  let k = null;
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (claude.bodies.length === 1) {
      await setToolSwitch(k.ws, 'list', false);
      const cfg = await readConfig(k.ws);
      await saveRoles(k.ws, { ...cfg.roles, main: { ...cfg.roles.main, level: 'high' } });
    }
    return claude.fetch(url, init);
  };
  const levels = { low: { output_config: { effort: 'low' } }, medium: { output_config: { effort: 'medium' } }, high: { output_config: { effort: 'high' } } };
  k = await agentKit([{ ability: AT }], { models: [{ ...SONNET, reasoning: levels }], fetch });
  k.agent.send('Look around.');
  await k.agent.idle();
  const turn = claude.bodies.length;
  appendOnly(claude.bodies);
  assert.ok(claude.bodies.every((b) => b.output_config?.effort === 'medium'), "the turn's level");
  const [, second] = (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === 'list');
  assert.equal(second.data.ok, false);
  assert.match((await storedTexts(k.store, second)).content ?? second.data.content, /switched list off/);
  k.agent.send('Again');
  await k.agent.idle();
  const next = claude.bodies[turn];
  assert.ok(!next.tools.some((/** @type {any} */ x) => x.name === 'list'), 'the next turn leaves it out');
  assert.equal(next.output_config?.effort, 'high', 'and has the new level');
  assert.deepEqual(claude.refused, []);
});

test('11. a reload mid-turn, after step 1\'s results: the catch-up turn sends no thinking or now block from before, and nothing is refused', async (t) => {
  useClock(t);
  const claude = anthropicStandIn(threeSteps);
  /** @type {(() => void) | null} */
  let reached = null;
  const hung = new Promise((r) => { reached = () => r(undefined); });
  /** @type {(e: unknown) => void} */
  let gone = () => {};
  /** @type {any} */
  let k = null;
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (claude.bodies.length === 1 && !k.reloaded) {
      // The page goes while the second request is under way.
      reached?.();
      return new Promise((_, reject) => { gone = reject; });
    }
    return claude.fetch(url, init);
  };
  k = await agentKit([{ ability: AT }], { models: [SONNET], fetch });
  await k.ws.write(k.trip, '/notes/hotel.md', 'Hotel in Monterey.', { author: 'user' });
  k.agent.send('Where is our hotel?');
  await hung;
  k.reloaded = true;
  k.agent.leaving();
  const again = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, timeZone: () => 'UTC', secondMs: 10 });
  again.addLoopTools(selfTools(again));
  const before = claude.bodies.length;
  await again.open(k.trip);
  await again.idle();
  // The old page's request ends as a page that left: nothing more of it.
  gone(new DOMException('gone', 'AbortError'));
  await k.agent.idle();
  const after = claude.bodies.slice(before);
  assert.ok(after.length >= 1, 'a catch-up turn ran');
  assert.equal(thoughts(after[0]).length, 0);
  assert.equal(nows(after[0]).length, 0);
  assert.deepEqual(claude.refused, []);
});

test(`12. a long turn that has sent ${KEPT_SENT_MAX / 1024} KB of kept thinking in all: from there, no thinking, once (a request may carry more than 32 KB)`, async (t) => {
  useClock(t);
  let steps = 0;
  const claude = anthropicStandIn((body) => {
    const { results } = last(body);
    if (results.includes('speak') || results.includes('sleep')) return [use('sleep')];
    // Each step adds a 20 KB signature: requests carry 20, 40, 60, 80 and 100 KB, 300 KB in all; the sixth step's 120 KB passes 360 KB.
    return ++steps < 8 ? [{ type: 'thinking', pad: 20 * 1024 }, use('list', { path: PLACES[steps] })] : [use('speak', { text: 'Done.' }), use('sleep')];
  });
  const k = await agentKit([{ ability: AT }], { models: [SONNET], fetch: claude.fetch });
  k.agent.send('Look around, slowly.');
  await k.agent.idle();
  const counts = claude.bodies.map((b) => thoughts(b).length);
  // Each step's two blocks (its own and the big one) until the total passes the limit after the sixth step; none after.
  assert.deepEqual(counts.slice(0, 8), [0, 2, 4, 6, 8, 10, 0, 0]);
  assert.deepEqual(claude.refused, []);
});

test('12b. a big server-tool result with small thinking is not thinking: the turn keeps sending its thinking (the limit counts what a native adds beyond the parts it covers)', async (t) => {
  useClock(t);
  // About 70 KB of search results, as a web_search_tool_result carries them (encrypted page content).
  const results = Array.from({ length: 7 }, (_, i) => ({ type: 'web_search_result', url: `https://example.com/${i}`, title: `Result ${i}`, encrypted_content: 'E'.repeat(10_000), page_age: null }));
  let step = 0;
  const claude = anthropicStandIn(() => {
    step++;
    if (step === 1) return [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'museum hours' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: results },
      use('list', { path: '/trip/' }),
    ];
    if (step === 2) return [use('list', { path: '/trip/notes/' })];
    if (step === 3) return [use('speak', { text: 'Open 9 to 5.' }), use('sleep')];
    return [use('sleep')];
  });
  const k = await agentKit([{ ability: AT }], { models: [SONNET], fetch: claude.fetch });
  k.agent.send('When does the museum open?');
  await k.agent.idle();
  assert.deepEqual(claude.refused, []);
  assert.ok(JSON.stringify(claude.bodies[1]).length > 70_000, 'the result is in the request');
  assert.deepEqual(claude.bodies.slice(0, 3).map((b) => thoughts(b).length), [0, 1, 2]);
});

test("14. no native, signature or reasoning_details is stored: not in the log, its texts, the Trace, a backup, or an annai.llm reply", async (t) => {
  useClock(t);
  const claude = anthropicStandIn(threeSteps);
  const k = await agentKit([{ ability: AT }], { models: [SONNET], fetch: claude.fetch });
  await k.ws.write(k.trip, '/notes/hotel.md', 'Hotel in Monterey.', { author: 'user' });
  k.agent.send('Where is our hotel?');
  await k.agent.idle();
  const signatures = [...new Set(claude.bodies.flatMap((b) => thoughts(b).map((/** @type {any} */ x) => String(x.signature))))];
  assert.ok(signatures.length >= 2, 'thinking went back');
  /** @param {string} where @param {string} text */
  const clean = (where, text) => {
    for (const s of signatures) assert.ok(!text.includes(s), `${where} holds a signature`);
    assert.ok(!text.includes('"native"') && !text.includes('reasoning_details'), `${where} holds a native`);
  };
  for (const e of await k.events()) clean(`${e.type}`, JSON.stringify(e) + JSON.stringify(await storedTexts(k.store, e)));
  const { blob } = await exportArchive(k.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  for (const [name, bytes] of await readZip(blob)) clean(name, new TextDecoder().decode(bytes));
  const r = await k.llm.call({ role: 'main', request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] }, record: { tag: 'plugin:test' } });
  assert.equal(r.reply.native, undefined, "a plugin's call never gets one");
});

// Claude through OpenRouter (the design §9; tests 13 and 13b).

const OR = { type: 'chat-completions', baseUrl: 'https://openrouter.ai/api/v1', tunables: { reasoningField: 'reasoning', requireTool: false, cacheMarkers: ['anthropic/'] } };
const OR_SONNET = { providerId: 'anthropic/claude-sonnet-5.5', contextWindow: 1000000, input: ['text', 'image', 'pdf'], cacheTtls: ['5m', '1h'] };
/** Kokoro's three steps, through OpenRouter: what the last chat messages bring. @param {any} body */
function orSteps(body) {
  const lastCall = body.messages.flatMap((/** @type {any} */ m) => m.tool_calls ?? []).at(-1)?.function?.name;
  const lastUser = JSON.stringify(body.messages.at(-1).content);
  if (/Thanks/.test(lastUser) && lastCall === 'sleep') return { calls: [{ name: 'speak', input: { text: 'Enjoy!' } }, { name: 'sleep', input: {} }] };
  if (lastCall === 'read') return { calls: [{ name: 'speak', input: { text: 'Monterey.' } }, { name: 'sleep', input: {} }] };
  if (lastCall === 'list') return { calls: [{ name: 'read', input: { path: '/trip/notes/hotel.md' } }] };
  if (lastCall === 'speak' || lastCall === 'sleep') return { calls: [{ name: 'sleep', input: {} }] };
  return { calls: [{ name: 'list', input: { path: '/trip/' } }] };
}
/** A chat body without its cache markers. @param {any} x */
const orBare = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)));

test("13. a three-step Kokoro turn through OpenRouter's Claude: requests 2 and 3 carry reasoning_details as they came, the kept now block as the tail was written; nothing refused", async (t) => {
  useClock(t);
  const { openRouterStandIn } = await import('../fakes/openrouter-claude.js');
  const or = openRouterStandIn(orSteps);
  const k = await agentKit([{ ability: OR }], { models: [OR_SONNET], fetch: or.fetch });
  await k.ws.write(k.trip, '/notes/hotel.md', 'Hotel in Monterey.', { author: 'user' });
  k.agent.send('Where is our hotel?');
  await k.agent.idle();
  assert.deepEqual(or.refused, []);
  assert.equal(or.bodies.length, 3);
  for (let i = 1; i < 3; i++) {
    const [a, b] = [orBare(or.bodies[i - 1]), orBare(or.bodies[i])];
    assert.deepEqual(b.messages.slice(0, a.messages.length), a.messages, `request ${i + 1} begins with request ${i}`);
  }
  const details = (/** @type {any} */ b) => b.messages.filter((/** @type {any} */ m) => m.reasoning_details).map((/** @type {any} */ m) => m.reasoning_details);
  assert.deepEqual(details(or.bodies[2]).length, 2);
  assert.deepEqual(details(or.bodies[2])[0], [{ type: 'reasoning.text', text: 'Thinking it over.', format: 'anthropic-claude-v1', index: 0, signature: details(or.bodies[1])[0][0].signature }]);
  assert.ok((await turns(k)).every((e) => e.data.attempts.length === 1 && e.data.attempts[0].outcome === 'ok'));
});

test(`13c. through OpenRouter a native covers no parts: a big tool input every step doesn't hide the thinking, which stops the turn's thinking once it has sent ${KEPT_SENT_MAX / 1024} KB in all`, async (t) => {
  useClock(t);
  const { openRouterStandIn } = await import('../fakes/openrouter-claude.js');
  let steps = 0;
  const or = openRouterStandIn((body) => {
    const lastCall = body.messages.flatMap((/** @type {any} */ m) => m.tool_calls ?? []).at(-1)?.function?.name;
    if (lastCall === 'speak' || lastCall === 'sleep') return { calls: [{ name: 'sleep', input: {} }] };
    // Each step: a 20 KB signature (300 KB sent in all after five steps, 420 KB after six), and a 20 KB tool input that the reply's parts carry as well.
    return ++steps < 8 ? { pad: 20 * 1024, calls: [{ name: 'list', input: { path: PLACES[steps], note: 'n'.repeat(20_000) } }] } : { calls: [{ name: 'speak', input: { text: 'Done.' } }, { name: 'sleep', input: {} }] };
  });
  const k = await agentKit([{ ability: OR }], { models: [OR_SONNET], fetch: or.fetch });
  k.agent.send('Look around, slowly.');
  await k.agent.idle();
  const kept = (/** @type {any} */ b) => b.messages.filter((/** @type {any} */ m) => m.reasoning_details).length;
  assert.deepEqual(or.bodies.slice(0, 8).map(kept), [0, 1, 2, 3, 4, 5, 0, 0]);
  assert.deepEqual(or.refused, []);
});

test("13b. cache markers through OpenRouter's Claude: the system, the end and cacheAt, with the hour's ttl; every message the same bytes from one request to the next; reads on steps 2 and 3 and the next turn's first; another Chat Completions model as before", async (t) => {
  useClock(t);
  const { openRouterStandIn } = await import('../fakes/openrouter-claude.js');
  const or = openRouterStandIn(orSteps);
  const k = await agentKit([{ ability: OR }], { models: [OR_SONNET], fetch: or.fetch });
  await k.ws.write(k.trip, '/notes/hotel.md', 'Hotel in Monterey.', { author: 'user' });
  k.agent.send('Where is our hotel?');
  await k.agent.idle();
  const first = or.bodies.length;
  k.agent.send('Thanks!');
  await k.agent.idle();
  const marks = (/** @type {any} */ b) => JSON.stringify(b).split('"cache_control":{"type":"ephemeral","ttl":"1h"}').length - 1;
  assert.equal(marks(or.bodies[0]), 2, 'the system and the end');
  assert.equal(marks(or.bodies[first]), 3, 'and where the last turn began');
  assert.equal(or.bodies[0].messages[0].content[0].cache_control.ttl, '1h');
  for (const b of or.bodies) for (const m of b.messages) if (m.content !== null) assert.ok(Array.isArray(m.content), 'every content an array of blocks');
  assert.ok(or.usage.slice(1, first).every((u) => u.prompt_tokens_details.cached_tokens > 0), 'steps 2 and 3 read the cache');
  assert.ok(or.usage[first].prompt_tokens_details.cached_tokens > 0, "the next turn's first request too");
  // OpenRouter's sticky routing key (its prompt-caching guide): the same on every step of a turn, a short non-personal hash.
  const sessions = or.bodies.map((b) => b.session_id);
  assert.match(sessions[0], /^[A-Za-z0-9_-]{1,256}$/);
  assert.ok(sessions.slice(0, first).every((x) => x === sessions[0]), 'one for the whole turn');
  assert.ok(!JSON.stringify(sessions).includes('Monterey') && !JSON.stringify(sessions).includes(k.trip), 'nothing of the conversation in it');
  const turn2 = (await requests(k)).at(-1);
  assert.ok(turn2.data.usage.cacheRead > 0, 'counted as a cache read');
  assert.deepEqual(or.refused, []);
});

test('13b. a Chat Completions model outside cacheMarkers sends what it always sent: string content and no marks', async (t) => {
  useClock(t);
  const { openRouterStandIn } = await import('../fakes/openrouter-claude.js');
  const or = openRouterStandIn(orSteps);
  const k = await agentKit([{ ability: { ...OR, tunables: { ...OR.tunables, cacheMarkers: [] } } }], { models: [{ ...OR_SONNET, providerId: 'openai/gpt-6' }], fetch: or.fetch });
  await k.ws.write(k.trip, '/notes/hotel.md', 'Hotel in Monterey.', { author: 'user' });
  k.agent.send('Where is our hotel?');
  await k.agent.idle();
  assert.ok(or.bodies.length >= 2);
  for (const b of or.bodies) {
    assert.ok(!JSON.stringify(b).includes('cache_control'));
    assert.equal(typeof b.messages[0].content, 'string');
    assert.ok(!('session_id' in b), 'no session_id for a model outside cacheMarkers');
  }
});

test("the Trace's line for a request says how many earlier steps' thinking went back, or that none went as something before it changed", async () => {
  const { traceSummary } = await import('../../src/ui/screens/trace.js');
  const line = (/** @type {any} */ natives) => traceSummary({ type: 'net.request', data: { model: 'Claude Sonnet 5.5', outcome: 'ok', status: 200, ms: 900, bytes: 24000, natives } });
  assert.equal(line({ sent: 2, changed: false }), 'Claude Sonnet 5.5 · ok (200) · 900 ms · 23 kB sent · thinking of 2 earlier steps sent back');
  assert.equal(line({ sent: 1, changed: false }), 'Claude Sonnet 5.5 · ok (200) · 900 ms · 23 kB sent · thinking of 1 earlier step sent back');
  assert.equal(line({ sent: 0, changed: true }), 'Claude Sonnet 5.5 · ok (200) · 900 ms · 23 kB sent · earlier thinking not sent: something before it changed');
  assert.equal(line(undefined), 'Claude Sonnet 5.5 · ok (200) · 900 ms · 23 kB sent');
});
