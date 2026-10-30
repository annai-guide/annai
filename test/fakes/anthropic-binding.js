import { createHash } from 'node:crypto';

/**
 * A stand-in for Anthropic's Messages API as a fetch, that checks thinking blocks the way Claude 5.5 does on an enforced account (the
 * preserved-thinking docs, fetched 2026-10-29). Every reply starts with a thinking block whose signature binds:
 * - the model;
 * - everything sent before it but thinking blocks: the system prompt, the tools, every earlier message and the earlier blocks of its own reply;
 * - the thinking block before it, which a block chain needs (so a gap, or a block put back, is refused; removing the oldest or all is not);
 * - its own words ("cannot be modified").
 * A block sent back after any of those changed is refused with a 400; one another model signed is dropped without a word. reply(body) gives
 * the rest of each reply's content (tool_use, text with citations, server_tool_use and its result, more thinking), and may give
 * { content, stop } to choose the stop reason (pause_turn). Cache reads are counted as Anthropic counts them: an entry is written at each
 * marked block, and a later mark finds the longest entry within 20 blocks before it.
 * @param {(body: any) => any[] | { content: any[], stop: string }} reply
 * @param {{ empty?: boolean }} [o] empty: thinking comes back with no words (display "omitted"), the signature carrying it
 */
export function anthropicStandIn(reply, { empty = false } = {}) {
  /** @type {any[]} every request body, in order */
  const bodies = [];
  /** @type {string[]} every refusal's message */
  const refused = [];
  /** @type {any[]} each reply's usage, in order (of the requests answered) */
  const usage = [];
  /** Entries written, by the hash of what they hold. @type {Set<string>} */
  const cache = new Set();
  let refuseNext = false;
  /** @param {any} x */
  const bare = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)));
  const sha = (/** @type {any} */ x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
  const thinkingBlock = (/** @type {any} */ b) => b.type === 'thinking' || b.type === 'redacted_thinking';
  /** What a block at messages[i].content[j] is bound to, but the chain. @param {any} body @param {number} i @param {number} j */
  const prefixOf = (body, i, j) => sha(bare({
    system: body.system ?? null, tools: body.tools ?? null,
    messages: [...body.messages.slice(0, i), { role: body.messages[i]?.role, content: (body.messages[i]?.content ?? []).slice(0, j) }].map((m) => ({ role: m.role, content: m.content.filter((/** @type {any} */ b) => !thinkingBlock(b)) })),
  }));
  /** The signature of the nearest thinking block before messages[i].content[j] in this body, or ''. @param {any} body @param {number} i @param {number} j */
  const before = (body, i, j) => {
    for (let a = i; a >= 0; a--) {
      const c = body.messages[a].content;
      for (let b = (a === i ? j : c.length) - 1; b >= 0; b--) if (c[b].type === 'thinking') return String(c[b].signature);
    }
    return '';
  };
  const SEP = '~';
  /** @param {string} model @param {string} prefix @param {string} prev @param {string} words */
  const sign = (model, prefix, prev, words) => [model, prefix, sha(prev), sha(words)].join(SEP);
  /** @param {any} body */
  const check = (body) => {
    for (const [i, m] of body.messages.entries()) {
      for (const [j, b] of m.content.entries()) {
        if (b.type !== 'thinking') continue;
        const [model, prefix, prev, words] = String(b.signature).split(SEP);
        if (model !== body.model) continue; // another model's: dropped, unbilled
        if (prefix !== prefixOf(body, i, j)) return `messages.${i}.content.${j}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".`;
        // A chain: the block it followed is the one before it here, or every earlier one is gone (the oldest removed).
        const here = before(body, i, j);
        if (here ? sha(here) !== prev : false) return `messages.${i}.content.${j}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".`;
        if (words !== sha(b.thinking ?? '')) return `messages.${i}.content.${j}: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.`;
      }
    }
    return null;
  };
  /** The request's blocks in order (tools, system, then each message's), and the marked ones. @param {any} body */
  const blocksOf = (body) => {
    const all = [...(body.tools ?? []).map((/** @type {any} */ t) => ({ tool: t })), ...(body.system ?? []), ...body.messages.flatMap((/** @type {any} */ m) => m.content.map((/** @type {any} */ b, /** @type {number} */ k) => ({ ...b, ...(k === 0 ? { role: m.role } : {}) })))];
    return all;
  };
  /** Cache reads and writes, as Anthropic counts them (tokens: a block's JSON length / 4). @param {any} body */
  const cached = (body) => {
    const all = blocksOf(body);
    const keys = all.map((_, n) => sha(bare(all.slice(0, n + 1))));
    const tokens = all.map((b) => Math.ceil(JSON.stringify(bare(b)).length / 4));
    const upTo = (/** @type {number} */ n) => tokens.slice(0, n + 1).reduce((a, x) => a + x, 0);
    const marks = all.flatMap((b, n) => (b.cache_control ? [n] : []));
    let read = -1;
    for (const at of marks) for (let n = at; n >= Math.max(0, at - 20); n--) if (cache.has(keys[n])) { read = Math.max(read, n); break; }
    for (const at of marks) cache.add(keys[at]);
    const last = marks.at(-1) ?? -1;
    const total = upTo(all.length - 1);
    const cacheRead = read >= 0 ? upTo(read) : 0;
    const cacheWrite = last > read ? upTo(last) - cacheRead : 0;
    return { input_tokens: total - cacheRead - cacheWrite, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
  };
  /** @param {string} url @param {RequestInit} init */
  const fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const sent = body.messages.some((/** @type {any} */ m) => m.content.some((/** @type {any} */ b) => b.type === 'thinking' && String(b.signature).startsWith(`${body.model}${SEP}`)));
    /** @type {string | null} */
    let no = null;
    if (refuseNext && sent) {
      refuseNext = false;
      no = 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.';
    } else no = check(body);
    if (no) {
      refused.push(no);
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: no } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const given = reply(body);
    const { content: rest, stop: chosen } = Array.isArray(given) ? { content: given, stop: undefined } : given;
    // Each thinking block of the reply is signed for what comes before it, the reply's own earlier blocks included.
    const last = body.messages.at(-1);
    const continuing = last?.role === 'assistant';
    const words = empty ? '' : 'Thinking it over.';
    /** @type {any[]} */
    const content = [];
    for (const b of [{ type: 'thinking' }, ...rest]) {
      if (b.type !== 'thinking') {
        content.push(b);
        continue;
      }
      const msgs = continuing ? [...body.messages.slice(0, -1), { role: 'assistant', content: [...last.content, ...content] }] : [...body.messages, { role: 'assistant', content }];
      const at = { ...body, messages: msgs };
      const i = msgs.length - 1;
      const j = msgs[i].content.length;
      const text = b.thinking ?? words;
      content.push({ type: 'thinking', thinking: text, signature: sign(body.model, prefixOf(at, i, j), before(at, i, j), text) });
    }
    const u = cached(body);
    usage.push(u);
    const ev = (/** @type {any} */ d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`;
    let out = ev({ type: 'message_start', message: { usage: { ...u, output_tokens: 1 } } });
    for (const [index, b] of content.entries()) {
      if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        out += ev({ type: 'content_block_start', index, content_block: { type: b.type, id: b.id, name: b.name, input: {} } });
        out += ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      } else if (b.type === 'thinking') {
        out += ev({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        if (b.thinking) out += ev({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
        out += ev({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
      } else if (b.type === 'text') {
        out += ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        for (const c of b.citations ?? []) out += ev({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation: c } });
        out += ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
      } else {
        out += ev({ type: 'content_block_start', index, content_block: b });
      }
      out += ev({ type: 'content_block_stop', index });
    }
    const stop = chosen ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    out += ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } });
    out += ev({ type: 'message_stop' });
    return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  /** The next request that carries one of this stand-in's thinking blocks is refused, whatever it holds (a rule the docs don't name). */
  const refuseOnce = () => { refuseNext = true; };
  return { fetch, bodies, refused, usage, refuseOnce };
}
