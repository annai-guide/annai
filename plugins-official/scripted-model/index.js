/**
 * The scripted fake model (spec §18): an endpoint type that replies from a script instead of the
 * network, for deterministic, free tests. The script is the endpoint's `script` tunable, a list of
 * steps used one per call (the last one repeats):
 *   { text, reasoning, toolCalls: [{ name, input }], usage, delayMs }   a reply
 *   { error: kind, message, status, retryAfter }                        a failure (spec §9.9 kinds)
 *   { text, cut: true }                                                 says text, then the connection drops
 *   logprobs: [{ token, logprob }] reports the first token's alternatives; stop: the stop reason (default "tool" or "end").
 *   stream: true gives each tool call's arguments as tool_input events first, pieceMs apart; breakAt: n drops the connection after n of them.
 * With a rules tunable instead ([{ match, reply, then, times }]), the step depends on what woke her: the first
 * rule whose match (a case-insensitive regular expression) finds the request's "woke for:" line replies; a call
 * that follows tool results gets its rule's then (default: sleep); times limits how often a rule answers.
 * It reads no messages, so it takes the request as built, tail included (tail: true).
 * @param {any} annai
 */
export function activate(annai) {
  const { ProviderError } = annai.helpers;
  /** @type {Map<string, number>} calls so far, by endpoint */
  const calls = new Map();
  /** @type {Map<string, number>} how often each rule has answered, by endpoint and rule */
  const used = new Map();
  /**
   * The step for this call, from the rules (by what woke her) or the script (in turn).
   * @param {any} endpoint @param {any} request @param {number} n
   */
  const stepFor = (endpoint, request, n) => {
    const rules = Array.isArray(endpoint.tunables?.rules) ? endpoint.tunables.rules : null;
    if (!rules) {
      const script = Array.isArray(endpoint.tunables?.script) && endpoint.tunables.script.length ? endpoint.tunables.script : [{ text: '' }];
      return script[Math.min(n, script.length - 1)] ?? {};
    }
    const tail = String(request?.tail ?? '');
    const woke = /^woke for: (.*)$/m.exec(tail)?.[1] ?? tail;
    const last = request?.messages?.at(-1);
    // Results of its own tool calls come last; a new wake's words would follow them in the same message.
    const followUp = last?.role === 'user' && last.parts?.at(-1)?.type === 'tool_result';
    const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
    let i = 0;
    for (const r of rules) {
      const key = `${endpoint.id}:${i++}`;
      if (typeof r?.match !== 'string' || !new RegExp(r.match, 'i').test(woke)) continue;
      if (typeof r.times === 'number' && (used.get(key) ?? 0) >= r.times && !followUp) continue;
      if (followUp) return r.then ?? sleep;
      used.set(key, (used.get(key) ?? 0) + 1);
      return r.reply ?? sleep;
    }
    return sleep;
  };
  return annai.providers.register({
    type: 'scripted',
    name: 'Scripted model (for testing)',
    tunables: { script: [{ text: 'Hello from the scripted model.' }] },
    tail: true,
    /** @param {{ endpoint: any, signal?: AbortSignal, request?: any }} c */
    async *run({ endpoint, signal, request }) {
      const n = calls.get(endpoint.id) ?? 0;
      calls.set(endpoint.id, n + 1);
      const step = stepFor(endpoint, request, n);
      if (step.delayMs) await sleep(step.delayMs, signal);
      if (step.error) throw new ProviderError(step.error, step.message ?? `Scripted ${step.error}.`, { status: step.status, retryAfter: step.retryAfter });
      if (step.reasoning) yield { type: 'reasoning', text: step.reasoning };
      if (Array.isArray(step.logprobs)) yield { type: 'logprobs', top: step.logprobs };
      for (const piece of pieces(step.text ?? '')) yield { type: 'text', text: piece };
      if (step.cut) throw new ProviderError('network', 'The scripted connection dropped.');
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      for (const [i, c] of toolCalls.entries()) {
        const id = `scripted_${n}_${i}`;
        if (step.stream) {
          // The arguments as they would stream, 8 characters more each time.
          const json = JSON.stringify(c.input ?? {});
          let pieces = 0;
          for (let at = 8; at < json.length + 8; at += 8) {
            if (step.pieceMs) await sleep(step.pieceMs, signal);
            if (step.breakAt !== undefined && pieces++ >= step.breakAt) throw new ProviderError('network', 'The scripted connection dropped.');
            yield { type: 'tool_input', id, name: c.name, partial: json.slice(0, at) };
          }
        }
        yield { type: 'tool_call', id, name: c.name, input: c.input ?? {} };
      }
      yield { type: 'usage', usage: step.usage ?? { input: 12, output: 6 } };
      yield { type: 'stop', reason: step.stop ?? (toolCalls.length ? 'tool' : 'end') };
    },
    async list() {
      return [{ providerId: 'scripted', name: 'Scripted', contextWindow: 200000, maxOutput: 4096, input: ['text', 'image'], tools: true }];
    },
  });
}

/** Text in pieces of 8 characters, as a stream would bring it. @param {string} text */
function pieces(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 8) out.push(text.slice(i, i + 8));
  return out;
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}
