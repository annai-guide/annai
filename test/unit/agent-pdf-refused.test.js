// A PDF every model refuses (pdf-refused-next; docs/limitations.md, "A PDF every model refuses keeps its conversation failing" and "A PDF over
// the request size brings a run of summaries before her answer"). The providers here refuse as a provider does: every request that carries the
// PDF, whatever else it holds, before the script moves on (the kit's hold). Their words are Anthropic's, as remembered: "prompt is too long: … > … maximum" for a
// request over the window (kind context), and, from memory (pdf-count-next's final review), "A maximum of 100 PDF pages may be provided." for a
// PDF over its page limit (kind bad-request): the kinds are what the classifier gives them, the wordings are not seen from a real API.
//
// What the fix rounds pin (the mark's reach; one card; Start fresh; a resting model): the test runs only when every model the request went to ended in a refusal, and a request too
// long goes through housekeeping first; the mark is written only when a model that refused the request (one asked with the PDF's reading counts) answers the words, is its half's, and
// ends at its conversation's next summary or Start fresh.
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
const TOO_LONG = /** @type {const} */ ({ kind: 'context', message: 'prompt is too long: 262144 tokens > 200000 maximum' });
const PAGES = /** @type {const} */ ({ kind: 'bad-request', message: 'A maximum of 100 PDF pages may be provided.' });
const PATH = '/trip/files/manual.pdf';
const say = (/** @type {string} */ words) => ({ toolCalls: [{ name: 'speak', input: { text: words } }, { name: 'sleep', input: {} }] });
const readIt = { toolCalls: [{ name: 'read', input: { path: PATH } }] };
/** Her read of a file in the trip's files. @param {string} name */
const readOf = (name) => ({ toolCalls: [{ name: 'read', input: { path: `/trip/files/${name}` } }] });
/** @param {any} r */
const hasPdf = (r) => r.messages.some((/** @type {any} */ m) => m.parts.some((/** @type {any} */ p) => p.type === 'document'));
/** The PDFs a request carries whole, by file name. @param {any} r @returns {string[]} */
const pdfsOf = (r) => r.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'document').map((/** @type {any} */ p) => p.name);
/** The PDF's bytes as base64 in a request, summed. @param {any[]} rs */
const pdfBytes = (rs) => rs.reduce((n, r) => n + r.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'document').reduce((s, /** @type {any} */ p) => s + p.data.length, 0), 0);
/** The words that stand for a refused PDF in a request (the manual's, unless a path is given). @param {any} r @param {string} [path] @returns {string[]} */
const refusedWords = (r, path = PATH) => r.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'text' && p.text.startsWith(`[the PDF ${JSON.stringify(path)}, not sent: the models refused a request that held it`)).map((/** @type {any} */ p) => p.text);
/** Every model (or those of the providers given) refuses a request that carries a PDF whole, before its script moves on. @param {{ kind: any, message: string }} why @param {string[]} [only] provider model ids */
const refusing = (why, only) => async (/** @type {any} */ c) => {
  if (hasPdf(c.request) && (!only || only.includes(c.model.providerId))) throw new ProviderError(why.kind, why.message, { status: 400 });
};
const TITLE = "Shiori's models refused a request with a PDF in it";
const TITLES = "Shiori's models refused a request with PDFs in it";
/** No warm housekeeping timed between turns: it would take script steps at a time the clock picks. */
const NO_TIMERS = { set: () => 1, clear: () => {} };
const CANT = "Shiori can't reach her model";

/**
 * A trip holding a manual of 1 MiB (the probe's), the main role's two models reading PDFs, and a utility model for the summaries. The exchanges
 * before the read are the scripts' own (EARLIER's three, where a test has them).
 * @param {any[][]} scripts @param {any} opts
 */
async function manualKit(scripts, opts) {
  const k = await agentKit(scripts, { models: [READS, READS], utility: [{ text: 'They said hello.' }], agent: { timers: NO_TIMERS }, ...opts });
  await k.ws.write(k.trip, '/files/manual.pdf', new TextEncoder().encode(`%PDF-1.4 ${'m'.repeat(2 ** 20 - 9)}`), { author: 'user', type: 'application/pdf' });
  return k;
}

/** A small PDF in the trip's files. @param {any} k @param {string} name */
const addPdf = (k, name) => k.ws.write(k.trip, `/files/${name}`, new TextEncoder().encode(`%PDF-1.4 ${name} ${'p'.repeat(4096)}`), { author: 'user', type: 'application/pdf' });

/** @param {any} agent @param {any} k @param {string[]} lines */
async function talk(agent, k, lines) {
  for (const l of lines) {
    agent.send(l);
    await idleAtOnce({ agent }, 4000);
  }
}

/** What she said aloud or showed, in order. @param {any} k @returns {Promise<string[]>} */
const spoken = async (k) => (await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text);

