import { browserPlatform } from '../../../src/plugins/voice-browser/index.js';
import { encodeWav } from '../../../src/core/voice/pcm.js';
import { record } from '../../../src/core/voice/recorder.js';

/** A tone, as a WAV clip. @param {number} seconds @param {number} [hz] */
const tone = (seconds, hz = 440) => encodeWav(Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / 16000)), 16000);

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('the player plays a clip to its end, and its loudness reaches the glow', async () => {
    /** @type {number[]} */
    const levels = [];
    const r = await browserPlatform().player.play({ data: tone(0.4), mediaType: 'audio/wav' }, { signal: new AbortController().signal, onLevel: (x) => levels.push(x) });
    assert.equal(r.ended, true);
    assert.ok(levels.some((x) => x > 0.5), `levels: ${levels.slice(0, 8).join(', ')}`);
    assert.equal(levels.at(-1), 0);
  });

  test('a stop ends playing at once, and says how much was heard', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 400);
    const r = await browserPlatform().player.play({ data: tone(2), mediaType: 'audio/wav' }, { signal: stop.signal });
    assert.equal(r.ended, false);
    assert.ok(r.fraction > 0.05 && r.fraction < 0.6, `fraction ${r.fraction}`);
  });

  test('the microphone, through the AudioWorklet and the detector, gives a segment', async () => {
    // A fake microphone: half a second of nothing, then 1.2 s of a tone that rises and falls like syllables.
    const ctx = new AudioContext();
    await ctx.resume();
    const out = ctx.createMediaStreamDestination();
    const carrier = ctx.createOscillator();
    carrier.frequency.value = 500;
    const syllables = ctx.createOscillator();
    syllables.frequency.value = 5;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const envelope = ctx.createGain();
    const t = ctx.currentTime;
    envelope.gain.setValueAtTime(0, t);
    envelope.gain.setValueAtTime(0.6, t + 0.5);
    envelope.gain.setValueAtTime(0, t + 1.7);
    syllables.connect(depth).connect(am.gain);
    carrier.connect(am).connect(envelope).connect(out);
    carrier.start();
    syllables.start();
    const real = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => out.stream;
    try {
      const seg = await new Promise((resolve, reject) => {
        record({ mic: browserPlatform().mic, onSegment: resolve, onError: reject })
          .then((s) => setTimeout(() => { s.close(); reject(new Error('no segment within 6 s')); }, 6000), reject);
      });
      assert.equal(new TextDecoder().decode(/** @type {any} */ (seg).audio.data.subarray(0, 4)), 'RIFF');
      assert.ok(/** @type {any} */ (seg).ms > 700 && /** @type {any} */ (seg).ms < 2600, `${/** @type {any} */ (seg).ms} ms`);
    } finally {
      navigator.mediaDevices.getUserMedia = real;
      await ctx.close();
    }
  });

  test('the browser voice and dictation say whether this browser has them; the audio session never throws', async () => {
    const p = browserPlatform();
    assert.equal(p.synth.available(), typeof speechSynthesis !== 'undefined');
    assert.equal(p.dictation.available(), Boolean(/** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition));
    p.session('play-and-record');
    p.session('playback');
    assert.ok(Array.isArray(p.synth.voices()));
  });

  test('dictation: words come as segments; a sound with no words says so, on an empty result or an end without words (spec §10.2)', async () => {
    const w = /** @type {any} */ (window);
    const saved = [w.SpeechRecognition, w.webkitSpeechRecognition];
    /** @type {any[]} */
    const made = [];
    w.SpeechRecognition = class {
      constructor() { made.push(this); }
      start() {}
      abort() {}
    };
    try {
      /** @type {string[]} */
      const got = [];
      const session = /** @type {any} */ (browserPlatform().dictation).open({
        onSegment: (/** @type {string} */ t) => got.push(`words ${t}`), onSpeech: () => got.push('speech'), onQuiet: () => got.push('quiet'), onError: (/** @type {Error} */ e) => got.push(`error ${e.message}`),
      });
      const r = made[0];
      const final = (/** @type {string} */ text) => ({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
      r.onspeechstart();
      r.onresult(final(' '));
      r.onspeechstart();
      r.onerror({ error: 'no-speech' });
      r.onend();
      r.onspeechstart();
      r.onresult(final('the beach'));
      r.onend();
      session.close();
      assert.deepEqual(got, ['speech', 'quiet', 'speech', 'quiet', 'speech', 'words the beach']);
    } finally {
      [w.SpeechRecognition, w.webkitSpeechRecognition] = saved;
    }
  });

  test("dictation never asks whether it could stay on the phone (Chrome 153's check crashed the page), so it says it can't; the voices say which are on the phone (spec §11.7)", async () => {
    const w = /** @type {any} */ (window);
    const saved = [w.SpeechRecognition, w.webkitSpeechRecognition];
    let asked = 0;
    class Local {
      start() {}
      abort() {}
      static async available() { asked++; return 'available'; }
    }
    /** @type {any} */ (Local.prototype).processLocally = false;
    try {
      w.SpeechRecognition = Local;
      const p = browserPlatform();
      assert.equal(await (/** @type {any} */ (p.dictation).local?.('en-US') ?? false), false);
      /** @type {any} */ (p.dictation).open({ lang: 'en-US', local: true, onSegment: () => {}, onError: () => {} }).close();
      assert.equal(asked, 0);
      for (const v of p.synth.voices()) assert.equal(typeof v.local, 'boolean', v.name);
    } finally {
      [w.SpeechRecognition, w.webkitSpeechRecognition] = saved;
    }
  });

  test('the audio devices by name, and word when they change (spec §10.5)', async () => {
    const real = MediaDevices.prototype.enumerateDevices;
    MediaDevices.prototype.enumerateDevices = async () => /** @type {any} */ ([
      { kind: 'audioinput', label: 'AirPods Pro', deviceId: 'a', groupId: 'g' },
      { kind: 'videoinput', label: 'Back camera', deviceId: 'v', groupId: 'h' },
    ]);
    try {
      const p = browserPlatform();
      assert.deepEqual(await /** @type {any} */ (p).devices(), [{ kind: 'audioinput', label: 'AirPods Pro', deviceId: 'a' }, { kind: 'videoinput', label: 'Back camera', deviceId: 'v' }]);
      let told = 0;
      /** @type {any} */ (p).onDeviceChange(() => { told++; });
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
      assert.equal(told, 1);
    } finally {
      MediaDevices.prototype.enumerateDevices = real;
    }
  });

  test('the input in use while the microphone is open: its track\'s label and deviceId; none once closed (voice-fix item 5)', async () => {
    const ctx = new AudioContext();
    const out = ctx.createMediaStreamDestination();
    const [track] = out.stream.getAudioTracks();
    const real = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => out.stream;
    try {
      const p = browserPlatform();
      assert.equal(p.mic.inUse?.(), null);
      const mic = await p.mic.open({ onFrames: () => {}, onError: () => {} });
      assert.deepEqual(p.mic.inUse?.(), { label: track.label, deviceId: track.getSettings?.().deviceId ?? '' });
      mic.close();
      assert.equal(p.mic.inUse?.(), null);
    } finally {
      navigator.mediaDevices.getUserMedia = real;
      await ctx.close();
    }
  });
}
