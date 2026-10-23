// The page's side of a realtime check, installed before annai's own code runs (Playwright's addInitScript serialises
// installMic, so it must hold no reference to anything outside it).
//
// The microphone: getUserMedia gives a stream from an AudioContext's MediaStreamAudioDestinationNode, where the harness plays the
// speech clips on a schedule of its own (window.__rt.say), over a constant room noise. To annai it is a microphone: a live
// audio track with a name (the audio route annai reads is from that name), 48 kHz-ish frames into its capture worklet. A
// Chromium file for the fake device (--use-file-for-fake-audio-capture) plays one file from the moment the stream opens;
// this plays any clip at any time, after annai's own answer, and can mix her voice back in.
//
// The speaker: every node the page connects to a context's destination also feeds a tap, so the harness hears what annai
// plays (its loudness, 50 times a second: window.__rt.level), and, in echo mode, mixes it into the microphone at a level and
// a delay, as a phone's speaker does into its own microphone.
//
// Everything is kept in window.__rt: opens (microphones opened), plays (clips played: name, at, end, in epoch ms),
// level ([ms since start, rms of what annai plays]), mic ([ms, rms of what the microphone carries]).
/**
 * @param {{ route: 'speaker' | 'headphones' | 'car', roomDb: number | null, echo: { db: number, delayMs: number } | null,
 *   clips: Record<string, string> }} o  clips: WAV files, base64; roomDb: room noise level in dBFS, null for digital silence
 */