/** The titles of the cards shown, in order. @param {any} k */
const cards = (k) => k.notices.map((/** @type {any} */ n) => n.title);

const EARLIER = ['Hello', 'Where are we?', 'Thanks'];
const EXCHANGES = [say('Hi.'), say('Big Sur.'), say('Sure.')];

/** The PDF's words as the test sends them (the request once more, with the PDF as words): they hold the models' own words and say what happens next. @param {string} words @param {string} message */
const wordsSay = (words, message) => {
  assert.ok(words.includes(message.slice(1).replace(/\.$/, '')), "the models' own words are in it, for her to tell the user");
  assert.match(words, /until the conversation is next summarized or started fresh, it goes as these words, a read of it again too\. To see a page of it, ask the user to send that page as a photo\]$/);
};

for (const [shape, why, sends, said] of /** @type {const} */ ([
  ['too long for the window', TOO_LONG, [false, true, true, false, true, true, false], "her read; each model with the PDF; the summary (a request too long is housekeeping's first, as on main: the conversation may be what was too long); each with it whole again; the first with it as words, answered"],
  ['over its page limit', PAGES, [false, true, true, false], 'her read; each model with the PDF; the first with it as words, answered (no housekeeping: a page limit is not the length)'],
])) {
  test(`a PDF every model refuses as ${shape}: the test (the request with it as words) answers in that turn, and one card names the file; no "can't reach" card`, async (t) => {
    useClock(t);
    const k = await manualKit([[...EXCHANGES, readIt, say('The fuel cap opens from the lever by the seat.')], [say('never')]], { hold: refusing(why) });
    await talk(k.agent, k, EARLIER);
    const before = k.requests.length;
    await talk(k.agent, k, ['How do I open the fuel cap?']);
    const turn = k.requests.slice(before);
    assert.deepEqual(turn.map(hasPdf), sends, said);
    assert.equal(pdfBytes(turn), sends.filter(Boolean).length * Math.ceil(2 ** 20 / 3) * 4, 'the PDF went up each time it was whole: its 1 MiB as 1,398,104 characters of base64');
    assert.equal((await spoken(k)).at(-1), 'The fuel cap opens from the lever by the seat.', 'answered in the same turn');
    const [words, ...more] = refusedWords(turn.at(-1));
    assert.equal(more.length, 0);
    wordsSay(words, why.message);
    assert.deepEqual(cards(k), [TITLE], "one card, for the request, and no \"can't reach\" card");
    assert.match(k.notices[0].body, /^The models refused a request that held manual\.pdf\. She goes on without it until the conversation is next summarized or started fresh\. To show her a page, send it as a photo\.\n/);
    assert.match(k.notices[0].body, /\nE0 \/ model-0: .+\nE1 \/ model-1: .+$/, "then the models' words, a line each");
    const marks = await k.events(['pdf.refused']);
    assert.equal(marks.length, 1);
    assert.deepEqual([marks[0].data.path, marks[0].data.name, marks[0].data.role], [PATH, 'manual.pdf', 'main'], "with the half's role");
    assert.deepEqual(marks[0].data.why.attempts.map((/** @type {any} */ a) => [a.name, a.outcome]), [['model-0', why.kind], ['model-1', why.kind]]);
    assert.match(traceSummary(marks[0]), /^a PDF of a request the models refused, sent as words until the conversation is next summarized or started fresh · \/trip\/files\/manual\.pdf · model-0: /, 'its Trace line');
    assert.equal((await k.events(['error'])).length, 0, 'the turn did not fail');
  });
}

/**
 * Failures other than a refusal of the PDF itself, from the request after her read on, whatever it holds (the main role's models; the utility
 * model answers): a setting every provider refuses (a tunable: a refusal of every request, so the test is refused too), a conversation too long
 * with or without the PDF, a refused key, and a refused photo. Each: what her turn sends (with the PDF or not), and its card's words.
 * Only the first two are refusals by every model asked, which the test then decides: its extra passes are the price of the test, and the card is the same.
 */
