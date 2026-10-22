/**
 * Gemini Live (the Koe and Kokoro plan, K4): Google's BidiGenerateContent over a WebSocket that annai opens. It
 * speaks the protocol as gemini-3.8-live was measured to on 2026-10-19:
 * - the key goes in the address (`?key=`), the only way a browser's WebSocket can give it;
 * - its JSON comes in binary frames;
 * - 16-bit PCM in at 16 kHz, 24 kHz out, in a burst faster than it plays;
 * - turns are manual (`activityStart`, `activityEnd`, automatic detection off): streaming speech alone never ended one;
 * - tools are declared as `parametersJsonSchema` (`parameters` refuses `additionalProperties`), and a call answered
 *   with `scheduling: "SILENT"` beside its response adds no filler turn (with it inside the response, it did);
 * - proactive audio (staying quiet to chatter) is a v1alpha field: v1beta refuses it with 1007 "Unknown name", and
 *   annai opens once more on v1beta without it (decision 11);
 * - errors are closes: 1007 for a bad field and for "API key not valid", 1008 for an unknown model;
 * - usage comes once a turn, with turnComplete, by modality; thinking is counted apart from the response;
 * - a turn cut off ends with `interrupted`, then a turnComplete (and its usage) of its own; on resuming, Gemini first
 *   finishes the answer it was giving when the connection went.
 */

/** @param {string} version */
const path = (version) => `/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent`;
/** The tokens of one modality in a usage's details. @param {any} details @param {string} modality */
const of = (details, modality) => (Array.isArray(details) ? details : []).filter((d) => d?.modality === modality).reduce((n, d) => n + (Number(d.tokenCount) || 0), 0);
/** "12s", "1.5s" in ms. @param {unknown} t */
const ms = (t) => Math.round((Number.parseFloat(String(t ?? '')) || 0) * 1000);

/**
 * annai's usage from Gemini's: audio, and image and video, tokens apart, cached ones as cache reads, thinking counted in the output.
 * @param {any} u @returns {Record<string, number>}
 */
export function usageOf(u) {
  const audioIn = of(u.promptTokensDetails, 'AUDIO');
  const image = of(u.promptTokensDetails, 'IMAGE') + of(u.promptTokensDetails, 'VIDEO');
  const audioOut = of(u.responseTokensDetails, 'AUDIO');
  const cacheRead = Number(u.cachedContentTokenCount) || 0;
  const reasoning = Number(u.thoughtsTokenCount) || 0;
  return {
    input: Math.max(0, (Number(u.promptTokenCount) || 0) + (Number(u.toolUsePromptTokenCount) || 0) - audioIn - image - cacheRead),
    cacheRead, audioIn, ...(image ? { image } : {}),
    output: Math.max(0, (Number(u.responseTokenCount) || 0) - audioOut) + reasoning,
    reasoning, audioOut,
  };
}