export function installMic(o) {
  const w = /** @type {any} */ (window);
  const t0 = Date.now();
  const rt = (w.__rt = { opens: 0, plays: /** @type {any[]} */ ([]), level: /** @type {number[][]} */ ([]), mic: /** @type {number[][]} */ ([]), route: o.route, echo: o.echo, error: /** @type {string | null} */ (null), say: /** @type {any} */ (null), t0 });
  if (typeof MediaDevices === 'undefined') return;
  const label = { speaker: 'iPhone Microphone', headphones: 'AirPods Pro', car: 'Car Handsfree' }[o.route];
  const connect = AudioNode.prototype.connect;

  /** Each context the page plays in: its tap (a gain every destination-bound node also feeds), its loudness probe and the stream of what it plays. @type {{ ctx: AudioContext, tap: GainNode, probe: AnalyserNode, stream: MediaStream }[]} */
  const speakers = [];
  /** @type {((s: MediaStream) => void)[]} */
  const ears = [];
  /** @this {AudioNode} @param {any} dest @param {...any} rest */
  AudioNode.prototype.connect = /** @type {any} */ (function (dest, ...rest) {
    const r = /** @type {any} */ (connect).call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      const c = /** @type {any} */ (this.context);
      if (!c.__tap) {
        const tap = c.createGain();
        const probe = c.createAnalyser();
        probe.fftSize = 1024;
        const sink = c.createMediaStreamDestination();
        /** @type {any} */ (connect).call(tap, probe);
        /** @type {any} */ (connect).call(tap, sink);
        c.__tap = { ctx: c, tap, probe, stream: sink.stream };
        speakers.push(c.__tap);
        for (const ear of ears) ear(sink.stream);
      }
      /** @type {any} */ (connect).call(this, c.__tap.tap);
    }
    return r;
  });
  const buf = new Float32Array(1024);
  const rms = (/** @type {AnalyserNode} */ a) => {
    a.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  };
  /** @type {AnalyserNode | null} */
  let micProbe = null;
  setInterval(() => {
    const now = Date.now() - t0;
    rt.level.push([now, Math.max(0, ...speakers.map((s) => rms(s.probe)))]);
    if (micProbe) rt.mic.push([now, rms(micProbe)]);
  }, 20);

  /** @type {MediaStreamTrack[]} */
  const live = [];
  MediaDevices.prototype.enumerateDevices = async () => /** @type {any} */ ([
    { kind: 'audioinput', label: live.length ? label : '', deviceId: 'rt-mic', groupId: 'rt' },
    ...(o.route === 'speaker' ? [] : [{ kind: 'audiooutput', label, deviceId: 'rt-out', groupId: 'rt' }]),
  ]);
  // On the prototype: WebKit drops a method set on navigator.mediaDevices this early.
  MediaDevices.prototype.getUserMedia = async () => {
    rt.opens++;
    const ctx = new AudioContext();
    await ctx.resume().catch(() => {});
    // Everything the microphone carries meets in a bus, which feeds the stream and a probe of its loudness.
    const dest = ctx.createMediaStreamDestination();
    const out = ctx.createGain();
    out.connect(dest);
    micProbe = ctx.createAnalyser();
    micProbe.fftSize = 1024;
    out.connect(micProbe);
    // The room: brown-ish noise, looped, at roomDb.
    if (o.roomDb !== null) {
      const noise = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
      const ch = noise.getChannelData(0);
      let last = 0;
      let sum = 0;
      for (let i = 0; i < ch.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        ch[i] = last;
        sum += last * last;
      }
      const scale = 10 ** (o.roomDb / 20) / Math.sqrt(sum / ch.length);
      for (let i = 0; i < ch.length; i++) ch[i] *= scale;
      const room = ctx.createBufferSource();
      room.buffer = noise;
      room.loop = true;
      room.connect(out);
      room.start();
    }
    // Her voice back into the microphone, from the speaker: at a level, after a delay (the speaker's, the room's).
    /** @type {((s: MediaStream) => void) | null} */
    let ear = null;
    if (o.echo) {
      const echo = o.echo;
      ear = (/** @type {MediaStream} */ s) => {
        const gain = ctx.createGain();
        gain.gain.value = 10 ** (echo.db / 20);
        const delay = ctx.createDelay(1);
        delay.delayTime.value = echo.delayMs / 1000;
        /** @type {any} */ (connect).call(ctx.createMediaStreamSource(s), gain);
        gain.connect(delay);
        delay.connect(out);
      };
      speakers.forEach((s) => ear?.(s.stream));
      ears.push(ear);
    }
    // The clips, decoded in this context.
    /** @type {Record<string, AudioBuffer>} */
    const decoded = {};
    for (const [name, b64] of Object.entries(o.clips)) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      decoded[name] = await ctx.decodeAudioData(bytes.buffer);
    }
    /** Plays a clip into the microphone now (plus offsetMs), gainDb louder or quieter; the silence clips play nothing. */
    rt.say = (/** @type {string} */ name, /** @type {{ gainDb?: number, offsetMs?: number }} */ { gainDb = 0, offsetMs = 0 } = {}) => {
      const clip = decoded[name];
      if (!clip) throw new Error(`no clip named ${name}`);
      const src = ctx.createBufferSource();
      src.buffer = clip;
      const g = ctx.createGain();
      g.gain.value = 10 ** (gainDb / 20);
      src.connect(g);
      g.connect(out);
      const at = Date.now() + offsetMs;
      src.start(ctx.currentTime + offsetMs / 1000);
      const play = { name, at, end: at + Math.round(clip.duration * 1000), gainDb };
      rt.plays.push(play);
      return play;
    };
    const stream = dest.stream;
    for (const t of stream.getAudioTracks()) {
      Object.defineProperty(t, 'label', { value: label });
      const settings = t.getSettings.bind(t);
      t.getSettings = () => ({ ...settings(), deviceId: 'rt-mic' });
      live.push(t);
      const stop = t.stop.bind(t);
      t.stop = () => {
        stop();
        live.splice(live.indexOf(t), 1);
        micProbe = null;
        rt.say = null;
        if (ear) ears.splice(ears.indexOf(ear), 1);
        ctx.close().catch(() => {});
      };
    }
    return stream;
  };
}