const OTHER = /** @type {const} */ ([
  ['a setting every provider refuses', { kind: 'bad-request', message: 'Unsupported parameter: top_k.', status: 400 }, [false, true, true, false, false], 'her read; both models with the PDF; both once more with it as words (refused too); then the card'],
  ['a conversation too long without the PDF too', { kind: 'context', message: 'prompt is too long: 230000 tokens > 200000 maximum', status: 400 }, [false, true, true, false, true, true, false, false],
    'her read; both with the PDF; the summary; both with it whole again; both with it as words (refused too); then the card'],
  ['a refused key', { kind: 'auth', message: 'invalid x-api-key', status: 401 }, [false, true, true], 'her read; both models with the PDF; no test: the card'],
  ['a refused photo', { kind: 'image', message: 'image exceeds 5 MB maximum', status: 400 }, [false, true, true], "her read; both models with the PDF; no test (a photo is the repair's, not a PDF refusal): the photo's card", "Shiori couldn't send the photo"],
]);
for (const [shape, why, sends, said, card = CANT] of OTHER) {
  test(`a request that fails for another reason fails with its card, and nothing is marked: ${shape}`, async (t) => {
    useClock(t);
    // Refused from the main request after her read on: the earlier exchanges' (three, for a summary to take) and the read's go.
    const from = why.kind === 'context' ? EARLIER.length + 1 : 1;
    let asked = 0;
    const broken = async (/** @type {any} */ c) => {
      if (c.model.providerId !== 'model-u' && asked++ >= from) throw new ProviderError(why.kind, why.message, { status: why.status });
    };
    const k = await manualKit([[...(why.kind === 'context' ? EXCHANGES : []), readIt, say('never')], [say('never')]], { hold: broken });
    if (why.kind === 'context') await talk(k.agent, k, EARLIER);
    const before = k.requests.length;
    await talk(k.agent, k, ['How do I open the fuel cap?']);
    const turn = k.requests.slice(before);
    assert.deepEqual(turn.map(hasPdf), sends, said);
    assert.deepEqual(cards(k), [card], 'the card of a failed turn, one, and not the PDF card');
    if (card === CANT) assert.ok(k.notices.at(-1).body.includes(why.message.slice(1)), "with the providers' own words");
    assert.equal((await k.events(['pdf.refused'])).length, 0, 'nothing marked: the PDF was not the cause');
    if (why.kind !== 'bad-request') return;
    // The next turn: the PDF is still in the window, so it goes whole, and is tested once more, once.
    const next = k.requests.length;
    await talk(k.agent, k, ['Hello?']);
    assert.deepEqual(k.requests.slice(next).map(hasPdf), [true, true, false, false]);
    assert.equal((await k.events(['pdf.refused'])).length, 0);
  });
}

test("models passed over as too long by annai's own estimate are no refusal: no test, no mark, the card", async (t) => {
  useClock(t);
  // A window of 4,800 tokens: annai's estimate of her read's request is 4,004 tokens and of the next one, with the PDF, 5,656 (measured; a PDF counts as
  // one picture, 1,600: fallback.js estimateTokens), so the read goes, and the request with the PDF is passed over as too long by annai's own count,
  // with no provider asked. Any window from 4,004 to 5,655 does it; 4,800 is the middle. A mutant that takes `too-long` for a refusal, or no
  // model asked for every model asked, tests it.
  const small = { input: ['text', 'image', 'pdf'], contextWindow: 4_800 };
  const k = await manualKit([[readIt, say('never')], [say('never')]], { models: [small, small], hold: async () => {} });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.deepEqual(k.requests.map(hasPdf), [false], 'her read; the request with the PDF went to no model');
  assert.deepEqual(cards(k), [CANT]);
  assert.equal((await k.events(['pdf.refused'])).length, 0);
});

test('a model that is rate-limited once while the other refuses the PDF is no refusal by every model: no test, no mark, and a later turn answers from the PDF', async (t) => {
  useClock(t);
  // The first model is rate-limited at the first request with the PDF; the second refuses every request that carries it (too long for its window).
  let limited = false;
  const hold = async (/** @type {any} */ c) => {
    if (!hasPdf(c.request)) return;
    if (c.model.providerId === 'model-0' && !limited) {
      limited = true;
      throw new ProviderError('rate', 'Rate limited', { status: 429 });
    }
    if (c.model.providerId === 'model-1') throw new ProviderError(TOO_LONG.kind, TOO_LONG.message, { status: 400 });
  };
  const k = await manualKit([[readIt, say('The lever by the seat.')], [say('never')]], { hold });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.deepEqual(k.sent['model-0'].map(hasPdf), [false, true], 'her read; the PDF, rate-limited');
  assert.deepEqual(k.sent['model-1'].map(hasPdf), [true], 'refused, and no test after it');
  assert.deepEqual(cards(k), [CANT]);
  assert.equal((await k.events(['pdf.refused'])).length, 0, 'nothing marked on the second model\'s word alone');
  // Later: the first model is asked last (it rests), and reads the PDF.
  await talk(k.agent, k, ['Hello?']);
  assert.deepEqual(k.sent['model-0'].map(hasPdf), [false, true, true]);
  assert.equal((await spoken(k)).at(-1), 'The lever by the seat.', 'answered from the PDF');
  assert.equal((await k.events(['pdf.refused'])).length, 0);
});

