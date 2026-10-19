import { browserPlatform } from '../../../src/plugins/voice-browser/index.js';
import { mediaTypeOf } from '../../../src/core/voice/formats.js';

/** A voice-like sound at 16 kHz: a tone that rises and falls five times a second. @param {number} seconds */
const voiced = (seconds) => Int16Array.from({ length: Math.round(seconds * 16_000) }, (_, i) => {
  const t = i / 16_000;
  return Math.round(9000 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t)) * Math.sin(2 * Math.PI * 220 * t) * (1 + 0.3 * Math.sin(2 * Math.PI * 660 * t)));
});

/** @param {Uint8Array} data */
async function decodedSeconds(data) {
  const ctx = new OfflineAudioContext(1, 16_000, 16_000);
  return (await ctx.decodeAudioData(data.slice().buffer)).duration;
}

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('the encoder says what it makes, and every format it says decodes back to about the same length', async () => {
    const enc = /** @type {NonNullable<import('../../../src/core/voice/platform.js').VoicePlatform['encoder']>} */ (browserPlatform().encoder);
    const makes = await enc.makes();
    assert.ok(Array.isArray(makes));
    if (typeof AudioEncoder !== 'undefined') assert.ok(makes.includes('ogg') && makes.includes('webm'), `Opus in both browsers' builds: ${makes.join(', ')}`);
    const pcm = voiced(1.5);
    for (const format of makes) {
      const file = await enc.encode(pcm, 16_000, format);
      assert.ok(file.length > 100 && file.length < pcm.length, `${format}: ${file.length} bytes`);
      let seconds = NaN;
      try {
        seconds = await decodedSeconds(file);
      } catch (e) {
        // This build may encode a codec it can't decode (no decoder plugin): only Opus must do both here.
        if (format === 'ogg' || format === 'webm') throw new Error(`${format} didn't decode: ${e}`);
        continue;
      }
      assert.ok(Math.abs(seconds - 1.5) < 0.15, `${format} decodes to ${seconds} s`);
    }
  });

  test('one encoding serves both Opus files, and the same sound gives the same bytes again', async () => {
    const enc = /** @type {any} */ (browserPlatform().encoder);
    if (!(await enc.makes()).includes('ogg')) return;
    const pcm = voiced(1);
    const ogg = await enc.encode(pcm, 16_000, 'ogg');
    const webm = await enc.encode(pcm, 16_000, 'webm');
    assert.equal(String.fromCharCode(...ogg.subarray(0, 4)), 'OggS');
    assert.deepEqual([...webm.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    assert.deepEqual(await enc.encode(pcm, 16_000, 'ogg'), ogg);
    await assert.rejects(enc.encode(pcm, 16_000, 'wav'), /can't make wav here/);
  });

  test('a kept clip decodes back to PCM for another format', async () => {
    const p = browserPlatform();
    const enc = /** @type {any} */ (p.encoder);
    const makes = await enc.makes();
    const format = makes.includes('ogg') ? 'ogg' : null;
    if (!format) return;
    const { pcm, rate } = await enc.decode(await enc.encode(voiced(1), 16_000, format), mediaTypeOf(format));
    assert.ok(Math.abs(pcm.length / rate - 1) < 0.1, `${pcm.length} samples at ${rate}`);
  });

  test('the player says what it plays, and a clip in each format it plays and the encoder makes plays to its end', async () => {
    const p = browserPlatform();
    const plays = /** @type {() => string[]} */ (p.player.plays)();
    assert.ok(plays.includes('wav'), plays.join(', '));
    const makes = await /** @type {any} */ (p.encoder).makes();
    for (const format of makes.filter((/** @type {string} */ f) => plays.includes(f))) {
      const data = await /** @type {any} */ (p.encoder).encode(voiced(0.4), 16_000, format);
      const r = await p.player.play({ data, mediaType: mediaTypeOf(format) }, { signal: new AbortController().signal });
      assert.equal(r.ended, true, format);
    }
  });

  test("MediaRecorder, where there is one, records alongside the microphone in files cut by take()", async () => {
    const p = browserPlatform();
    const records = /** @type {any} */ (p.encoder).records();
    if (typeof MediaRecorder === 'undefined') {
      assert.deepEqual(records, []);
      return;
    }
    assert.ok(records.some((/** @type {any} */ r) => r.format === 'webm'), JSON.stringify(records));
    const ctx = new AudioContext();
    await ctx.resume();
    const out = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.connect(out);
    osc.start();
    const real = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => out.stream;
    try {
      const webm = records.find((/** @type {any} */ r) => r.format === 'webm');
      const mic = await p.mic.open({ onFrames: () => {}, onError: () => {}, record: webm.type });
      await new Promise((r) => setTimeout(r, 300));
      /** @type {any} */ (mic).again();
      await new Promise((r) => setTimeout(r, 1200));
      const file = await /** @type {any} */ (mic).take();
      await new Promise((r) => setTimeout(r, 500));
      const next = await /** @type {any} */ (mic).take();
      mic.close();
      assert.deepEqual([...file.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
      const seconds = await decodedSeconds(file).catch(() => NaN);
      assert.ok(seconds > 0.9 && seconds < 1.6, `the file after again() is ${seconds} s`);
      assert.ok(next && next.length > 0, 'the next file began at the cut');
    } finally {
      navigator.mediaDevices.getUserMedia = real;
      await ctx.close();
    }
  });
}
