// The second drive, section 2: what the models are told, and what the user can read and change of it. Lines are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';
import { useClock } from './clock.js';
import { liveKit, soon, say, tone, texts } from './koe-live-kit.js';
import { CORE, DEFAULT_PERSONALITY } from '../../src/core/agent/instructions.js';
import { KOE_CORE, KOE_LIVE, KOKORO_PART, koeSystem } from '../../src/core/koe/instructions.js';
import { Transcript, linesOf } from '../../src/core/agent/transcript.js';
import { systemText, nextSnapshot, takeSnapshot } from '../../src/core/agent/context.js';
import { INSTRUCTIONS, instructionState, saveInstruction, resetInstruction, keepMyInstruction, editedInstructions } from '../../src/core/agent/her-instructions.js';
import { gatePrompt, GATE_OPTIONS } from '../../src/core/voice/gate.js';
import { traceSummary } from '../../src/ui/screens/trace.js';
import { readAppSettings, updateAppSettings } from '../../src/core/settings.js';
import { ME } from '../../src/core/scopes.js';
import { record } from '../../src/core/agent/log.js';

const none = { texts: {}, images: [] };
const ev = (/** @type {number} */ seq, /** @type {string} */ type, /** @type {any} */ data) => ({ seq, type, data });
const calls = (/** @type {any[][]} */ ...list) => ({ toolCalls: list.map(([name, input]) => ({ name, input })) });
const sleep = calls(['sleep', {}]);

test("Koe reads typed lines marked, one half's stay plain, and Kokoro's split lines say typed; a tap or a photo alone isn't typed", () => {
  const koe = new Transcript({ half: 'koe', nonce: 'n' });
  const one = new Transcript();
  for (const t of [koe, one]) t.apply(ev(1, 'msg.user', { text: 'teh hotel adress?', split: true }), none);
  assert.deepEqual(koe.messages[0].parts, [{ type: 'text', text: '[typed] teh hotel adress?' }]);
  assert.deepEqual(one.messages[0].parts, [{ type: 'text', text: 'teh hotel adress?' }]);
  const later = new Transcript({ half: 'koe', nonce: 'n' });
  later.apply(ev(1, 'msg.user', { text: 'The first', chose: true, split: true }), none);
  later.apply(ev(2, 'msg.user', { text: '(a photo)', images: [{}], split: true }), { texts: {}, images: [{ type: 'image', mediaType: 'image/webp', data: 'x', hash: 'h' }] });
  assert.deepEqual(later.messages[0].parts.filter((p) => p.type === 'text').map((p) => /** @type {any} */ (p).text), ['[the user chose] "The first"', '[the user sent a photo]']);
});

test('every prompt says how to read typed and heard words', () => {
  assert.match(CORE, /Plain lines are what the user typed: exactly what they wrote, so read them as written, allowing for typos\./);
  assert.match(KOKORO_PART, /\[the user typed\] is exactly what the user wrote; \[heard\] is speech recognition and may be wrong\./);
  for (const k of [KOE_CORE, KOE_LIVE]) {
    assert.match(k, /\[typed\] lines are exactly what the user wrote: read them as written, allowing for typos\./);
    assert.match(k, /speech recognition.*may be wrong/);
  }
});