test('a model that refuses every request and another rate-limited once are no refusal by every model: no test, no mark, and a later turn answers from the PDF', async (t) => {
  useClock(t);
  // The first model refuses everything (a setting it can't take); the second reads PDFs, and is rate-limited at the first request with the PDF.
  let limited = false;
  const hold = async (/** @type {any} */ c) => {
    if (c.model.providerId === 'model-0') throw new ProviderError('bad-request', 'Unsupported parameter: top_k.', { status: 400 });
    if (hasPdf(c.request) && !limited) {
      limited = true;
      throw new ProviderError('rate', 'Rate limited', { status: 429 });
    }
  };
  const k = await manualKit([[say('never')], [readIt, say('The lever by the seat.')]], { hold });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.deepEqual(cards(k), [CANT]);
  assert.equal((await k.events(['pdf.refused'])).length, 0, 'nothing marked: the second model was not refused');
  await talk(k.agent, k, ['Hello?']);
  assert.equal((await spoken(k)).at(-1), 'The lever by the seat.', 'answered from the PDF');
  assert.equal(k.sent['model-1'].at(-1).messages.some((/** @type {any} */ m) => m.parts.some((/** @type {any} */ p) => p.type === 'document')), true);
  assert.equal((await k.events(['pdf.refused'])).length, 0);
});

test("a model rate-limited for a moment is asked again, and its last answer counts: refused then, it is one of the models that refused, and the test runs", async (t) => {
  useClock(t);
  // The first model asks for a short wait (a second) at the PDF's first request, then refuses it as too long, as the second does.
  let limited = false;
  const hold = async (/** @type {any} */ c) => {
    if (!hasPdf(c.request)) return;
    if (c.model.providerId === 'model-0' && !limited) {
      limited = true;
      throw new ProviderError('rate', 'Rate limited', { status: 429, retryAfter: 1000 });
    }
    throw new ProviderError(TOO_LONG.kind, TOO_LONG.message, { status: 400 });
  };
  const k = await manualKit([[readIt, say('The lever by the seat.')], [say('never')]], { hold });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.deepEqual(k.sent['model-0'].map(hasPdf), [false, true, true, false], 'her read; the PDF, rate-limited; again, refused; the words, answered');
  assert.deepEqual(cards(k), [TITLE]);
  const [mark] = await k.events(['pdf.refused']);
  assert.deepEqual(mark.data.why.attempts.map((/** @type {any} */ a) => [a.name, a.outcome]), [['model-0', 'context'], ['model-1', 'context']], "the refusals' words, not the pause's");
});

test('one model refuses the PDF and the next answers the whole request: no test, no mark, and the PDF goes whole to the one that answers in every turn', async (t) => {
  useClock(t);
  const k = await manualKit([[readIt, say('never'), say('never')], [say('The lever by the seat.'), say('The trunk has a button.')]], { hold: refusing(PAGES, ['model-0']) });
  await talk(k.agent, k, ['How do I open the fuel cap?', 'And the trunk?']);
  // The model that answered holds the cache, so it goes first in the next turn (callRole's prefer): the first model is asked only in the first.
  assert.deepEqual(k.sent['model-0'].map(hasPdf), [false, true], 'her read; the PDF, refused');
  assert.deepEqual(k.sent['model-1'].map(hasPdf), [true, true], 'the second model got the PDF whole each time');
  assert.deepEqual((await spoken(k)).slice(-2), ['The lever by the seat.', 'The trunk has a button.']);
  assert.deepEqual(cards(k), [], 'no card');
  assert.equal((await k.events(['pdf.refused'])).length, 0);
});

test('a PDF too long only together with the conversation: after housekeeping it fits, and she answers from it in that turn, with nothing marked', async (t) => {
  useClock(t);
  // Refused while the request carries the PDF and holds no summary yet: the conversation was what was too long (main's order; the test would have taken the PDF out).
  const summarized = (/** @type {any} */ r) => JSON.stringify(r.messages).includes('[Earlier conversation, summarized');
  const hold = async (/** @type {any} */ c) => {
    if (c.model.providerId !== 'model-u' && hasPdf(c.request) && !summarized(c.request)) throw new ProviderError('context', TOO_LONG.message, { status: 400 });
  };
  const k = await manualKit([[...EXCHANGES, readIt, say('The lever by the seat.'), say('Still the lever.')], [say('never')]], { hold });
  await talk(k.agent, k, EARLIER);
  const before = k.requests.length;
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.deepEqual(k.requests.slice(before).map(hasPdf), [false, true, true, false, true], 'her read; both with the PDF; the summary; the first with it, answered');
  assert.equal((await spoken(k)).at(-1), 'The lever by the seat.', 'answered from the PDF');
  assert.deepEqual(cards(k), [], 'no card');
  assert.equal((await k.events(['pdf.refused'])).length, 0, 'nothing marked');
  // The next turn goes on with the PDF whole: it was never the cause.
  const next = k.requests.length;
  await talk(k.agent, k, ['Again?']);
  assert.equal(hasPdf(k.requests[next]), true);
});

