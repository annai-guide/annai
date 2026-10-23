/**
 * OpenAI Realtime (the Koe and Kokoro plan, K6): a voice conversation in one stream over a WebSocket that annai
 * opens, as OpenAI's docs describe it (developers.openai.com, read 2026-10-19; no OpenAI key was at hand, so it is
 * proven against annai's stand-in and its device check is the real test):
 * - the address is …/realtime?model=<id>, and a browser gives the key as the subprotocol
 *   `openai-insecure-api-key.<key>` beside `realtime`. OpenAI's docs show a short-lived token there and steer
 *   browsers to tokens a server makes, which annai doesn't have; they don't say a standard key is refused;
 * - its JSON comes in text frames; a refusal is an `error` event, then a close (3000 "invalid_request_error" was
 *   seen), so an error before `session.updated` is the session's refusal, in OpenAI's words;
 * - G.711 μ-law in by default (decision 26): telephone audio, 8 kHz at a byte a sample, the 300–3400 Hz band that
 *   carries speech, for a sixth of the data of 24 kHz PCM; tokens are counted by time (a token per 100 ms of the
 *   user's audio), so the cost is the same. Koe's voice comes back as 24 kHz PCM. The tunables input and output
 *   choose (pcmu, pcma, pcm16), for the device check that compares them in a noisy car;
 * - turns are annai's (turn_detection null): its detector's cut commits the audio and asks for a response;
 * - a response is made faster than it plays: annai plays it as it comes, and the turn is complete when playing it
 *   would end, as Gemini's is. A cut-in cancels the response still being made and truncates what wasn't heard,
 *   where annai's player says it stopped (playedMs), else by the clock;
 * - a tool's answer starts no response unless one is asked for (`silent` asks for none); while a response is being
 *   made, what annai sends next waits for it to end, as OpenAI takes one response at a time; a response.create
 *   OpenAI refuses (its error names the create's event_id) ends that turn, and what waited goes;
 * - a session lasts at most an hour, with no handle to resume it: after renewMinutes, a goaway asks annai for a
 *   fresh one;
 * - usage comes with response.done, by modality, cached tokens apart;
 * - languages (phase 2; OpenAI's Realtime reference and transcription guide, read 2026-10-22): input transcription is "not native to the
 *   model" and takes `language` (one ISO-639-1 code, "will improve accuracy and latency") or, for gpt-transcribe and gpt-live-transcribe,
 *   `languages` (several; "Don't send both"); the model itself hears the audio, so what keeps it from taking a filler or one foreign
 *   word for a change of language is the instructions (OpenAI's prompting guide says so, and annai's setup carries the languages section).
 *   A Whisper-style model is given a language only when the user speaks exactly one: the first of several would force a sentence in the
 *   others into it. A session.update OpenAI refuses for those fields is sent again without them, once, and that is remembered for the
 *   transcription model until annai restarts (as a refused style is), whether the session goes on after the error or is closed (then it
 *   opens again without them).
 */

/** annai's formats as OpenAI names them. @param {{ format: string, rate: number }} f */
const wire = (f) => (f.format === 'pcm16' ? { type: 'audio/pcm', rate: f.rate } : { type: `audio/${f.format}` });
/**
 * What the transcription model is told of the user's languages (ISO-639-1 or -3 codes, once each, in order): gpt-transcribe and
 * gpt-live-transcribe take them all; another model one language, a two-letter ISO-639-1 code (no `yue`), when exactly one is listed.
 * @param {string} model @param {{ spoken?: { iso?: string }[] } | undefined} languages
 */
const hearing = (model, languages) => {
  const codes = [...new Set((languages?.spoken ?? []).map((l) => l?.iso).filter(Boolean))];
  if (/^gpt-(?:live-)?transcribe(?:-|$)/.test(model)) return codes.length ? { languages: codes } : {};
  return codes.length === 1 && /^[a-z]{2}$/.test(String(codes[0])) ? { language: codes[0] } : {};
};
/** A number, or 0. @param {unknown} x */
const n = (x) => Number(x) || 0;

/**
 * annai's usage from OpenAI's response usage: text, audio and image tokens apart, cached ones apart (cached audio and
 * images as cacheReadAudio and cacheReadImage, each priced on its own), output text and audio.
 * @param {any} u @returns {Record<string, number>}
 */
