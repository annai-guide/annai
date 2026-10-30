import { createHash } from 'node:crypto';

/**
 * A stand-in for Claude through OpenRouter's Chat Completions, as a fetch (the keep-reasoning design, "Stand-ins"). Each reply streams its
 * thinking as reasoning_details in OpenRouter's documented shape (summarized words in pieces, then the signature, format
 * "anthropic-claude-v1"), and the signature binds the system message, the tools and every message before the assistant message it is
 * on (reasoning_details and cache markers left out). A request whose signed details no longer match is refused as OpenRouter passes on
 * Anthropic's 400, its words in metadata.raw. Cache reads are counted as Anthropic counts them (an entry at each marked block, found
 * within 20 blocks of a later mark), as prompt_tokens_details.cached_tokens. reply(body) gives each reply: its text and tool calls.
 * @param {(body: any) => { text?: string, calls?: { name: string, input: any }[] }} reply
 */
export function openRouterStandIn(reply) {
  /** @type {any[]} */
  const bodies = [];
  /** @type {string[]} */
  const refused = [];
  /** @type {any[]} each answered request's usage */
  const usage = [];
  /** @type {Set<string>} */
  const cache = new Set();
  let n = 0;
  const sha = (/** @type {any} */ x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
  /** @param {any} x */
  const bare = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' || k === 'reasoning_details' ? undefined : v)));
  /** What a reply's thinking before messages[i] is bound to. @param {any} body @param {number} i */
  const prefixOf = (body, i) => sha(bare({ tools: body.tools ?? null, messages: body.messages.slice(0, i) }));
  const SEP = '~';
  /** @param {any} body */
  const check = (body) => {
    for (const [i, m] of body.messages.entries()) {
      for (const d of m.role === 'assistant' && Array.isArray(m.reasoning_details) ? m.reasoning_details : []) {
        if (!d.signature) continue;
        const [model, prefix, words] = String(d.signature).split(SEP);
        if (model !== body.model) continue;
        if (prefix !== prefixOf(body, i)) return `messages.${i}.content.0: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.`;
        if (words !== sha(d.text ?? '')) return `messages.${i}.content.0: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified.`;
      }
    }
    return null;
  };
  /** Each content block in order: a string content is one block. @param {any} body */
  const blocksOf = (body) => [...(body.tools ?? []).map((/** @type {any} */ t) => ({ tool: t })), ...body.messages.flatMap((/** @type {any} */ m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content ?? '', calls: m.tool_calls ?? null }]).map((/** @type {any} */ b, /** @type {number} */ k) => ({ ...b, ...(k === 0 ? { role: m.role } : {}) })))];
  /** @param {any} body */
  const cached = (body) => {
    const all = blocksOf(body);
    const keys = all.map((_, i) => sha(bare(all.slice(0, i + 1))));
    const tokens = all.map((b) => Math.ceil(JSON.stringify(bare(b)).length / 4));
    const upTo = (/** @type {number} */ i) => tokens.slice(0, i + 1).reduce((a, x) => a + x, 0);
    const marks = all.flatMap((b, i) => (b.cache_control ? [i] : []));
    let read = -1;
    for (const at of marks) for (let i = at; i >= Math.max(0, at - 20); i--) if (cache.has(keys[i])) { read = Math.max(read, i); break; }
    for (const at of marks) cache.add(keys[at]);
    const last = marks.at(-1) ?? -1;
    const total = upTo(all.length - 1);
    const hit = read >= 0 ? upTo(read) : 0;
    return { prompt_tokens: total, completion_tokens: 5, prompt_tokens_details: { cached_tokens: hit, cache_write_tokens: last > read ? upTo(last) - hit : 0 } };
  };
  /** @param {string} _url @param {RequestInit} init */
  const fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const no = check(body);
    if (no) {
      refused.push(no);
      const raw = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: no } });
      return new Response(JSON.stringify({ error: { code: 400, message: 'Provider returned error', metadata: { raw, provider_name: 'Anthropic' } } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const r = reply(body);
    const words = 'Thinking it over.';
    const signature = [body.model, prefixOf(body, body.messages.length), sha(words)].join(SEP);
    const F = 'anthropic-claude-v1';
    /** @type {any[]} */
    // OpenRouter names the provider that served the request on every chunk.
    const chunks = [
      { choices: [{ delta: { reasoning: 'Thinking ', reasoning_details: [{ type: 'reasoning.text', text: 'Thinking ', format: F, index: 0 }] } }] },
      { choices: [{ delta: { reasoning: 'it over.', reasoning_details: [{ type: 'reasoning.text', text: 'it over.', format: F, index: 0 }] } }] },
      { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', signature, format: F, index: 0 }] } }] },
    ];
    if (r.text) chunks.push({ choices: [{ delta: { content: r.text } }] });
    for (const [index, c] of (r.calls ?? []).entries()) chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: `toolu_or_${++n}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }] } }] });
    const u = cached(body);
    usage.push(u);
    chunks.push({ choices: [{ delta: {}, finish_reason: r.calls?.length ? 'tool_calls' : 'stop' }], usage: u });
    return new Response(`${chunks.map((c) => `data: ${JSON.stringify({ provider: 'Anthropic', ...c })}\n\n`).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, bodies, refused, usage };
}