test('a PDF over its page limit in a conversation too long without it: the test at once is refused as too long, housekeeping runs, and the PDF is tested again after it', async (t) => {
  useClock(t);
  // The PDF is refused whatever else is in the request, and once the earlier exchanges are in, a request with no summary yet is too long too, the test's own
  // (the PDF as words) included.
  const summarized = (/** @type {any} */ r) => JSON.stringify(r.messages).includes('[Earlier conversation, summarized');
  const hold = async (/** @type {any} */ c) => {
    if (c.model.providerId === 'model-u') return;
    if (hasPdf(c.request)) throw new ProviderError(PAGES.kind, PAGES.message, { status: 400 });
    if (!summarized(c.request) && k.requests.length > EARLIER.length + 1) throw new ProviderError('context', TOO_LONG.message, { status: 400 });
  };
  const k = await manualKit([[...EXCHANGES, readIt, say('The lever by the seat.')], [say('never')]], { hold });
  await talk(k.agent, k, EARLIER);
  const before = k.requests.length;
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.deepEqual(k.requests.slice(before).map(hasPdf), [false, true, true, false, false, false, true, true, false],
    'her read; both with the PDF (bad request: tested at once); both with it as words (too long); the summary; both with the PDF; the first with it as words, answered');
  assert.equal((await spoken(k)).at(-1), 'The lever by the seat.');
  assert.equal((await k.events(['pdf.refused'])).length, 1);
  assert.deepEqual(cards(k), [TITLE]);
});

test("a refused PDF doesn't come back while the conversation stands: the next turn, her read of it again, and a reload send the words, never the PDF", async (t) => {
  useClock(t);
  const k = await manualKit([[readIt, say('Lever by the seat.'), say('The trunk has a button.'), readIt, say('Still the lever.'), say('Here.'), readIt, say('Yes.')], [say('never')]], { hold: refusing(PAGES) });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  const mark = k.requests.length;
  await talk(k.agent, k, ['And the trunk?', 'Read the manual again']);
  const after = k.requests.slice(mark);
  assert.deepEqual(after.map(hasPdf), [false, false, false], 'the next turn, and her read of it again with the request after it');
  assert.equal(refusedWords(after.at(-1)).length, 2, 'the words at the first read and at her new read');
  const reloaded = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, timeZone: () => 'UTC', secondMs: 10, timers: NO_TIMERS });
  reloaded.addLoopTools(selfTools(reloaded));
  reloaded.on('notice', (/** @type {any} */ n) => k.notices.push(n));
  await reloaded.open(k.trip);
  const again = k.requests.length;
  await talk(reloaded, k, ['Hi again', 'Read it once more']);
  assert.deepEqual(k.requests.slice(again).map(hasPdf), [false, false, false], 'after a reload too');
  assert.ok(refusedWords(k.requests.at(-1)).length >= 1);
  assert.equal((await k.events(['pdf.refused'])).length, 1, 'never tested again');
  assert.deepEqual(cards(k), [TITLE]);
  assert.deepEqual((await spoken(k)).slice(-3), ['Still the lever.', 'Here.', 'Yes.']);
});

test('a summary ends the mark: her read of the PDF again goes whole, is refused, and is tested and marked again, with a second card', async (t) => {
  useClock(t);
  // Her cache is warm, so the summary is written by her model: its text step.
  const k = await manualKit([[readIt, say('Lever by the seat.'), say('The trunk has a button.'), { text: 'They asked about the fuel cap and the trunk.' }, readIt, say('The lever, still.')], [say('never')]], { hold: refusing(PAGES) });
  await talk(k.agent, k, ['How do I open the fuel cap?', 'And the trunk?']);
  assert.equal((await k.events(['pdf.refused'])).length, 1);
  assert.equal(await k.agent.summarizeNow(), 'done');
  const before = k.requests.length;
  await talk(k.agent, k, ['Read the manual once more']);
  assert.deepEqual(k.requests.slice(before).map(hasPdf), [false, true, true, false], 'her read; the PDF whole again, refused by both; the words, answered');
  assert.equal((await k.events(['pdf.refused'])).length, 2, 'marked again');
  assert.deepEqual(cards(k), [TITLE, TITLE]);
  assert.equal((await spoken(k)).at(-1), 'The lever, still.');
});

test("Start fresh ends the mark with no summary before it: her read of the PDF goes whole again, is refused, and is tested and marked again, with a second card", async (t) => {
  useClock(t);
  const k = await manualKit([[readIt, say('Lever by the seat.'), readIt, say('The lever, still.')], [say('never')]], { hold: refusing(PAGES) });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.equal((await k.events(['pdf.refused'])).length, 1);
  assert.equal((await k.events(['compaction'])).length, 0, 'no summary in this conversation: only Start fresh ends the mark');
  assert.equal(await k.agent.startFresh(), 'done');
  const before = k.requests.length;
  await talk(k.agent, k, ['Read the manual once more']);
  assert.deepEqual(k.requests.slice(before).map(hasPdf), [false, true, true, false], 'her read; the PDF whole again, refused by both; the words, answered');
  assert.equal((await k.events(['pdf.refused'])).length, 2, 'marked again');
  assert.deepEqual(cards(k), [TITLE, TITLE]);
  assert.equal((await spoken(k)).at(-1), 'The lever, still.');
});