/** @param {any} annai */
export function activate(annai) {
  const { base64 } = annai.helpers;
  return annai.providers.register({
    type: 'gemini-live',
    name: 'Gemini Live',
    realtime: true,
    // apiVersion: v1alpha has proactive audio; voice: a prebuilt voice's name ('' for Gemini's own); compression: a sliding
    // window, as Gemini bills the whole context every turn.
    // heardLive: its input transcript streams in while the user speaks; with manual turns it came only after activityEnd, whole
    // (measured 2026-10-22, gemini-3.8-live), so a transcript that stops growing says nothing about a turn going on.
    tunables: { apiVersion: 'v1alpha', proactive: true, voice: '', compression: true, heardLive: false },
    audio: { in: [{ format: 'pcm16', rate: 16000 }], out: [{ format: 'pcm16', rate: 24000 }] },
    /** @param {any} c */
    open: ({ endpoint, key, tunables }) => ({
      url: `${String(endpoint.baseUrl).replace(/^http/, 'ws').replace(/\/+$/, '')}${path(tunables.apiVersion)}${key ? `?key=${encodeURIComponent(key)}` : ''}`,
    }),
    /** @param {any} socket @param {any} c */
    attach(socket, { model, tunables: t, setup, emit }) {
      /** @param {any} m */
      const send = (m) => socket.send(JSON.stringify(m));
      /** @type {() => void} */
      let isReady = () => {};
      const ready = new Promise((resolve) => { isReady = () => resolve(undefined); });
      // Gemini ends a cut-off turn with a turnComplete of its own, right after interrupted: that turn has ended once already.
      let cut = false;
      socket.on((/** @type {string | Uint8Array} */ d) => {
        /** @type {any} */
        let m;
        try {
          m = JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d));
        } catch {
          // Not Gemini's JSON (a proxy's page, a cut frame): skipped and noted, never a crash that switches the plugin off.
          annai.events?.append('sys', 'live.skipped', { bytes: typeof d === 'string' ? d.length : d.byteLength }).catch(() => {});
          return;
        }
        if (m.setupComplete) isReady();
        const sc = m.serverContent;
        if (sc?.modelTurn) cut = false; // new audio: a new turn (transcripts can trail the cut one)
        for (const p of sc?.modelTurn?.parts ?? []) if (p?.inlineData?.data && /^audio\//.test(p.inlineData.mimeType ?? '')) emit({ type: 'audio', data: base64.decode(p.inlineData.data) });
        if (sc?.inputTranscription?.text) emit({ type: 'heard', text: sc.inputTranscription.text, final: Boolean(sc.inputTranscription.finished) });
        if (sc?.outputTranscription?.text) emit({ type: 'said', text: sc.outputTranscription.text, final: Boolean(sc.outputTranscription.finished) });
        for (const f of m.toolCall?.functionCalls ?? []) emit({ type: 'tool', id: String(f.id ?? ''), name: String(f.name ?? ''), input: f.args ?? {} });
        if (m.usageMetadata) emit({ type: 'usage', usage: usageOf(m.usageMetadata) });
        if (sc?.interrupted) emit({ type: 'turn', end: 'interrupted' });
        if (sc?.turnComplete && !cut && !sc.interrupted) emit({ type: 'turn', end: 'complete' });
        cut = sc?.interrupted ? !sc.turnComplete : cut && !sc?.turnComplete;
        if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) emit({ type: 'resume', handle: m.sessionResumptionUpdate.newHandle });
        if (m.goAway) emit({ type: 'goaway', ms: ms(m.goAway.timeLeft) });
      });
      send({
        setup: {
          model: `models/${model.providerId}`,
          generationConfig: { responseModalities: ['AUDIO'], ...(t.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: String(t.voice) } } } } : {}) },
          systemInstruction: { parts: [{ text: [setup.instructions, setup.context].filter(Boolean).join('\n\n') }] },
          ...(setup.tools.length ? { tools: [{ functionDeclarations: setup.tools.map((/** @type {any} */ x) => ({ name: x.name, description: x.description, parametersJsonSchema: x.input })) }] } : {}),
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          sessionResumption: setup.resume ? { handle: setup.resume } : {},
          ...(t.compression ? { contextWindowCompression: { slidingWindow: {} } } : {}),
          ...(t.proactive ? { proactivity: { proactiveAudio: true } } : {}),
        },
      });
      return {
        ready,
        audio: (/** @type {Uint8Array} */ chunk) => send({ realtimeInput: { audio: { data: base64.encode(chunk), mimeType: `audio/pcm;rate=${setup.audioIn.rate}` } } }),
        activity: (/** @type {'start' | 'end'} */ edge) => send({ realtimeInput: edge === 'start' ? { activityStart: {} } : { activityEnd: {} } }),
        // A text turn while Gemini speaks cuts it off, as an immediate note should; annai sends an append only once the turn has ended.
        text: (/** @type {string} */ text) => send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }),
        // A photo joins the conversation; the words or speech that follow ask about it.
        image: (/** @type {{ mediaType: string, data: string }} */ i) => send({ clientContent: { turns: [{ role: 'user', parts: [{ inlineData: { mimeType: i.mediaType, data: i.data } }] }], turnComplete: false } }),
        answer: (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ result, /** @type {{ silent?: boolean }} */ o = {}) =>
          send({ toolResponse: { functionResponses: [{ id, name, response: { result }, ...(o.silent ? { scheduling: 'SILENT' } : {}) }] } }),
      };
    },
    // 1007 is a bad field or a bad key: the words tell them apart.
    classifyClose: (/** @type {number} */ code, /** @type {string} */ reason) => (/api key|permission/i.test(reason) ? 'auth' : code === 1007 ? 'bad-request' : null),
    /** @param {number} code @param {string} reason @param {any} t */
    reopen: (code, reason, t) => (code === 1007 && /proactivity/i.test(reason) && t.proactive ? { ...t, apiVersion: 'v1beta', proactive: false } : null),
  });
}