test('a dismissed live line says only that nobody answered it, each half in its own words; the gate\'s keep "not meant for you"; a stored line needs no change', () => {
  const live = { id: 's-1', text: 'Okay, cool', source: 'live', half: 'koe', dismissed: true, gate: 'chatter' };
  const gated = { id: 's-2', text: 'did you lock the car', source: 'dictation', half: 'koe', dismissed: true, gate: 'chatter' };
  /** @param {any} half @param {any} d */
  const label = (half, d) => {
    const t = new Transcript({ half, nonce: 'n' });
    t.apply(ev(1, 'heard', d), none);
    return /** @type {any} */ (t.messages[0].parts[0]).text;
  };
  assert.equal(label('kokoro', live), "[heard, Koe didn't answer]");
  assert.equal(label('koe', live), "[heard, you didn't answer]");
  assert.equal(label('one', live), "[heard, you didn't answer]");
  for (const half of ['kokoro', 'koe', 'one']) assert.equal(label(half, gated), '[heard, not meant for you]');
  // Each label is defined where it is read.
  assert.ok(KOKORO_PART.includes("[heard, Koe didn't answer]"));
  for (const k of [KOE_CORE, KOE_LIVE, CORE]) assert.ok(k.includes("[heard, you didn't answer]"));
  assert.match(traceSummary({ type: 'heard', data: { ...live, ms: 0 } }), /she didn't answer/);
  assert.match(traceSummary({ type: 'heard', data: { ...gated, ms: 0 } }), /not for Shiori/);
});

test('recall says the same of a line nobody answered', async () => {
  const k = await agentKit([[sleep]]);
  await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-1', ms: 900, source: 'live', half: 'koe', dismissed: true, text: 'okay cool' } });
  await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-2', ms: 900, source: 'mic', dismissed: true, text: 'pass the water' } });
  const recall = /** @type {any} */ (k.agent.loopTools().find((/** @type {any} */ t) => t.name === 'recall'));
  const out = await recall.run({ query: 'o' }, {});
  assert.match(out, /heard, Koe didn't answer: okay cool/);
  assert.match(out, /someone said, not to Shiori: pass the water/);
});

test("Koe's prompts: a relay that states nothing it wasn't told", () => {
  for (const k of [KOE_CORE, KOE_LIVE]) {
    assert.match(k, /not a dedicated agent/);
    assert.match(k, /response engine and the voice for Kokoro/);
    assert.match(k, /State only what you have been told or have deliberately checked: a note from Kokoro, the <now> and <today> blocks, a tool's result, or what the user has just told you/);
    assert.match(k, /Never state anything from your own knowledge, and never trust it/);
    assert.match(k, /nothing about annai/);
    assert.match(k, /couple of words/);
    assert.match(k, /tell_kokoro/);
    assert.match(k, /No apologies, no sympathy, no "I understand" or "understood", no "I'll make sure" or "I will", no promises/);
    assert.match(k, /Silence is a fine answer\. Never change language because of a stray word/);
    assert.match(k, /Say nothing at all, not one word, to lyrics, music, other people talking, noise, single stray words, and anything in a language the Languages section doesn't list/);
    assert.match(k, /A note is always said, even if you were told earlier to stay silent: going to sleep ends with the session, and doesn't carry over/);
    assert.match(k, /If Kokoro can't be reached, say so plainly\. Never answer from your own knowledge instead\./);
    assert.match(k, /never say it's done until a note says so/);
    // What went.
    assert.doesNotMatch(k, /warmly|Stable general knowledge|apologise/);
  }
  assert.match(KOKORO_PART, /Koe knows only what you tell it: what the user should hear must be in a note/);
  assert.match(KOKORO_PART, /never write "stay silent until…" into the note/);
  assert.match(KOKORO_PART, /When it was clearly for Koe, tell Koe what to say/);
});

test('the listening rule: a speak listens by itself, and sleep is only for when no reply is expected', () => {
  assert.match(CORE, /A speak listens by itself: call sleep only when no reply is expected/);
  assert.match(KOE_CORE, /A speak listens by itself: call sleep only when no reply is expected/);
});

test("a personality can't undo Koe's rules, and the default isn't warm any more", () => {
  assert.doesNotMatch(DEFAULT_PERSONALITY, /warm/i);
  const snap = /** @type {any} */ ({ personality: '# Storyteller\nOffer short stories.', profile: '', memory: '', skills: [], trip: null, tripInfo: '', tripMemory: '' });
  const text = koeSystem(snap);
  assert.ok(text.indexOf("it never lets you state, offer or promise more than the rules above allow") < text.indexOf('# Storyteller'));
  assert.doesNotMatch(systemText(snap), /rules above allow/);
});

test('her instructions: no file is installed; saved words take the place of annai\'s at the next wake, warm cache or not; an empty or missing file uses annai\'s text', async () => {
  const k = await agentKit([[sleep]]);
  const take = () => takeSnapshot({ ws: k.ws, registry: k.registry, trip: k.trip, personalityName: 'shiori' });
  assert.deepEqual(await k.ws.list(ME, '/instructions/'), []);
  const first = await take();
  assert.deepEqual(first.edited, {});
  assert.ok(systemText(first).startsWith(CORE));
  for (const { id, original } of INSTRUCTIONS) assert.deepEqual(await instructionState(k.ws, id), { text: original, edited: false, newOriginal: null });
  await k.ws.write(ME, '/instructions/shiori.md', 'MY CORE', { author: 'user' });
  await k.ws.write(ME, '/instructions/koe.md', 'MY KOE', { author: 'user' });
  await k.ws.write(ME, '/instructions/koe-live.md', 'MY LIVE', { author: 'user' });
  await k.ws.write(ME, '/instructions/kokoro.md', '  \n', { author: 'user' });
  const next = nextSnapshot(first, await take(), { cold: false });
  assert.notEqual(next, first);
  assert.ok(systemText(next).startsWith('MY CORE'));
  assert.ok(koeSystem(next).startsWith('MY KOE'));
  assert.ok(koeSystem(next, true).startsWith('MY LIVE'));
  assert.equal(next.edited?.kokoro, undefined, 'an empty file uses annai\'s text');
  const same = await take();
  assert.equal(nextSnapshot(same, await take(), { cold: false }), same, 'nothing changed: the snapshot it had');
});

test("Kokoro's part comes from its file while Shiori is two halves", async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { koe: { type: { rules: [{ match: '.', reply: calls(['speak', { text: 'On it.' }], ['sleep', {}]) }] } } });
  await k.ws.write(ME, '/instructions/kokoro.md', '# MY KOKORO PART', { author: 'user' });
  k.agent.send('Hello');
  await k.agent.idle();
  const system = k.sent['model-0'][0].system;
  assert.ok(system.includes('# MY KOKORO PART'));
  assert.ok(!system.includes(KOKORO_PART));
});

test('Save, Reset and a new original: a file only for changed words, its base recorded, and the new original offered beside theirs', async () => {
  const k = await agentKit([[sleep]]);
  assert.equal(await saveInstruction(k.ws, 'koe', KOE_CORE), false, "annai's own words are no change");
  assert.ok(!(await k.ws.read(ME, '/instructions/koe.md')));
  assert.equal(await saveInstruction(k.ws, 'koe', 'mine'), true);
  assert.equal(await k.ws.readText(ME, '/instructions/koe.md'), 'mine');
  assert.ok((await readAppSettings(k.ws)).instructions.koe.based);
  assert.deepEqual(await instructionState(k.ws, 'koe'), { text: 'mine', edited: true, newOriginal: null });
  // annai's text changes under theirs: its hash no longer matches what they based theirs on.
  await updateAppSettings(k.ws, { instructions: { koe: { based: 'an older hash' } } });
  assert.deepEqual(await instructionState(k.ws, 'koe'), { text: 'mine', edited: true, newOriginal: KOE_CORE });
  await keepMyInstruction(k.ws, 'koe');
  assert.deepEqual(await instructionState(k.ws, 'koe'), { text: 'mine', edited: true, newOriginal: null });
  await resetInstruction(k.ws, 'koe');
  assert.ok(!(await k.ws.read(ME, '/instructions/koe.md')));
  assert.equal((await readAppSettings(k.ws)).instructions?.koe, undefined);
  assert.deepEqual(await editedInstructions(k.ws), {});
  await saveInstruction(k.ws, 'koe', 'mine');
  assert.equal(await saveInstruction(k.ws, 'koe', '  '), false, 'no words: the original');
  assert.ok(!(await k.ws.read(ME, '/instructions/koe.md')));
});

test('Shiori never writes her instructions, by any write tool; she can read them', async () => {
  const k = await agentKit([[sleep]]);
  await k.ws.write(ME, '/instructions/koe.md', 'mine', { author: 'user' });
  const call = { id: 'c', scope: k.trip, trip: k.trip, signal: new AbortController().signal, wake: 'w', author: 'shiori' };
  const tool = (/** @type {string} */ name) => /** @type {any} */ (k.registry.list('tool').find((/** @type {any} */ t) => t.name === name));
  for (const [name, input] of /** @type {[string, any][]} */ ([
    ['write', { path: '/me/instructions/koe.md', content: 'hers' }], ['write', { path: '/me/instructions/new.md', content: 'hers' }],
    ['edit', { path: '/me/instructions/koe.md', old: 'mine', new: 'hers' }], ['delete', { path: '/me/instructions/koe.md' }],
  ])) {
    await assert.rejects(async () => tool(name).run(input, call), /Your instructions are the user's to change/, `${name} ${input.path}`);
  }
  assert.equal(await k.ws.readText(ME, '/instructions/koe.md'), 'mine');
  assert.match(String(await tool('read').run({ path: '/me/instructions/koe.md' }, call)), /mine/);
});

test("the gate: reads the conversation's last lines and leans to her; the options stay", () => {
  const p = gatePrompt(['The user: "Can you do that by itself?"', 'She: "Noted."']);
  assert.match(p, /The conversation's last lines:\nThe user: "Can you do that by itself\?"\nShe: "Noted\."/);
  assert.match(p, /Speech about annai \(the app\), about how Shiori behaves, or about a thing just said is for her/);
  assert.match(p, /When unsure, it is for her: a wrong "for her" costs a short reply; a wrong "not for her" loses what the user said\./);
  assert.doesNotMatch(p, /with other people/);
  assert.match(gatePrompt([]), /Nothing has been said yet\./);
  assert.deepEqual(GATE_OPTIONS.map((o) => o.id), ['shiori', 'chatter']);
});

test('the gate gets the last few lines of the conversation in order, what was set aside left out, and later words used', async (t) => {
  useClock(t);
  const decide = [{ toolCalls: [{ name: 'decide', input: { option: 'A' } }] }];
  const k = await agentKit([[calls(['speak', { text: 'Bixby Bridge is ahead.' }]), sleep]], { voice: { decide, speechIn: ['m-hear'], hears: ['ok cool yeah'] } });
  await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-0', ms: 900, source: 'mic', text: 'for the people in the back', dismissed: true } });
  await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-1', ms: 900, source: 'mic' } });
  await record(k.store, k.trip, { type: 'heard.text', actor: 'system', data: { of: 's-1', text: 'are we close' } });
  k.agent.send('What is ahead?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  const gate = k.requests.find((/** @type {any} */ r) => String(r.system ?? '').startsWith('You make one quick decision'));
  const asked = gate.messages[0].parts[0].text;
  assert.match(asked, /The user: "are we close"\nThe user: "What is ahead\?"\nShe: "Bixby Bridge is ahead\."/);
  assert.doesNotMatch(asked, /people in the back/);
});

test('item 16: Kokoro reads voice on while Koe holds the voice; one half still reads its own turn', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { type: { rules: [{ match: '.', reply: calls(['speak', { text: 'On it.' }], ['sleep', {}]) }] } },
    voice: { mode: 'on', speechIn: ['m-hear'] },
  });
  k.agent.send('Hello');
  await k.agent.idle();
  assert.match(k.sent['model-0'][0].tail, /^voice: on/m, 'Koe talks, and voice is on');
  const off = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { type: { rules: [{ match: '.', reply: calls(['speak', { text: 'On it.' }], ['sleep', {}]) }] } },
    voice: { mode: 'off', speechIn: ['m-hear'] },
  });
  off.agent.send('Hello');
  await off.agent.idle();
  assert.match(off.sent['model-0'][0].tail, /^voice: off/m);
});

test('linesOf: what a model is sent, in lines; pictures and audio as a short line', () => {
  /** @type {any} */
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: '[heard]' }, { type: 'speech', id: 'a', text: 'hello' }, { type: 'speech', id: 'b' }, { type: 'image', mediaType: 'image/webp', data: 'AAAA', path: '/trip/a.webp' }, { type: 'document', mediaType: 'application/pdf', data: 'BBBB', name: 'a.pdf' }, { type: 'audio', data: 'CCCC' }] },
    { role: 'assistant', parts: [{ type: 'native', blob: 'x' }, { type: 'reasoning', text: 'hm' }, { type: 'text', text: 'private' }, { type: 'tool_call', id: 'c', name: 'read', input: { path: '/x' } }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'c', content: 'gone', isError: true }] },
  ];
  assert.deepEqual(linesOf(messages), ['[heard]', 'hello', '[audio, not transcribed]', '[a picture: /trip/a.webp]', '[a document: a.pdf]', '[audio]', '[its thinking] hm', '[its private text] private', '[it calls] read {"path":"/x"}', '[the result, an error] gone']);
  assert.doesNotMatch(linesOf(messages).join('\n'), /AAAA|BBBB|CCCC/);
});

