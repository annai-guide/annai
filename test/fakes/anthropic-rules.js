/**
 * The API's rule for a server tool called beside a client tool in one reply (a web search or fetch beside a tool_use), as the real API
 * applies it (docs, "Mixing server tools and client tools in one turn"; the real API, Opus, Sonnet and Haiku 5.5, 2026-11-10): the server tool
 * is left for the next request, whose user message must hold nothing but tool_result blocks, wherever the reply is in the history and though
 * a later reply carries the tool's result; a reply after it that doesn't carry the result is refused too, and so is a request that would run it
 * without defining its tool. Shared by the Anthropic stand-ins
 * (anthropic-binding.js, and the end-to-end model server) so each refuses a request annai must never send.
 */

/** @param {any} b */
const resultOf = (b) => typeof b.type === 'string' && b.type !== 'tool_result' && b.type.endsWith('_tool_result');

/**
 * The server tool calls a request leaves for the next one: the refusal the real API gives when it is not as the docs say, or the calls
 * its last message answers (they are run now). @param {any} body @returns {{ no: string | null, run: any[] }}
 */
export function deferred(body) {
  /** @type {any[]} */
  const run = [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const [i, m] of messages.entries()) {
    if (m.role !== 'assistant' || i === messages.length - 1 || !Array.isArray(m.content)) continue; // a last reply is a paused turn, continued as it is
    const own = new Set(m.content.filter(resultOf).map((/** @type {any} */ b) => b.tool_use_id));
    const next = messages[i + 1];
    const after = messages[i + 2];
    for (const b of m.content) {
      if (b.type !== 'server_tool_use' || own.has(b.id)) continue;
      const only = next.role === 'user' && Array.isArray(next.content) && next.content.some((/** @type {any} */ x) => x.type === 'tool_result') && next.content.every((/** @type {any} */ x) => x.type === 'tool_result');
      const answered = after ? after.content.some((/** @type {any} */ x) => resultOf(x) && x.tool_use_id === b.id) : true;
      if (!only || !answered) return { no: `messages.${i}: \`${b.name}\` tool use with id \`${b.id}\` was found without a corresponding \`${b.name}_tool_result\` block`, run: [] };
      // Run by this request, it needs its tool defined in it (the real API, 2026-11-10).
      if (!after && !(Array.isArray(body.tools) ? body.tools : []).some((/** @type {any} */ t) => t.name === b.name)) {
        return { no: `\`${b.name}\` tool use with id \`${b.id}\` was found without a corresponding \`${b.name}_tool_result\` block, but no \`${b.name}\` tool was provided`, run: [] };
      }
      if (!after) run.push(b);
    }
  }
  return { no: null, run };
}

/** The result a server tool gives, as the API shapes it. @param {any} b a server_tool_use block */
export const resultFor = (b) => (b.name === 'web_fetch'
  ? { type: 'web_fetch_tool_result', tool_use_id: b.id, content: { type: 'web_fetch_result', url: String(b.input?.url ?? 'https://example.com/'), content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Example.' } } } }
  : { type: 'web_search_tool_result', tool_use_id: b.id, content: [{ type: 'web_search_result', url: 'https://example.com/result', title: 'Result', encrypted_content: 'E', page_age: null }] });