test("a mark the phone can't write: she still answers, the storage card says so, and the PDF goes as words while the conversation stays open", async (t) => {
  useClock(t);
  const k = await manualKit([[readIt, say('The lever by the seat.'), say('The trunk has a button.')], [say('never')]], { hold: refusing(PAGES) });
  fullPhone(k).full((/** @type {any} */ ev) => ev.type === 'pdf.refused');
  await talk(k.agent, k, ['How do I open the fuel cap?', 'And the trunk?']);
  assert.deepEqual((await spoken(k)).slice(-2), ['The lever by the seat.', 'The trunk has a button.']);
  assert.deepEqual(cards(k), ["Something for Shiori wasn't saved", TITLE]);
  assert.equal((await k.events(['pdf.refused'])).length, 0);
  assert.equal(hasPdf(k.requests.at(-1)), false, 'the next turn sends the words: the mark holds in memory');
});

test("Koe's half does the same: her own read refused by every Koe model, the request once more with the PDF as words, which Koe answers; her next turn sends the words, not the PDF", async (t) => {
  useClock(t);
  const k = await manualKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], {
    hold: refusing(PAGES), models: [READS], koe: { talk: [readIt, say('The lever by the seat.'), say('The trunk has a button.')], type: [say('never')], input: ['text', 'image', 'pdf'] },
  });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  const koe = [...k.sent['model-koet'], ...(k.sent['model-koe'] ?? [])];
  assert.deepEqual(k.sent['model-koet'].map(hasPdf), [false, true, false]);
  assert.deepEqual((k.sent['model-koe'] ?? []).map(hasPdf), [true]);
  assert.equal(koe.length, 4);
  assert.ok((await spoken(k)).includes('The lever by the seat.'));
  assert.deepEqual(cards(k), [TITLE]);
  // Her next turn: the PDF is in its window still, and goes as words.
  await talk(k.agent, k, ['And the trunk?']);
  assert.deepEqual(k.sent['model-koet'].slice(3).map(hasPdf), [false], 'Koe sends no PDF');
  assert.equal(refusedWords(k.sent['model-koet'].at(-1)).length, 1, 'the words in its place');
  assert.equal((k.sent['model-koe'] ?? []).length, 1, 'no other model was asked');
  const marks = await k.events(['pdf.refused']);
  assert.deepEqual(marks.map((m) => m.data.role), ['koe-classic'], "one mark, Koe's, never tested again");
});

test("a mark is its half's: Koe's models refused the PDF, and Kokoro's own read of it goes whole to her models, with none of Koe's words", async (t) => {
  useClock(t);
  // Both of Koe's models refuse every request that carries a PDF (as over a page limit); Kokoro's own model, no part of that, takes it.
  const k = await manualKit([[readIt, say('From the PDF: the lever.')]], {
    hold: refusing(PAGES, ['model-koet', 'model-koe']), models: [{ input: ['text', 'image', 'pdf'], contextWindow: 1_000_000 }],
    koe: { talk: [readIt, say('The lever by the seat.')], type: [say('never')], input: ['text', 'image', 'pdf'] },
  });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.deepEqual(cards(k), [TITLE], "Koe's models refused it");
  const before = (k.sent['model-0'] ?? []).length;
  k.agent.kokoro.enqueue({ kind: 'cue', text: 'a review: 3 minutes or more of conversation since you last looked.', logged: true });
  await k.agent.idle();
  const hers = (k.sent['model-0'] ?? []).slice(before);
  assert.ok(hers.some(hasPdf), 'Kokoro sent the PDF whole');
  assert.equal(hers.flatMap((r) => refusedWords(r)).length, 0, "and no words of Koe's mark");
  assert.deepEqual((await k.events(['pdf.refused'])).map((m) => m.data.role), ['koe-classic'], "one mark, Koe's, and none of Kokoro's");
  assert.deepEqual(cards(k), [TITLE], "only Koe's card");
});

