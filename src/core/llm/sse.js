import { ProviderError } from './contract.js';

/**
 * Server-sent events from a response body: "the streamed-response reader" (spec §9.1).
 * Comment lines (":", such as OpenRouter's keep-alives) are skipped. Lines may end in \n, \r\n or
 * \r, and a character may be split between chunks. Stopping early cancels the body. A connection
 * that drops mid-stream is a ProviderError of kind "network"; an abort stays an abort.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{ event: string, data: string }>}
 */
export async function* sse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  /** @type {string[]} */
  let data = [];
  let finished = false;
  /** @param {string} line @returns {{ event: string, data: string } | null} an event, when the line ends one */
  const take = (line) => {
    if (line === '') {
      const out = data.length ? { event: event || 'message', data: data.join('\n') } : null;
      event = '';
      data = [];
      return out;
    }
    if (line.startsWith(':')) return null;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return null;
  };
  try {
    for (;;) {
      /** @type {ReadableStreamReadResult<Uint8Array>} */
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        const name = /** @type {any} */ (e)?.name;
        if (name === 'AbortError' || name === 'TimeoutError') throw e;
        throw new ProviderError('network', 'The connection dropped.', { cause: e });
      }
      const { value, done } = chunk;
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (;;) {
        const i = buf.search(/[\r\n]/);
        if (i < 0) break;
        if (buf[i] === '\r' && i === buf.length - 1 && !done) break; // a \n may follow in the next chunk
        const line = buf.slice(0, i);
        buf = buf.slice(buf[i] === '\r' && buf[i + 1] === '\n' ? i + 2 : i + 1);
        const out = take(line);
        if (out) yield out;
      }
      if (done) {
        if (buf) take(buf);
        buf = '';
        const out = take('');
        if (out) yield out;
        finished = true;
        return;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
