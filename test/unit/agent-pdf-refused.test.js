// A PDF every model refuses (pdf-refused-next; docs/limitations.md, "A PDF every model refuses keeps its conversation failing" and "A PDF over
// the request size brings a run of summaries before her answer"). The providers here refuse as a provider does: every request that carries the
// PDF, whatever else it holds, before the script moves on (the kit's hold). Their words are Anthropic's: "prompt is too long: … > … maximum" for a
// request over the window (kind context), and, from memory (pdf-count-next's final review), "A maximum of 100 PDF pages may be provided." for a
// PDF over its page limit (kind bad-request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, idleAtOnce, refusing as fullPhone } from './agent-kit.js';
import { useClock } from './clock.js';
import { Agent } from '../../src/core/agent/loop.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { traceSummary } from '../../src/ui/screens/trace.js';

/** Two models as Claude is, each reading PDFs, with a window of 200,000 tokens (the probe's). */
const READS = { input: ['text', 'image', 'pdf'], contextWindow: 200_000 };
const TOO_LONG = { kind: 'context', message: 'prompt is too long: 262144 tokens > 200000 maximum' };
const PAGES = { kind: 'bad-request', message: 'A maximum of 100 PDF pages may be provided.' };
const PATH = '/trip/files/manual.pdf';
const say = (/** @type {string} */ words) => ({ toolCalls: [{ name: 'speak', input: { text: words } }, { name: 'sleep', input: {} }] });
const readIt = { toolCalls: [{ name: 'read', input: { path: PATH } }] };
/** @param {any} r */
const hasPdf = (r) => r.messages.some((/** @type {any} */ m) => m.parts.some((/** @type {any} */ p) => p.type === 'document'));
/** The PDF's bytes as base64 in a request, summed. @param {any[]} rs */
const pdfBytes = (rs) => rs.reduce((n, r) => n + r.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'document').reduce((s, /** @type {any} */ p) => s + p.data.length, 0), 0);
/** The words that stand for the refused PDF in a request. @param {any} r @returns {string[]} */
const refusedWords = (r) => r.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'text' && p.text.startsWith(`[the PDF ${JSON.stringify(PATH)}, not sent: the models refused it`)).map((/** @type {any} */ p) => p.text);
/** Every model refuses a request that carries the PDF, before its script moves on. @param {{ kind: any, message: string }} why */
const refusing = (why) => async (/** @type {any} */ c) => {
  if (hasPdf(c.request)) throw new ProviderError(why.kind, why.message, { status: 400 });
};
const TITLE = "Shiori's models refused a PDF";
/** No warm housekeeping timed between turns: it would take script steps at a time the clock picks. */
const NO_TIMERS = { set: () => 1, clear: () => {} };
const CANT = "Shiori can't reach her model";

/**
 * A trip holding a manual of 1 MiB (the probe's), the main role's two models reading PDFs, and three exchanges before the read (the probe's).
 * @param {any[][]} scripts @param {any} opts
 */
async function manualKit(scripts, opts) {
  const k = await agentKit(scripts, { models: [READS, READS], utility: [{ text: 'They said hello.' }], agent: { timers: NO_TIMERS }, ...opts });
  await k.ws.write(k.trip, '/files/manual.pdf', new TextEncoder().encode(`%PDF-1.4 ${'m'.repeat(2 ** 20 - 9)}`), { author: 'user', type: 'application/pdf' });
  return k;
}

/** @param {any} agent @param {any} k @param {string[]} lines */
async function talk(agent, k, lines) {
  for (const l of lines) {
    agent.send(l);
    await idleAtOnce({ agent }, 4000);
  }
}

/** What she said aloud or showed, in order. @param {any} k @returns {Promise<string[]>} */
const spoken = async (k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text);

const EARLIER = ['Hello', 'Where are we?', 'Thanks'];