test('what each half sees is what it was sent: the same system text, tools and conversation as its last request; Koe off says so', async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { koe: { type: { rules: [{ match: '.', reply: calls(['speak', { text: 'On it.' }], ['sleep', {}]) }] } } });
  k.agent.send('Is it far?');
  await k.agent.idle();
  const kokoro = await k.agent.sees('kokoro');
  const koe = await k.agent.sees('koe');
  assert.equal(kokoro.how, 'request');
  assert.equal(koe.how, 'request');
  if (kokoro.how !== 'request' || koe.how !== 'request') return;
  assert.equal(kokoro.one, false);
  assert.equal(kokoro.system, k.sent['model-0'].at(-1).system);
  assert.deepEqual(kokoro.tools, k.sent['model-0'].at(-1).tools.map((/** @type {any} */ x) => x.name));
  assert.ok(kokoro.lines.includes('[the user typed] "Is it far?"'));
  assert.ok(kokoro.lines.some((l) => l.startsWith('[it calls] sleep')), 'its tool calls show');
  assert.match(kokoro.tail, /<now>/);
  assert.equal(koe.system, k.sent['model-koe'].at(-1).system);
  assert.ok(koe.lines.includes('[typed] Is it far?'));
  assert.match(koe.tail, /<today>/);

  const one = await agentKit([[calls(['speak', { text: 'Hi.' }], ['sleep', {}])]], { halves: true });
  one.agent.send('Hi');
  await one.agent.idle();
  assert.deepEqual(await one.agent.sees('koe'), { how: 'off' });
  const all = await one.agent.sees('kokoro');
  assert.ok(all.how === 'request' && all.one && all.lines.includes('Hi'));
});

