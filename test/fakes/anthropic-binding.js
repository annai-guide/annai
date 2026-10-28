import { createHash } from 'node:crypto';

/**
 * A stand-in for Anthropic's Messages API as a fetch, that checks thinking blocks the way Claude 5.5 does (preserved thinking,
 * the `claude-api` docs, 2026-10): every reply starts with a thinking block whose signature binds the model and the conversation
 * before it (the system prompt, the tools, and every earlier message; earlier thinking blocks aren't part of it). A block
 * sent back after any of those changed is refused with a 400, as an enforced account's is; one another model signed is
 * dropped without a word. reply(body) gives the rest of each reply's content (tool_use and text blocks).
 * @param {(body: any) => any[]} reply
 */
export function anthropicStandIn(reply) {
  /** @type {any[]} every request body, in order */
  const bodies = [];
  /** @type {string[]} every refusal's message */
  const refused = [];
  /** @param {any} x */
  const bare = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)));
  /** The prefix a block made at this point is bound to. @param {any} body @param {any[]} messages */
  const bind = (body, messages) => createHash('sha256').update(JSON.stringify(bare({
    system: body.system ?? null, tools: body.tools ?? null,
    messages: messages.map((m) => ({ role: m.role, content: m.content.filter((/** @type {any} */ b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') })),
  }))).digest('hex');
  /** @param {any} body */
  const check = (body) => {
    for (const [i, m] of body.messages.entries()) {
      for (const [j, b] of m.content.entries()) {
        if (b.type !== 'thinking') continue;
        const [model, prefix] = String(b.signature).split('|');
        if (model !== body.model) continue; // another model's: dropped, unbilled
        if (prefix !== bind(body, [...body.messages.slice(0, i), { role: m.role, content: m.content.slice(0, j) }])) {
          return `messages.${i}.content.${j}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".`;
        }
      }
    }
    return null;
  };
  /** @param {string} url @param {RequestInit} init */
  const fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const no = check(body);
    if (no) {
      refused.push(no);
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: no } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const content = [{ type: 'thinking', thinking: 'Thinking it over.', signature: `${body.model}|${bind(body, body.messages)}` }, ...reply(body)];
    const ev = (/** @type {any} */ d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`;
    let out = ev({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } });
    for (const [index, b] of content.entries()) {
      if (b.type === 'tool_use') {
        out += ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        out += ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      } else if (b.type === 'thinking') {
        out += ev({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        out += ev({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
        out += ev({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
      } else {
        out += ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        out += ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
      }
      out += ev({ type: 'content_block_stop', index });
    }
    out += ev({ type: 'message_delta', delta: { stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
    out += ev({ type: 'message_stop' });
    return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, bodies, refused };
}