for (const [shape, why] of /** @type {const} */ ([['too long for the window', TOO_LONG], ['over its page limit', PAGES]])) {
  test(`a PDF every model refuses as ${shape}: the request goes once more with it as words saying so, she answers in that turn, and a card names the file; no "can't reach" card`, async (t) => {
    useClock(t);
    const k = await manualKit([[say('Hi.'), say('Big Sur.'), say('Sure.'), readIt, say('The fuel cap opens from the lever by the seat.')], [say('never')]], { hold: refusing(why) });
    await talk(k.agent, k, EARLIER);
    const before = k.requests.length;
    await talk(k.agent, k, ['How do I open the fuel cap?']);
    const turn = k.requests.slice(before);
    // Her read; each model refuses the request with the PDF; the same request once more with the PDF as words, which the first model answers.
    assert.deepEqual(turn.map(hasPdf), [false, true, true, false], 'four sends in the turn, two of them with the PDF');
    assert.equal(pdfBytes(turn), 2 * Math.ceil(2 ** 20 / 3) * 4, 'the PDF went up twice, 1 MiB as base64 each time');
    assert.equal((await spoken(k)).at(-1), 'The fuel cap opens from the lever by the seat.', 'answered in the same turn');
    const [words, ...more] = refusedWords(turn.at(-1));
    assert.equal(more.length, 0);
    assert.ok(words.includes(why.message.slice(1).replace(/\.$/, '')), "the models' own words are in it, for her to tell the user");
    assert.match(words, /reading it again brings these words, not the PDF\. To see a page of it, ask the user to send that page as a photo\]$/);
    assert.deepEqual(k.notices.map((n) => n.title), [TITLE], "one card, for the PDF, and no \"can't reach\" card");
    assert.match(k.notices[0].body, /^She goes on without manual\.pdf\. /);
    assert.match(k.notices[0].body, /To show her a page of it, send that page as a photo\.\nE0 \/ model-0: .+\nE1 \/ model-1: .+$/, "then the models' words, a line each");
    const marks = await k.events(['pdf.refused']);
    assert.equal(marks.length, 1);
    assert.deepEqual([marks[0].data.path, marks[0].data.name], [PATH, 'manual.pdf']);
    assert.deepEqual(marks[0].data.why.attempts.map((/** @type {any} */ a) => [a.name, a.outcome]), [['model-0', why.kind], ['model-1', why.kind]]);
    assert.match(traceSummary(marks[0]), /^a PDF every model refused, sent as words from now on · \/trip\/files\/manual\.pdf · model-0: /, 'its Trace line');
    assert.equal((await k.events(['error'])).length, 0, 'the turn did not fail');
  });
}

/**
 * Failures that aren't the PDF's, from the request after her read on, whatever it holds (the main role's models; the utility model answers):
 * a setting every provider refuses (a tunable), a conversation too long with or without the PDF, and a refused key, which is no refusal of
 * what the request holds and gets no test. Each: what her turn sends (with the PDF or not), and its card's words.
 */