export function usageOf(u) {
  const d = u.input_token_details ?? {};
  const c = d.cached_tokens_details ?? {};
  const audio = n(d.audio_tokens);
  const image = n(d.image_tokens);
  const cachedAudio = n(c.audio_tokens);
  const cachedImage = n(c.image_tokens);
  const cachedText = c.text_tokens ?? Math.max(0, n(d.cached_tokens) - cachedAudio - cachedImage);
  const audioOut = n(u.output_token_details?.audio_tokens);
  return {
    input: Math.max(0, (d.text_tokens ?? n(u.input_tokens) - audio - image) - cachedText),
    cacheRead: n(cachedText), cacheReadAudio: cachedAudio, cacheReadImage: cachedImage,
    audioIn: Math.max(0, audio - cachedAudio), ...(image - cachedImage > 0 ? { image: image - cachedImage } : {}),
    output: u.output_token_details?.text_tokens ?? Math.max(0, n(u.output_tokens) - audioOut), audioOut,
  };
}

/** An OpenAI error's kind (spec §9.9). @param {any} e @returns {string} */
function kindOf(e) {
  const what = `${e?.code ?? ''} ${e?.type ?? ''}`;
  if (/api_key|authentication|unauthorized/i.test(what) || /api key|authentication/i.test(String(e?.message ?? ''))) return 'auth';
  if (/insufficient_quota|billing/.test(what)) return 'credit';
  if (/rate_limit/.test(what)) return 'rate';
  if (/not_found/.test(what)) return 'not-found';
  return /server_error/.test(what) ? 'server' : 'bad-request';
}

