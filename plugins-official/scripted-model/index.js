/**
 * The scripted fake model (spec §18): an endpoint type that replies from a script instead of the
 * network, for deterministic, free tests. The script is the endpoint's `script` tunable, a list of
 * steps used one per call (the last one repeats):
 *   { text, reasoning, toolCalls: [{ name, input }], usage, delayMs }   a reply
 *   { error: kind, message, status, retryAfter }                        a failure (spec §9.9 kinds)
 *   { text, cut: true }                                                 says text, then the connection drops
 * @param {any} annai
 */
export function activate(annai) {
  const { ProviderError } = annai.helpers;
  /** @type {Map<string, number>} calls so far, by endpoint */
  const calls = new Map();
  return annai.providers.register({
    type: 'scripted',
    name: 'Scripted model (for testing)',
    tunables: { script: [{ text: 'Hello from the scripted model.' }] },
    /** @param {{ endpoint: any, signal?: AbortSignal }} c */
    async *run({ endpoint, signal }) {
      const script = Array.isArray(endpoint.tunables?.script) && endpoint.tunables.script.length ? endpoint.tunables.script : [{ text: '' }];
      const n = calls.get(endpoint.id) ?? 0;
      calls.set(endpoint.id, n + 1);
      const step = script[Math.min(n, script.length - 1)] ?? {};
      if (step.delayMs) await sleep(step.delayMs, signal);
      if (step.error) throw new ProviderError(step.error, step.message ?? `Scripted ${step.error}.`, { status: step.status, retryAfter: step.retryAfter });
      if (step.reasoning) yield { type: 'reasoning', text: step.reasoning };
      for (const piece of pieces(step.text ?? '')) yield { type: 'text', text: piece };
      if (step.cut) throw new ProviderError('network', 'The scripted connection dropped.');
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      for (const [i, c] of toolCalls.entries()) yield { type: 'tool_call', id: `scripted_${n}_${i}`, name: c.name, input: c.input ?? {} };
      yield { type: 'usage', usage: step.usage ?? { input: 12, output: 6 } };
      yield { type: 'stop', reason: toolCalls.length ? 'tool' : 'end' };
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