const OTHER = /** @type {const} */ ([
  ['a setting every provider refuses', { kind: 'bad-request', message: 'Unsupported parameter: top_k.', status: 400 }, [false, true, true, false, false], 'her read; both models with the PDF; both once more with it as words; then the card'],
  ['a conversation too long without the PDF too', { kind: 'context', message: 'prompt is too long: 230000 tokens > 200000 maximum', status: 400 }, [false, true, true, false, false, false, true, true, false, false],
    'her read; both with the PDF; both with it as words; the summary; both with it whole again; both with it as words; then the card'],
  ['a refused key', { kind: 'auth', message: 'invalid x-api-key', status: 401 }, [false, true, true], 'her read; both models with the PDF; no test: the card'],
]);
for (const [shape, why, sends, said] of OTHER) {
  test(`a request that fails for another reason fails as it did, with its card, and nothing is marked: ${shape}`, async (t) => {
    useClock(t);
    // Refused from the main request after her read on: the earlier exchanges' (three, for a summary to take) and the read's go.
    const from = why.kind === 'context' ? EARLIER.length + 1 : 1;
    let asked = 0;
    const broken = async (/** @type {any} */ c) => {
      if (c.model.providerId !== 'model-u' && asked++ >= from) throw new ProviderError(why.kind, why.message, { status: why.status });
    };
    const k = await manualKit([[...(why.kind === 'context' ? [say('Hi.'), say('Big Sur.'), say('Sure.')] : []), readIt, say('never')], [say('never')]], { hold: broken });
    if (why.kind === 'context') await talk(k.agent, k, EARLIER);
    const before = k.requests.length;
    await talk(k.agent, k, ['How do I open the fuel cap?']);
    const turn = k.requests.slice(before);
    assert.deepEqual(turn.map(hasPdf), sends, said);
    assert.deepEqual(k.notices.map((n) => n.title), [CANT], "the card of a model that can't be reached");
    assert.ok(k.notices[0].body.includes(why.message.slice(1)), "with the providers' own words");
    assert.equal((await k.events(['pdf.refused'])).length, 0, 'nothing marked: the PDF was not the cause');
    if (why.kind !== 'bad-request') return;
    // The next turn: the PDF is still in the window, so it goes whole, and is tested once more, once.
    const next = k.requests.length;
    await talk(k.agent, k, ['Hello?']);
    assert.deepEqual(k.requests.slice(next).map(hasPdf), [true, true, false, false]);
    assert.equal((await k.events(['pdf.refused'])).length, 0);
  });
}

test("a PDF too long while the conversation is too long without it: the test fails, the summary runs, and the test after it is answered", async (t) => {
  useClock(t);
  // Refused while the request carries the PDF, or holds no summary yet (an estimate can be under a provider's count by half).
  const summarized = (/** @type {any} */ r) => JSON.stringify(r.messages).includes('[Earlier conversation, summarized');
  const both = async (/** @type {any} */ c) => {
    if (c.model.providerId !== 'model-u' && (hasPdf(c.request) || (!summarized(c.request) && k.requests.length > EARLIER.length + 1))) throw new ProviderError('context', TOO_LONG.message, { status: 400 });
  };
  const k = await manualKit([[say('Hi.'), say('Big Sur.'), say('Sure.'), readIt, say('The lever by the seat.')], [say('never')]], { hold: both });
  await talk(k.agent, k, EARLIER);
  const before = k.requests.length;
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.deepEqual(k.requests.slice(before).map(hasPdf), [false, true, true, false, false, false, true, true, false],
    'her read; both with the PDF; both with it as words; the summary; both with it whole again; the first with it as words, answered');
  assert.equal((await spoken(k)).at(-1), 'The lever by the seat.');
  assert.equal((await k.events(['pdf.refused'])).length, 1);
  assert.deepEqual(k.notices.map((n) => n.title), [TITLE]);
});

test("a refused PDF doesn't come back: the next turn, her read of it again, a summary, and a reload send the words, never the PDF", async (t) => {
  useClock(t);
  const k = await manualKit([[readIt, say('Lever by the seat.'), say('The trunk has a button.'), readIt, say('Still the lever.'), { text: 'They asked about the fuel cap.' }, say('Here.'), readIt, say('Yes.'), say('Bye.')], [say('never')]], { hold: refusing(TOO_LONG) });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  const mark = k.requests.length;
  await talk(k.agent, k, ['And the trunk?', 'Read the manual again']);
  const after = k.requests.slice(mark);
  assert.deepEqual(after.map(hasPdf), [false, false, false], 'the next turn, and her read of it again with the request after it');
  assert.equal(refusedWords(after.at(-1)).length, 2, 'the words at the first read and at her new read');
  assert.equal(await k.agent.summarizeNow(), 'done');
  const reloaded = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, timeZone: () => 'UTC', secondMs: 10, timers: NO_TIMERS });
  reloaded.addLoopTools(selfTools(reloaded));
  reloaded.on('notice', (/** @type {any} */ n) => k.notices.push(n));
  await reloaded.open(k.trip);
  const again = k.requests.length;
  await talk(reloaded, k, ['Hi again', 'Read it once more', 'Thanks']);
  const later = k.requests.slice(again);
  assert.equal(later.length, 4);
  assert.deepEqual(later.map(hasPdf), [false, false, false, false], 'after a summary and a reload too');
  assert.ok(refusedWords(later.at(-1)).length >= 1);
  assert.equal((await k.events(['pdf.refused'])).length, 1, 'never tested again');
  assert.deepEqual(k.notices.map((n) => n.title), [TITLE]);
  assert.deepEqual((await spoken(k)).slice(-3), ['Here.', 'Yes.', 'Bye.']);
});