test('a live Koe: the setup it was given, then the lines since, labelled; with none going, the setup the next would get', async () => {
  const k = await liveKit([{ heard: 'Where should we eat?', said: 'Checking.', audio: tone() }, { said: 'Tacos.', audio: tone() }]);
  try {
    const before = await k.agent.sees('koe');
    assert.ok(before.how === 'live' && !before.open && before.lines.length === 0);
    assert.ok(before.how === 'live' && before.system.startsWith(KOE_LIVE));
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await say(k, 'where-eat');
    await soon(async () => (await k.events(['out.speak'])).length >= 1);
    k.agent.send('And a coffee?');
    await soon(async () => texts(k).includes('[typed] And a coffee?'));
    await soon(async () => (await k.events(['msg.user'])).length >= 1);
    const seen = await k.agent.sees('koe');
    assert.equal(seen.how, 'live');
    if (seen.how !== 'live') return;
    assert.equal(seen.open, true);
    assert.ok(seen.system.startsWith(KOE_LIVE));
    assert.ok(seen.tools.includes('tell_kokoro'));
    assert.ok(seen.lines.includes('[heard] Where should we eat?'), JSON.stringify(seen.lines));
    assert.ok(seen.lines.includes('[said to the user] "Checking."'), JSON.stringify(seen.lines));
    assert.ok(seen.lines.includes('[typed] And a coffee?'), JSON.stringify(seen.lines));
  } finally {
    await k.done();
  }
});

test('the conversation so far marks typed lines the same way', async () => {
  const k = await liveKit([{ said: 'Hello.', audio: tone() }]);
  try {
    await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'teh hotel?', split: true } });
    await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'The first', split: true, chose: true } });
    const seen = await k.agent.sees('koe');
    assert.ok(seen.how === 'live');
    if (seen.how !== 'live') return;
    assert.match(seen.context, /\[typed\] "teh hotel\?"/);
    assert.match(seen.context, /\[the user chose\] "The first"/);
  } finally {
    await k.done();
  }
});