test("a model resting in Koe's turn is not asked, so the other's refusal marks the PDF, and the resting one, awake later, gets the words until the next summary (a proposed known limitation)", async (t) => {
  useClock(t);
  // Koe's list: the first model takes this PDF but is rate-limited at its first request and rests for 3 minutes (Koe never asks a resting model); the
  // second is refused every request that carries it (a page limit). The mark rests on the one model asked, as the test's rule has it: models passed over
  // (resting among them) don't count. A rule that made a resting model block the test would bring the failure the test is for back to Koe's half for as long as a model stays benched (one that only the user's key or credit can wake: for good).
  let limited = false;
  const k = await manualKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], {
    models: [READS], koe: { talk: [readIt, say('Not from the PDF.')], type: [say('Hello.'), readIt, say('The lever by the seat.')], input: ['text', 'image', 'pdf'] },
    hold: async (/** @type {any} */ c) => {
      if (c.model.providerId === 'model-koet' && !limited) {
        limited = true;
        throw new ProviderError('rate', 'Rate limited', { status: 429 });
      }
      if (c.model.providerId === 'model-koe' && hasPdf(c.request)) throw new ProviderError(PAGES.kind, PAGES.message, { status: 400 });
    },
  });
  await talk(k.agent, k, ['Hi']);
  assert.deepEqual(k.sent['model-koet'].map(hasPdf), [false], 'rate-limited, resting');
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.equal(k.sent['model-koet'].length, 1, 'not asked while it rests');
  assert.deepEqual(k.sent['model-koe'].map(hasPdf), [false, false, true, false], 'her read; the PDF, refused; the words, answered');
  assert.deepEqual(cards(k), [TITLE]);
  assert.deepEqual((await k.events(['pdf.refused'])).map((m) => m.data.role), ['koe-classic'], 'marked on the second model alone');
  // Ten minutes on, the first model is awake and goes first: it is sent the words, never the PDF.
  await new Promise((r) => setTimeout(r, 10 * 60_000));
  await talk(k.agent, k, ['Read it again']);
  assert.deepEqual(k.sent['model-koet'].slice(1).map(hasPdf), [false, false], 'her read, and the request after it: no PDF');
  assert.equal(refusedWords(k.sent['model-koet'].at(-1)).length, 1, 'the words in its place');
  assert.equal((await spoken(k)).at(-1), 'Not from the PDF.');
  assert.equal((await k.events(['pdf.refused'])).length, 1, 'never tested again');
  assert.deepEqual(cards(k), [TITLE]);
});

test('words answered by a model that did not refuse the whole request are no proof: the model that refused it refuses the words too, a text-only model answers them, and nothing is marked', async (t) => {
  useClock(t);
  // Koe's list: the first model reads PDFs and refuses every request after its read; the second takes no PDFs (so it was passed over for the whole request, and asked for the words).
  const k = await manualKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], {
    models: [READS], koe: { talk: [readIt, say('never')], type: [say('Not from the PDF.')], input: ['text', 'image', 'pdf'], model: { input: ['text'] } },
    hold: async (/** @type {any} */ c) => {
      if (c.model.providerId === 'model-koet' && (k.sent['model-koet'] ?? []).length > 1) throw new ProviderError('bad-request', PAGES.message, { status: 400 });
    },
  });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.deepEqual(k.sent['model-koet'].map(hasPdf), [false, true, false], 'her read; the PDF refused; the words refused too');
  assert.deepEqual((k.sent['model-koe'] ?? []).map(hasPdf), [false], 'the text-only model got the words');
  assert.ok((await spoken(k)).includes('Not from the PDF.'));
  assert.equal((await k.events(['pdf.refused'])).length, 0, "not marked: the model that answered the words was never refused");
  assert.deepEqual(cards(k), []);
});

test('three PDFs, one locked: one refused request marks them together, one card names them all; a summary and Start fresh each end the mark, and the fine ones go whole again', async (t) => {
  useClock(t);
  const locked = async (/** @type {any} */ c) => {
    if (pdfsOf(c.request).includes('locked.pdf')) throw new ProviderError('bad-request', 'The PDF is locked.', { status: 400 });
  };
  const all = { toolCalls: ['hotel.pdf', 'ticket.pdf', 'locked.pdf'].map((name) => ({ name: 'read', input: { path: `/trip/files/${name}` } })) };
  // Her cache is warm, so the summary is written by her model: its text step.
  const k = await manualKit([[all, say('The hotel is in town.'), readOf('hotel.pdf'), say('Still the hotel.'), { text: 'They read the hotel.' }, readOf('ticket.pdf'), say('The ticket is for 9.'), readOf('locked.pdf'), say('It is locked.')], [say('never')]], { hold: locked });
  for (const name of ['hotel.pdf', 'ticket.pdf', 'locked.pdf']) await addPdf(k, name);
  await talk(k.agent, k, ['What do the three say?']);
  const marks = await k.events(['pdf.refused']);
  assert.deepEqual(marks.map((m) => m.data.name).sort(), ['hotel.pdf', 'locked.pdf', 'ticket.pdf'], 'the three together: the request held them');
  // Her read of the fine one again: words, while the conversation stands.
  await talk(k.agent, k, ['Read the hotel again']);
  assert.deepEqual(pdfsOf(k.requests.at(-1)), [], 'the hotel is words');
  assert.equal(refusedWords(k.requests.at(-1), '/trip/files/hotel.pdf').length, 2);
  // A summary ends the marks: the hotel, in the kept exchange, goes whole, and so does the ticket she reads next, both in the one request, and neither is refused.
  assert.equal(await k.agent.summarizeNow(), 'done');
  await talk(k.agent, k, ['And the ticket?']);
  assert.deepEqual(pdfsOf(k.requests.at(-1)).sort(), ['hotel.pdf', 'ticket.pdf'], 'the fine ones whole again');
  assert.equal((await k.events(['pdf.refused'])).length, 3, 'no new mark');
  // Start fresh ends them too: her read of the locked one is whole, refused, and tested and marked again.
  assert.equal(await k.agent.startFresh(), 'done');
  await talk(k.agent, k, ['And the locked one?']);
  assert.equal((await k.events(['pdf.refused'])).length, 4, 'marked again');
  assert.deepEqual(pdfsOf(k.requests.at(-1)), [], 'as words');
  assert.deepEqual(cards(k), [TITLES, TITLE], 'one card for the three, and one for the locked one again');
  assert.match(k.notices[0].body, /^The models refused a request that held .*hotel\.pdf.*ticket\.pdf.*locked\.pdf.*\. She goes on without them until the conversation is next summarized or started fresh\. To show her a page, send it as a photo\.\n/);
  assert.deepEqual((await spoken(k)).slice(-4), ['The hotel is in town.', 'Still the hotel.', 'The ticket is for 9.', 'It is locked.']);
});