test("a mark the phone can't write: she still answers, the storage card says so, and the PDF goes as words for the rest of the run", async (t) => {
  useClock(t);
  const k = await manualKit([[readIt, say('The lever by the seat.'), say('The trunk has a button.')], [say('never')]], { hold: refusing(PAGES) });
  fullPhone(k).full((/** @type {any} */ ev) => ev.type === 'pdf.refused');
  await talk(k.agent, k, ['How do I open the fuel cap?', 'And the trunk?']);
  assert.deepEqual((await spoken(k)).slice(-2), ['The lever by the seat.', 'The trunk has a button.']);
  assert.deepEqual(k.notices.map((n) => n.title), ["Something for Shiori wasn't saved", TITLE]);
  assert.equal((await k.events(['pdf.refused'])).length, 0);
  assert.equal(hasPdf(k.requests.at(-1)), false, 'the next turn sends the words: the mark holds in memory');
});

test("Koe's half does the same: her own read refused by every Koe model, the request once more with the PDF as words, which Koe answers", async (t) => {
  useClock(t);
  const k = await manualKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], {
    hold: refusing(PAGES), models: [READS], koe: { talk: [readIt, say('The lever by the seat.')], type: [say('never')], input: ['text', 'image', 'pdf'] },
  });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  const koe = [...k.sent['model-koet'], ...(k.sent['model-koe'] ?? [])];
  assert.deepEqual(k.sent['model-koet'].map(hasPdf), [false, true, false]);
  assert.deepEqual((k.sent['model-koe'] ?? []).map(hasPdf), [true]);
  assert.equal(koe.length, 4);
  assert.ok((await spoken(k)).includes('The lever by the seat.'));
  assert.equal((await k.events(['pdf.refused'])).length, 1);
  assert.deepEqual(k.notices.map((n) => n.title), [TITLE]);
});

test('a PDF over the request size: one forced summary in its turn, not one for each earlier exchange; then the request goes as it is', async (t) => {
  useClock(t);
  // Five exchanges before the read, a PDF of 1.5 MiB (2 MiB as base64) over a request size of 1 MiB. The first forced summary is warm on her own
  // model (its text step), the rest would be the utility model's.
  const k = await agentKit([[say('1.'), say('2.'), say('3.'), say('4.'), say('5.'), readIt, { text: 'They talked about the car.' }, say('The lever by the seat.')]], {
    models: [{ input: ['text', 'image', 'pdf'], contextWindow: 1_000_000 }], utility: [{ text: 'They talked.' }], agent: { timers: NO_TIMERS },
  });
  await updateAppSettings(k.ws, { shiori: { compaction: { maxRequestMiB: 1 } } });
  await k.ws.write(k.trip, '/files/manual.pdf', new TextEncoder().encode(`%PDF-1.4 ${'m'.repeat(1.5 * 2 ** 20 - 9)}`), { author: 'user', type: 'application/pdf' });
  await talk(k.agent, k, ['a', 'b', 'c', 'd', 'e']);
  const before = k.requests.length;
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  const turn = k.requests.slice(before);
  assert.equal((await k.events(['compaction'])).length, 1, 'one summary');
  assert.equal(turn.filter((r) => String(r.system ?? '').startsWith('You summarize a conversation')).length, 0, 'no utility summary after it');
  assert.deepEqual(turn.map(hasPdf), [false, true, true], 'her read, the warm summary, her answer');
  assert.equal((await spoken(k)).at(-1), 'The lever by the seat.');
});
