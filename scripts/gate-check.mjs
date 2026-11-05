#!/usr/bin/env node
// The classic gate against its real small model (Gemini Flash Lite, a free key): annai's own gatePrompt, decide and Gemini chat type, on
// synthetic lines shaped like what the gate got wrong on the second drive, and on clear chatter. Opt-in and never part of `npm run check`.
//   node scripts/gate-check.mjs --keys-file <path> --lines 1-11 [--times n] [--old <module>]    --old: a gate.js to compare with (an older commit's)
// A key is read inside the process and never printed; a free key costs nothing. It reports each case, and exits 1 when one goes the wrong way.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs, keysFrom } from './realtime/args.mjs';
import { decide } from '../src/core/llm/decide.js';
import { GATE_OPTIONS, gatePrompt } from '../src/core/voice/gate.js';
import { chatType } from '../plugins-official/gemini-api/chat.js';
import { sse } from '../src/core/llm/sse.js';
import { ProviderError } from '../src/core/llm/contract.js';

const MODEL = { providerId: 'gemini-3.5-flash-lite', reasoning: { off: {} }, maxOutput: 64 };
const SHE = 'She: "The next stop is about ten minutes away."';
/** lines: the conversation's last lines; heard: what the microphone heard; want: the right verdict. @type {{ name: string, lines: string[], heard: string, want: 'shiori' | 'chatter' }[]} */
const CASES = [
  { name: 'a comment on her behaviour, right after she spoke', lines: [SHE], heard: 'OK cool yeah maybe make this a default behavior for everything', want: 'shiori' },
  { name: 'a comment on what she just did', lines: ['The user: "Can you read it out?"', 'She: "Here it is."'], heard: 'That works, but it should probably do that by itself next time', want: 'shiori' },
  { name: 'a remark about the app', lines: [SHE], heard: 'hmm why did it cut off just now', want: 'shiori' },
  { name: 'answering a thing just said', lines: [SHE], heard: 'wait, you said ten minutes?', want: 'shiori' },
  { name: 'thinking aloud at her', lines: ['She: "There is a viewpoint coming up on the right."'], heard: 'yeah okay that one looks nice actually', want: 'shiori' },
  { name: 'a plain question, nothing said yet', lines: [], heard: 'how long until the next stop', want: 'shiori' },
  { name: 'a question to a passenger', lines: [SHE], heard: 'Did you lock the car before we left?', want: 'chatter' },
  { name: 'a phone call', lines: [SHE], heard: "Hi Mom, I can't talk right now, I'll call you back after dinner, love you", want: 'chatter' },
  { name: 'the radio', lines: [SHE], heard: 'and now traffic and weather together on the eights, brought to you by the valley furniture outlet', want: 'chatter' },
  { name: 'song lyrics', lines: [SHE], heard: 'oh baby baby dancing through the night, hold me till the morning light', want: 'chatter' },
  { name: 'asking someone in the back', lines: [SHE], heard: 'can you pass me the water bottle from the back seat', want: 'chatter' },
];

const { opts } = parseArgs(process.argv.slice(2), { flags: [] });
const keys = await keysFrom(opts, process.env);
const type = chatType(/** @type {any} */ ({ helpers: { sse, ProviderError } }));
const prompts = typeof opts.old === 'string' ? (await import(pathToFileURL(resolve(opts.old)).href)).gatePrompt : gatePrompt;
const old = typeof opts.old === 'string';

/** One request, as annai's Gemini chat type makes and reads it, the next key after a 429. @param {string} _role @param {any} request */
async function call(_role, request) {
  for (;;) {
    const r = type.build({ endpoint: { baseUrl: 'https://generativelanguage.googleapis.com' }, model: MODEL, key: keys.key, request });
    r.body.generation_config.thinking_level = 'minimal';
    const res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body) });
    if (res.status === 429 && keys.advance()) continue;
    if (!res.ok) throw new Error(keys.scrub(`${res.status} ${(await res.text()).slice(0, 300)}`));
    /** @type {any[]} */
    const parts = [];
    let text = '';
    for await (const ev of type.read(res, { request })) {
      if (ev.type === 'tool_call') parts.push(ev);
      if (ev.type === 'text') text += ev.text;
    }
    return { reply: { parts, text } };
  }
}

let wrong = 0;
for (const c of CASES.flatMap((x) => Array.from({ length: Number(opts.times ?? 1) }, () => x))) {
  // An older prompt took her last line alone.
  const prompt = old ? prompts((c.lines.at(-1) ?? '').replace(/^She: "|"$/g, '')) : prompts(c.lines);
  const r = await decide({ prompt, options: [...GATE_OPTIONS], call, parts: [{ type: 'text', text: c.heard }], fallback: false });
  // As loop.js reads it: only chatter over her is chatter; unsure is hers.
  const verdict = r.by === 'unsure' ? 'shiori' : (r.probabilities.chatter ?? 0) > (r.probabilities.shiori ?? 0) ? 'chatter' : 'shiori';
  const ok = verdict === c.want;
  if (!ok) wrong++;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${verdict.padEnd(8)}${r.by === 'unsure' ? ' (unsure)' : ''}  ${c.name}: "${c.heard}"`);
}
console.log(`${CASES.length * Number(opts.times ?? 1) - wrong} of ${CASES.length * Number(opts.times ?? 1)} right${keys.line ? `, last key on line ${keys.line}` : ''}`);
process.exit(wrong ? 1 : 0);