test('a refusal that passes: one 400 on the only model marks the PDF (the test cannot tell), and the mark ends at the next summary, when she reads it again', async (t) => {
  useClock(t);
  // A 400 that is no refusal of the PDF ("Upstream connect error"), once, while the PDF is in the request: the model answers the request without it.
  let once = false;
  const hold = async (/** @type {any} */ c) => {
    if (hasPdf(c.request) && !once) {
      once = true;
      throw new ProviderError('bad-request', 'Upstream connect error.', { status: 400 });
    }
  };
  const k = await manualKit([[readIt, say('The lever by the seat.'), say('The trunk has a button.'), { text: 'They asked about the fuel cap and the trunk.' }, readIt, say('Back to the PDF.')]], { models: [READS], hold });
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.equal((await k.events(['pdf.refused'])).length, 1, 'marked, bounded by the next summary');
  await talk(k.agent, k, ['And the trunk?']);
  assert.equal(hasPdf(k.requests.at(-1)), false, 'words while the conversation stands');
  assert.equal(await k.agent.summarizeNow(), 'done');
  await talk(k.agent, k, ['Back to the manual']);
  assert.equal(hasPdf(k.requests.at(-1)), true, 'whole again after the summary, and not refused this time');
  assert.equal((await spoken(k)).at(-1), 'Back to the PDF.');
  assert.equal((await k.events(['pdf.refused'])).length, 1);
  assert.deepEqual(cards(k), [TITLE]);
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

// A PDF too long for every window, marked before a summary and back after it (docs/limitations.md, "A PDF too long for every model's window comes back
// after each summary"; pdf-refused-next's re-review, N2): a summary made no room for it then, so its refusal is tested at once, with no housekeeping first.
/** The conversation's summaries so far. @param {any} k */
const summaries = async (k) => (await k.events(['compaction'])).length;

test('a PDF too long for every window, marked before a summary and read again after it: tested at once, each model sent it whole once, and no summary first', async (t) => {
  useClock(t);
  // Her cache is warm at Summarize now, so that summary is her model's text step; the housekeeping summaries are the utility model's.
  const k = await manualKit([[...EXCHANGES, readIt, say('Lever by the seat.'), say('The trunk has a button.'), say('Sure.'), { text: 'They asked about the fuel cap and the trunk.' }, say('Hello.'), readIt, say('The lever, still.')], [say('never')]], { hold: refusing(TOO_LONG) });
  await talk(k.agent, k, EARLIER);
  await talk(k.agent, k, ['How do I open the fuel cap?']);
  assert.equal((await k.events(['pdf.refused'])).length, 1, 'marked, after the housekeeping of its own turn');
  // Two turns, so the PDF is out of its window; Summarize now; one more exchange, so housekeeping would have one to summarize.
  await talk(k.agent, k, ['And the trunk?', 'Thanks']);
  assert.equal(await k.agent.summarizeNow(), 'done');
  await talk(k.agent, k, ['Hi']);
  const before = k.requests.length;
  const was = await summaries(k);
  await talk(k.agent, k, ['Read the manual once more']);
  const turn = k.requests.slice(before);
  assert.deepEqual(turn.map(hasPdf), [false, true, true, false], 'her read; each model with the PDF, refused; the first with it as words, answered (main: the summary, and each with it whole again, between)');
  assert.equal(turn.length, 4, 'four requests (main: seven)');
  assert.equal(pdfBytes(turn), 2 * Math.ceil(2 ** 20 / 3) * 4, 'the PDF went up twice, once to each model (main: four times)');
  assert.equal(await summaries(k), was, 'no summary in that turn');
  assert.equal((await k.events(['pdf.refused'])).length, 2, 'marked again');
  assert.deepEqual(cards(k), [TITLE, TITLE]);
  assert.equal((await spoken(k)).at(-1), 'The lever, still.');
});