/** @param {any} annai */
export function activate(annai) {
  const { base64, ProviderError, g711 } = annai.helpers;
  // An official update reaches an annai still running its older shell until a restart: nothing ties the two (fix pass).
  if (!g711) throw new Error('OpenAI Realtime needs a newer annai: restart annai to update it, and this plugin starts.');
  // G.711, the telephone's 8 kHz audio at a byte a sample, is audio/pcmu and audio/pcma to OpenAI; annai's helper codes it at the wire.
  /** G.711's coders, both ways, by annai's format. @type {Record<string, [(pcm: Int16Array) => Uint8Array, (b: Uint8Array) => Int16Array]>} */
  const G711 = { pcmu: [g711.pcmToUlaw, g711.ulawToPcm], pcma: [g711.pcmToAlaw, g711.alawToPcm] };
  /** A note in the trace, every secret annai keeps blanked. @param {string} type @param {any} data */
  const note = (type, data) => Promise.resolve(annai.secrets?.blank(data) ?? data).then((x) => annai.events?.append('sys', type, x)).catch(() => {});
  /** Transcription models whose language fields OpenAI refused: asked without them from then on. @type {Set<string>} */
  const noHints = new Set();
  /** Models whose language fields were refused in the session now being opened: a close before it is ready reopens without them only then. @type {Set<string>} */
  const refusedNow = new Set();
  return annai.providers.register({
    type: 'openai-realtime',
    name: 'OpenAI Realtime',
    realtime: true,
    // input, output: the audio each way (pcmu, pcma, pcm16); voice: OpenAI's (marin and cedar are its best); transcription:
    // the model that writes down what the user says ('' for none); languageHints: the languages the user speaks, given to it (off: it detects);
    // noiseReduction: far_field (a phone on the dash), near_field or '';
    // renewMinutes: when to ask for a fresh session, as OpenAI ends one at 60.
    tunables: { input: 'pcmu', output: 'pcm16', voice: 'marin', transcription: 'gpt-transcribe', languageHints: true, noiseReduction: 'far_field', renewMinutes: 55 },
    audio: {
      in: [{ format: 'pcmu', rate: 8000 }, { format: 'pcma', rate: 8000 }, { format: 'pcm16', rate: 24000 }],
      out: [{ format: 'pcm16', rate: 24000 }, { format: 'pcmu', rate: 8000 }, { format: 'pcma', rate: 8000 }],
    },
    /** @param {any} c */
    open: ({ endpoint, model, key }) => ({
      url: `${String(endpoint.baseUrl).replace(/^http/, 'ws').replace(/\/+$/, '')}/realtime?model=${encodeURIComponent(model.providerId)}`,
      protocols: ['realtime', ...(key ? [`openai-insecure-api-key.${key}`] : [])],
    }),
    /** @param {any} socket @param {any} c */
    attach(socket, { tunables: t, setup, emit }) {
      /** @param {any} m */
      const send = (m) => socket.send(JSON.stringify(m));
      const heardBy = String(t.transcription ?? '');
      /** Whether the user's languages go with the transcription: not once OpenAI has refused them for this model. */
      const hinted = () => t.languageHints !== false && !noHints.has(heardBy);
      let retried = false;
      refusedNow.delete(heardBy);
      const encode = G711[setup.audioIn.format]?.[0];
      const decode = G711[setup.audioOut.format]?.[1];
      /** @type {(v?: unknown) => void} */
      let isReady = () => {};
      /** @type {(e: unknown) => void} */
      let refused = () => {};
      const ready = new Promise((resolve, reject) => { isReady = resolve; refused = reject; });
      let up = false;
      /** @type {any} */
      let renew = null;
      // OpenAI makes one response at a time: what annai sends while one is being made waits, in order, until it is done.
      let responding = false;
      /** @type {any[]} */
      const held = [];
      /** The response.create OpenAI hasn't taken up yet, by its event_id, which a refusal names; and how many were sent. */
      let pending = '';
      let made = 0;
      const flush = () => {
        while (held.length && !responding) {
          const m = held.shift();
          if (m.type === 'response.create') {
            responding = true;
            pending = m.event_id = `annai_response_${++made}`;
          }
          send(m);
        }
      };
      /** @param {any} m */
      const out = (m) => { held.push(m); flush(); };
      const respond = () => out({ type: 'response.create' });
      // Koe's voice as annai plays it, back to back as it comes: each item's start and length, and when all of it ends.
      /** r: the response it came in, counted. @type {{ id: string, at: number, ms: number, r: number }[]} */
      let items = [];
      let clock = 0;
      let responses = 0;
      /** Cancels sent whose response hasn't ended: that turn has ended as interrupted already. */
      let cuts = 0;
      /** Turns that end when their voice would have played. @type {Set<any>} */
      const ending = new Set();
      /** Transcripts so far, by item, so a final one adds only what the pieces didn't say. @type {Map<string, string>} */
      const so = new Map();
      /** Tool calls told: OpenAI says each twice. @type {Set<string>} */
      const told = new Set();
      /** @param {'heard' | 'said'} type @param {string} id @param {string} text @param {boolean} final */
      const words = (type, id, text, final) => {
        const before = so.get(id) ?? '';
        const add = !final ? text : text.startsWith(before) ? text.slice(before.length) : '';
        if (final) so.delete(id);
        else so.set(id, before + add);
        if (add || final) emit({ type, text: add, final });
      };
      /** @param {string} id @param {string} name @param {string} args */
      const tool = (id, name, args) => {
        if (!id || told.has(id)) return;
        told.add(id);
        /** @type {any} */
        let input = {};
        try {
          input = JSON.parse(args || '{}');
        } catch {
          // a call whose arguments aren't JSON: the tool says what it needs
        }
        emit({ type: 'tool', id, name: String(name ?? ''), input });
      };
      /**
       * Cuts off Koe's turn, if one is going on: the response being made is cancelled, and what wasn't heard truncated, where
       * annai's player says it stopped (playedMs: of the turn it plays, the newest response's items in order), else by the clock.
       * @param {number} [playedMs]
       */
      const cut = (playedMs) => {
        const now = Date.now();
        const making = responding && !cuts;
        const live = making || clock > now || ending.size > 0;
        if (!live && playedMs === undefined) return;
        if (making) {
          send({ type: 'response.cancel' });
          cuts++;
        }
        const last = items.at(-1)?.r;
        let left = playedMs ?? 0;
        for (const it of items) {
          const told = playedMs !== undefined && it.r === last;
          const heard = told ? left : now - it.at;
          if (told) left -= it.ms;
          if (heard < it.ms) send({ type: 'conversation.item.truncate', item_id: it.id, content_index: 0, audio_end_ms: Math.max(0, Math.floor(heard)) });
        }
        items = [];
        clock = now;
        for (const x of ending) clearTimeout(x);
        ending.clear();
        if (live) emit({ type: 'turn', end: 'interrupted' });
      };
      /** The response is done: its tools, its usage, and its turn's end. @param {any} r */
      const done = (r) => {
        for (const o of r?.output ?? []) if (o?.type === 'function_call') tool(o.call_id, o.name, o.arguments);
        if (r?.usage) emit({ type: 'usage', usage: usageOf(r.usage) });
        if (r?.status === 'failed' || r?.status === 'incomplete') note('live.error', { code: r.status, message: String(r.status_details?.error?.message ?? r.status_details?.reason ?? '') });
        responding = false;
        if (cuts) cuts--;
        else if (r?.status === 'cancelled') emit({ type: 'turn', end: 'interrupted' });
        else {
          const x = setTimeout(() => {
            ending.delete(x);
            emit({ type: 'turn', end: 'complete' });
          }, Math.max(0, clock - Date.now()));
          ending.add(x);
        }
        flush();
      };
      socket.on((/** @type {string | Uint8Array} */ d) => {
        /** @type {any} */
        let m;
        try {
          m = JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d));
        } catch {
          // Not OpenAI's JSON (a proxy's page, a cut frame): skipped and noted, never a crash that switches the plugin off.
          note('live.skipped', { bytes: typeof d === 'string' ? d.length : d.byteLength });
          return;
        }
        switch (m?.type) {
          case 'session.updated':
            if (!up) {
              up = true;
              refusedNow.delete(heardBy); // the refusal was dealt with in place
              renew = setTimeout(() => emit({ type: 'goaway', ms: Math.round((60 - t.renewMinutes) * 60_000) }), t.renewMinutes * 60_000);
              renew.unref?.(); // in Node's tests, a session's hour never holds the process
              isReady();
            }
            break;
          case 'error': {
            const e = m.error ?? {};
            const words = `${e.message ?? e.code ?? 'OpenAI refused the session.'}${e.param ? ` (${e.param})` : ''}`;
            if (!up && !retried && hinted() && Object.keys(hearing(heardBy, setup.languages)).length && /transcription\.languages?\b|\blanguages?\b/i.test(`${e.param ?? ''} ${e.message ?? ''}`)) {
              // Refused for the language fields: sent again without them (the session is not ready yet; it goes on, or its close opens another).
              retried = true;
              noHints.add(heardBy);
              refusedNow.add(heardBy);
              send(update());
            } else if (!up) refused(new ProviderError(kindOf(e), words));
            // A cancel that crossed the answer's end, or a commit with nothing in it: races annai expects, not errors.
            else if (!/^(response_cancel_not_active|input_audio_buffer_commit_empty)$/.test(e.code)) {
              // A response.create refused (by name, or before OpenAI took it up, by none): what waits behind it goes, and its
              // turn ends with nothing said; one refused as another was being made is asked for again once that one is done.
              if (pending && (!e.event_id || e.event_id === pending)) {
                pending = '';
                if (e.code === 'conversation_already_has_active_response') held.unshift({ type: 'response.create' });
                else {
                  responding = false;
                  if (cuts) cuts = 0;
                  else emit({ type: 'turn', end: 'complete' });
                  flush();
                }
              }
              note('live.error', { code: String(e.code ?? e.type ?? ''), message: words.slice(0, 300) });
            }
            break;
          }
          case 'response.created':
            pending = '';
            responses++;
            break;
          case 'response.output_audio.delta': {
            if (cuts) break; // the cancelled answer's, on its way before the cut: never heard
            const raw = base64.decode(String(m.delta ?? ''));
            const pcm = decode ? new Uint8Array(decode(raw).buffer) : raw;
            const ms = (pcm.byteLength / 2 / setup.audioOut.rate) * 1000;
            const now = Date.now();
            const start = Math.max(now, clock);
            clock = start + ms;
            if (items.at(-1)?.id !== m.item_id) items = [...items.filter((x) => x.at + x.ms > now), { id: m.item_id, at: start, ms: 0, r: responses }]; // the ones played, let go
            /** @type {{ ms: number }} */ (items.at(-1)).ms += ms;
            emit({ type: 'audio', data: pcm });
            break;
          }
          case 'response.output_audio_transcript.delta':
          case 'response.output_audio_transcript.done':
            if (cuts) so.delete(m.item_id);
            else words('said', m.item_id, String(m.delta ?? m.transcript ?? ''), m.type.endsWith('done'));
            break;
          case 'conversation.item.input_audio_transcription.delta':
            words('heard', m.item_id, String(m.delta ?? ''), false);
            break;
          case 'conversation.item.input_audio_transcription.completed':
            words('heard', m.item_id, String(m.transcript ?? ''), true);
            break;
          case 'conversation.item.input_audio_transcription.failed':
            note('live.error', { code: String(m.error?.code ?? 'transcription'), message: String(m.error?.message ?? '').slice(0, 300) });
            break;
          case 'response.function_call_arguments.done':
            tool(m.call_id, m.name, m.arguments);
            break;
          case 'response.done':
            done(m.response);
            break;
          default:
        }
      });
      /** The session's whole configuration, with or without the language fields. */
      const update = () => ({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: [setup.instructions, setup.context].filter(Boolean).join('\n\n'),
          output_modalities: ['audio'],
          audio: {
            input: { format: wire(setup.audioIn), turn_detection: null, transcription: t.transcription ? { model: heardBy, ...(hinted() ? hearing(heardBy, setup.languages) : {}) } : null, noise_reduction: t.noiseReduction ? { type: String(t.noiseReduction) } : null },
            output: { format: wire(setup.audioOut), ...(t.voice ? { voice: String(t.voice) } : {}) },
          },
          tools: setup.tools.map((/** @type {any} */ x) => ({ type: 'function', name: x.name, description: x.description, parameters: x.input })),
          tool_choice: 'auto',
        },
      });
      send(update());
      return {
        ready,
        audio: (/** @type {Uint8Array} */ chunk) => {
          const pcm = new Int16Array(chunk.slice().buffer, 0, chunk.byteLength >> 1);
          out({ type: 'input_audio_buffer.append', audio: base64.encode(encode ? encode(pcm) : new Uint8Array(pcm.buffer, 0, pcm.byteLength)) });
        },
        // A start cuts Koe off, as her voice is playing; the end commits what was said and asks for her answer.
        activity: (/** @type {'start' | 'end'} */ edge, /** @type {{ playedMs?: number }} */ o = {}) => {
          if (edge === 'start') {
            cut(o.playedMs);
            out({ type: 'input_audio_buffer.clear' });
          } else {
            out({ type: 'input_audio_buffer.commit' });
            respond();
          }
        },
        // An immediate note cuts Koe off first; without interrupt, a text turn waits for the answer being made.
        text: (/** @type {string} */ text, /** @type {{ interrupt?: boolean, playedMs?: number }} */ o = {}) => {
          if (o.interrupt) cut(o.playedMs);
          out({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
          respond();
        },
        // A photo joins the conversation; the words or speech that follow ask about it.
        image: (/** @type {{ mediaType: string, data: string }} */ i) => out({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:${i.mediaType};base64,${i.data}` }] } }),
        answer: (/** @type {string} */ id, /** @type {string} */ _name, /** @type {string} */ output, /** @type {{ silent?: boolean }} */ o = {}) => {
          out({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output } });
          if (!o.silent) respond();
        },
        cancel: () => cut(),
        // A tap stopped Koe's voice where it was heard (K5): the same cut, with nothing said after it.
        cut: (/** @type {number | undefined} */ playedMs) => cut(playedMs),
        close: () => {
          clearTimeout(renew);
          for (const x of ending) clearTimeout(x);
        },
      };
    },
    // A close's words: OpenAI's error type, as in 3000 "invalid_request_error".
    // A refusal of the language fields that closes the socket: opened again without them. Only a close that follows such a refusal in this
    // session, or whose words name the fields: a model that refused them once is not given a second try for every close before ready.
    reopen: (/** @type {number} */ _code, /** @type {string} */ reason, /** @type {any} */ t) => {
      const model = String(t.transcription ?? '');
      const refused = refusedNow.delete(model) || /languages?\b/i.test(reason);
      return t.languageHints !== false && refused ? { ...t, languageHints: false } : null;
    },
    classifyClose: (/** @type {number} */ _code, /** @type {string} */ reason) => (/server_error/.test(reason) ? 'server' : /invalid_request_error/.test(reason) ? 'bad-request' : null),
  });
}
