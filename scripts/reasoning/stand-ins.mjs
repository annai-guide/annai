// The reasoning check against stand-ins (no network, no key): the test stand-ins for Claude on Anthropic's API and through OpenRouter,
// each answering as Koe and Kokoro would in the check's conversation, so the run and its checks are tried here before a real run.
import { anthropicStandIn } from '../../test/fakes/anthropic-binding.js';
import { openRouterStandIn } from '../../test/fakes/openrouter-claude.js';
import { PROVIDERS } from './run.mjs';

/**
 * What a request ends with: the words since the last reply, the tools whose results it brings, and whether it is Koe's (Haiku).
 * @typedef {{ koe: boolean, text: string, results: string[] }} View
 */

/** The next reply, as names and inputs, for what a request ends with. @param {View} v @returns {{ text?: string, calls: { name: string, input: any }[] }} */
function next({ koe, text, results }) {
  const dinner = /dinner/i.test(text);
  if (koe) {
    if (/woke for: a note from Kokoro/.test(text)) return { calls: [{ name: 'speak', input: { text: dinner ? 'Dinner is at the Lantern at 19:30.' : 'You stay at the Seaview Inn; check-in is from 15:00.' } }, { name: 'sleep', input: {} }] };
    if (/woke for: the user wrote/.test(text)) return { calls: [{ name: 'speak', input: { text: 'Let me look.' } }, { name: 'tell_kokoro', input: { text: dinner ? 'Where is dinner on the 3rd?' : 'Where do they stay, and when is check-in?' } }, { name: 'sleep', input: {} }] };
    return { calls: [{ name: 'sleep', input: {} }] };
  }
  // A new wake starts the lookups (the last turn's results may share its message).
  if (/woke for:/.test(text) && !results.some((r) => r === 'list' || r === 'read')) return { text: '', calls: [{ name: 'list', input: { path: '/trip/notes/' } }] };
  if (results.includes('read')) return { calls: [{ name: 'tell_koe', input: { text: dinner ? 'Dinner on the 3rd: the Lantern, 19:30.' : 'The Seaview Inn, 12 Harbor Road; check-in from 15:00.' } }] };
  if (results.includes('list')) return { calls: [{ name: 'read', input: { path: dinner ? '/trip/notes/dinner.md' : '/trip/notes/hotel.md' } }] };
  if (results.length) return { calls: [{ name: 'sleep', input: {} }] };
  return { text: '', calls: [{ name: 'list', input: { path: '/trip/notes/' } }] };
}

/** Every text of a conversation the stand-in sees, for what it is about (dinner or the hotel). @param {any[]} texts */
const about = (texts) => texts.filter((t) => typeof t === 'string').join('\n');

/** The stand-ins as one fetch, by address; and what each refused. */
export function standIns() {
  let n = 0;
  const anthropic = anthropicStandIn((body) => {
    const last = body.messages.at(-1);
    const called = new Map(body.messages.flatMap((/** @type {any} */ m) => m.content).filter((/** @type {any} */ b) => b.type === 'tool_use').map((/** @type {any} */ b) => [b.id, b.name]));
    const all = about(body.messages.filter((/** @type {any} */ m) => m.role === 'user').flatMap((/** @type {any} */ m) => m.content.map((/** @type {any} */ b) => b.text)));
    const v = { koe: body.model === PROVIDERS.anthropic.koe, text: last.content.map((/** @type {any} */ b) => b.text ?? b.content ?? '').join('\n') + (/dinner/i.test(all.split('Thanks').at(-1) ?? '') ? '\ndinner' : ''), results: last.content.filter((/** @type {any} */ b) => b.type === 'tool_result').map((/** @type {any} */ b) => called.get(b.tool_use_id)) };
    const r = next(v);
    return [...(r.text ? [{ type: 'text', text: r.text }] : []), ...r.calls.map((c) => ({ type: 'tool_use', id: `toolu_check_${++n}`, name: c.name, input: c.input }))];
  });
  const openrouter = openRouterStandIn((body) => {
    const i = body.messages.findLastIndex((/** @type {any} */ m) => m.role === 'assistant');
    const after = body.messages.slice(i + 1);
    const called = new Map(body.messages.flatMap((/** @type {any} */ m) => m.tool_calls ?? []).map((/** @type {any} */ c) => [c.id, c.function.name]));
    const words = (/** @type {any} */ c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('\n') : '');
    const all = about(body.messages.filter((/** @type {any} */ m) => m.role === 'user').map((/** @type {any} */ m) => words(m.content)));
    const v = { koe: body.model === PROVIDERS.openrouter.koe, text: after.map((/** @type {any} */ m) => words(m.content)).join('\n') + (/dinner/i.test(all.split('Thanks').at(-1) ?? '') ? '\ndinner' : ''), results: after.filter((/** @type {any} */ m) => m.role === 'tool').map((/** @type {any} */ m) => called.get(m.tool_call_id)) };
    return next(v);
  });
  const fetch = (/** @type {string} */ url, /** @type {RequestInit} */ init) => (new URL(url).host === PROVIDERS.openrouter.host ? openrouter.fetch(url, init) : anthropic.fetch(url, init));
  return { fetch, refused: () => [...anthropic.refused, ...openrouter.refused] };
}
