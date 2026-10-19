import { browserPlatform } from '../../../src/plugins/voice-browser/index.js';

/** A piece of a live voice: ms of a tone, as 24 kHz 16-bit PCM. @param {number} [ms] */
const piece = (ms = 100) => Int16Array.from({ length: (24 * ms) | 0 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24_000)));
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('pieces pushed in a burst play back to back: five of 100 ms take about half a second, and their loudness reaches the glow', async () => {
    /** @type {number[]} */
    const levels = [];
    const s = /** @type {any} */ (browserPlatform().player).stream({ rate: 24_000, onLevel: (/** @type {number} */ x) => levels.push(x) });
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) s.push(piece());
    s.end();
    const { playedMs } = await s.done;
    const took = performance.now() - t0;
    assert.ok(Math.abs(playedMs - 500) < 40, `played ${playedMs} ms`);
    assert.ok(took > 440 && took < 2000, `took ${took} ms`);
    assert.ok(levels.some((x) => x > 0.3), `levels ${levels.slice(0, 6).join(', ')}`);
    assert.equal(levels.at(-1), 0);
  });

  test('pieces that come slower than they play all play; only sound counts as played', async () => {
    const s = /** @type {any} */ (browserPlatform().player).stream({ rate: 24_000 });
    for (let i = 0; i < 3; i++) {
      s.push(piece());
      await wait(200);
    }
    s.end();
    const { playedMs } = await s.done;
    assert.ok(Math.abs(playedMs - 300) < 40, `played ${playedMs} ms`);
  });

  test('stop() is silence at once, and says how much was heard', async () => {
    const s = /** @type {any} */ (browserPlatform().player).stream({ rate: 24_000 });
    for (let i = 0; i < 20; i++) s.push(piece());
    await wait(400);
    const { playedMs } = s.stop();
    assert.ok(playedMs > 200 && playedMs < 700, `played ${playedMs} ms of 2000`);
    assert.equal((await s.done).playedMs, playedMs);
    s.push(piece()); // after a stop, nothing more plays
  });

  test('a stream ended with nothing in it is done at once, having played nothing', async () => {
    const s = /** @type {any} */ (browserPlatform().player).stream({ rate: 24_000 });
    s.end();
    assert.equal((await s.done).playedMs, 0);
  });
}
