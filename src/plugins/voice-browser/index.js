import { encodeWav } from '../../core/voice/pcm.js';

/**
 * The device side of voice (spec §10), a built-in plugin (§19): one audio player for every voice
 * clip, unlocked by the first tap of each session (an iPhone rule, §10.1); the browser's own
 * voice; the microphone, through an AudioWorklet (§10.2); the phone's dictation; the audio devices,
 * for voice Auto (§10.5); and the audio session type where the browser has one (Safari). The core reaches it as 'voice-platform'.
 * @typedef {import('../../core/voice/platform.js').VoicePlatform} VoicePlatform
 */
export const manifest = { id: 'voice-browser', name: 'Voice on this device', version: '0.1.0', api: 1, description: "The phone's speaker, microphone, voice and dictation." };

/** @param {any} annai */
export function activate(annai) {
  return annai.register('voice-platform', browserPlatform());
}

/** @returns {VoicePlatform} */
export function browserPlatform() {
  /** @type {AudioContext | null} */
  let ctx = null;
  const context = () => (ctx ??= new AudioContext());
  /** @type {HTMLAudioElement | null} */
  let element = null;
  const player = () => (element ??= new Audio());
  /** @type {Promise<void> | null} */
  let worklet = null;

  /**
   * The clip's loudness every 50 ms, 0..1, for the glow (spec §16.3), read with Web Audio's
   * decoder: playback itself stays on the audio element. @param {{ data: Uint8Array }} clip
   */
  async function envelope(clip) {
    const buf = await context().decodeAudioData(clip.data.slice().buffer);
    const ch = buf.getChannelData(0);
    const step = Math.max(1, Math.round(buf.sampleRate * 0.05));
    /** @type {number[]} */
    const rms = [];
    for (let i = 0; i < ch.length; i += step) {
      let s = 0;
      const end = Math.min(ch.length, i + step);
      for (let j = i; j < end; j++) s += ch[j] * ch[j];
      rms.push(Math.sqrt(s / (end - i)));
    }
    const peak = Math.max(1e-6, ...rms);
    return rms.map((x) => Math.min(1, x / peak));
  }

  return {
    player: {
      unlock() {
        // Inside a tap: the player, the microphone's context and the browser voice may start. Each is
        // started now, in the tap; after a wait it would no longer count. Until the player played, every tap tries again.
        /** @type {Promise<boolean>} */
        let played;
        try {
          const a = player();
          a.src = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (encodeWav(new Float32Array(800), 16000))], { type: 'audio/wav' }));
          played = a.play().then(() => true, () => false);
        } catch {
          played = Promise.resolve(false);
        }
        context().resume().catch(() => {});
        try {
          const quiet = new SpeechSynthesisUtterance(' ');
          quiet.volume = 0;
          speechSynthesis.speak(quiet);
        } catch {
          // no browser voice here
        }
        return played;
      },
      async play(clip, { signal, onLevel = () => {} }) {
        if (signal.aborted) return { ended: false, fraction: 0 };
        const a = player();
        const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (clip.data)], { type: clip.mediaType }));
        /** @type {number[] | null} */
        let levels = null;
        envelope(clip).then((l) => { levels = l; }, () => {});
        /** @type {ReturnType<typeof setInterval> | undefined} */
        let ticker;
        /** @type {() => void} */
        let stop = () => {};
        try {
          a.src = url;
          await a.play(); // a NotAllowedError: the page may not play sound yet
          if (signal.aborted) {
            a.pause();
            return { ended: false, fraction: 0 };
          }
          ticker = setInterval(() => { if (levels) onLevel(levels[Math.floor(a.currentTime / 0.05)] ?? 0); }, 50);
          return await new Promise((resolve, reject) => {
            a.onended = () => resolve({ ended: true, fraction: 1 });
            a.onerror = () => reject(new Error("The voice's audio couldn't be played."));
            stop = () => {
              const fraction = a.duration > 0 ? a.currentTime / a.duration : 0;
              a.pause();
              resolve({ ended: false, fraction });
            };
            signal.addEventListener('abort', stop, { once: true });
          });
        } finally {
          // A stop that comes later must not pause the next clip on this one player.
          signal.removeEventListener('abort', stop);
          clearInterval(ticker);
          a.onended = null;
          a.onerror = null;
          onLevel(0);
          URL.revokeObjectURL(url);
        }
      },
    },
    synth: {
      available: () => typeof speechSynthesis !== 'undefined',
      voices: () => (typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices().map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }))),
      say(text, { signal, voice, rate = 1, lang, onLevel = () => {} }) {
        return new Promise((resolve, reject) => {
          const u = new SpeechSynthesisUtterance(text);
          const chosen = voice ? speechSynthesis.getVoices().find((v) => v.voiceURI === voice) : undefined;
          if (chosen) u.voice = chosen;
          else if (lang) u.lang = lang;
          u.rate = rate;
          let charIndex = 0;
          let level = 0;
          let settled = false;
          // The browser voice gives no audio to measure: the glow pulses with each word (spec §16.3).
          const pulse = setInterval(() => { level = Math.max(0.3, level * 0.7); onLevel(level); }, 60);
          // Some voices never say they finished: a generous limit ends the wait.
          const limit = setTimeout(() => finish({ ended: true, charIndex: text.length }), 4000 + text.length * 150);
          const stop = () => {
            speechSynthesis.cancel();
            finish({ ended: false, charIndex });
          };
          /** @param {{ ended: boolean, charIndex: number } | null} r @param {Error} [err] */
          const finish = (r, err) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', stop); // a later stop must not cancel the next sentence
            clearInterval(pulse);
            clearTimeout(limit);
            onLevel(0);
            if (err || !r) reject(err);
            else resolve(r);
          };
          u.onboundary = (e) => {
            if (!e.name || e.name === 'word') {
              charIndex = e.charIndex;
              level = 0.8;
            }
          };
          u.onend = () => finish(signal.aborted ? { ended: false, charIndex } : { ended: true, charIndex: text.length });
          u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? finish({ ended: false, charIndex }) : finish(null, new Error(`The browser voice couldn't speak (${e.error}).`)));
          signal.addEventListener('abort', stop, { once: true });
          speechSynthesis.speak(u);
        });
      },
    },
    mic: {
      async open({ onFrames, onError }) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        try {
          const c = context();
          if (c.state !== 'running') await c.resume().catch(() => {});
          worklet ??= c.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
          try {
            await worklet;
          } catch (e) {
            worklet = null;
            throw e;
          }
          const source = c.createMediaStreamSource(stream);
          const node = new AudioWorkletNode(c, 'annai-capture');
          const silent = c.createGain();
          silent.gain.value = 0;
          node.port.onmessage = (e) => onFrames(e.data, c.sampleRate);
          source.connect(node);
          node.connect(silent).connect(c.destination); // some browsers run a node only when it leads somewhere
          for (const t of stream.getAudioTracks()) t.onended = () => onError(new Error('The microphone stopped.'));
          return {
            close() {
              node.port.onmessage = null;
              for (const t of stream.getTracks()) {
                t.onended = null;
                t.stop();
              }
              source.disconnect();
              node.disconnect();
              silent.disconnect();
            },
          };
        } catch (e) {
          for (const t of stream.getTracks()) t.stop();
          throw e;
        }
      },
    },
    dictation: {
      available: () => Boolean(/** @type {any} */ (globalThis).SpeechRecognition || /** @type {any} */ (globalThis).webkitSpeechRecognition),
      open({ lang, onSegment, onSpeech, onError }) {
        const Recognition = /** @type {any} */ (globalThis).SpeechRecognition ?? /** @type {any} */ (globalThis).webkitSpeechRecognition;
        const r = new Recognition();
        r.continuous = true;
        r.interimResults = true;
        r.lang = lang || navigator.language;
        let closed = false;
        r.onspeechstart = () => onSpeech?.();
        r.onresult = (/** @type {any} */ e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            const text = res.isFinal ? String(res[0]?.transcript ?? '').trim() : '';
            if (text) onSegment(text);
          }
        };
        r.onerror = (/** @type {any} */ e) => {
          if (e.error === 'no-speech' || e.error === 'aborted') return;
          closed = true;
          onError(Object.assign(new Error(`Phone dictation stopped (${e.error}).`), { code: String(e.error) }));
        };
        // Dictation ends by itself after a silence; while listening goes on, it starts again.
        r.onend = () => {
          if (closed) return;
          try {
            r.start();
          } catch {
            // started too soon: the next end tries again
          }
        };
        r.start();
        return {
          close() {
            closed = true;
            try {
              r.abort();
            } catch {
              // already stopped
            }
          },
        };
      },
    },
    async devices() {
      // Names come only once the microphone was allowed (spec §10.5: without them Auto can't tell).
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      return (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, label: d.label }));
    },
    onDeviceChange(fn) {
      navigator.mediaDevices?.addEventListener?.('devicechange', fn);
    },
    session(type) {
      // Where the browser has one (Safari): transient while speaking, play-and-record while listening, playback after (spec §10.1).
      try {
        const s = /** @type {any} */ (navigator).audioSession;
        if (s && s.type !== type) s.type = type;
      } catch {
        // not here
      }
    },
  };
}
