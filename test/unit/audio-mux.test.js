import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oggOpus, webmOpus, adts, flacFile, opusSamples, oggCrc } from '../../src/core/voice/mux.js';

/** Opus packets as an encoder makes them: TOC 0x48 is SILK wideband, one 20 ms frame (960 samples at 48 kHz). @param {number} n @param {number} [size] */
const packets = (n, size = 60) => Array.from({ length: n }, (_, i) => Uint8Array.from({ length: size }, (_, j) => (j === 0 ? 0x48 : (i + j) & 0xff)));
const text = (/** @type {Uint8Array} */ b) => String.fromCharCode(...b);

/** The pages of an Ogg file, each with its packets put back together. @param {Uint8Array} b */
function oggPages(b) {
  const out = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 0; at < b.length;) {
    assert.equal(text(b.subarray(at, at + 4)), 'OggS');
    const n = b[at + 26];
    const lacing = [...b.subarray(at + 27, at + 27 + n)];
    const size = 27 + n + lacing.reduce((s, x) => s + x, 0);
    const raw = b.slice(at, at + size);
    const crc = dv.getUint32(at + 22, true);
    new DataView(raw.buffer).setUint32(22, 0, true);
    /** @type {Uint8Array[]} */
    const pkts = [];
    let body = at + 27 + n;
    let len = 0;
    for (const l of lacing) {
      len += l;
      if (l < 255) {
        pkts.push(b.subarray(body, body + len));
        body += len;
        len = 0;
      }
    }
    out.push({ flags: b[at + 5], granule: dv.getUint32(at + 6, true) + dv.getUint32(at + 10, true) * 2 ** 32, seq: dv.getUint32(at + 18, true), crcOk: crc === oggCrc(raw), packets: pkts });
    at += size;
  }
  return out;
}

/** EBML elements of a buffer, as [id, body] pairs. @param {Uint8Array} b */
function ebml(b) {
  const out = [];
  for (let at = 0; at < b.length;) {
    let idLen = 1;
    while (!(b[at] & (0x80 >> (idLen - 1)))) idLen++;
    const id = [...b.subarray(at, at + idLen)].reduce((x, y) => x * 256 + y, 0);
    at += idLen;
    let sLen = 1;
    while (!(b[at] & (0x80 >> (sLen - 1)))) sLen++;
    let size = b[at] & (0xff >> sLen);
    for (let i = 1; i < sLen; i++) size = size * 256 + b[at + i];
    at += sLen;
    out.push([id, b.subarray(at, at + size)]);
    at += size;
  }
  return /** @type {[number, Uint8Array][]} */ (out);
}
/** @param {Uint8Array} b @param {number} id */
const child = (b, id) => ebml(b).find(([i]) => i === id)?.[1];
/** @param {Uint8Array | undefined} b */
const num = (b) => [...(b ?? [])].reduce((x, y) => x * 256 + y, 0);

test('an Opus packet says how long it is: SILK, hybrid and CELT frame sizes, and the frame count', () => {
  assert.equal(opusSamples(Uint8Array.of(0x48)), 960); // SILK WB 20 ms
  assert.equal(opusSamples(Uint8Array.of(0x08 | (3 << 3))), 2880); // SILK NB 60 ms
  assert.equal(opusSamples(Uint8Array.of(0x78)), 960); // hybrid FB 20 ms
  assert.equal(opusSamples(Uint8Array.of(0xf8)), 960); // CELT FB 20 ms
  assert.equal(opusSamples(Uint8Array.of(0xe0)), 120); // CELT FB 2.5 ms
  assert.equal(opusSamples(Uint8Array.of(0x49)), 1920); // two frames
  assert.equal(opusSamples(Uint8Array.of(0x4b, 3)), 2880); // code 3: three frames
});

test('an Ogg Opus file: OggS pages with valid CRCs, OpusHead then OpusTags, granule positions at 48 kHz, the last page marked end', () => {
  // 301 packets of 20 ms cover the pre-skip and the input, as an encoder's do.
  const file = oggOpus(packets(301), { rate: 16_000, preSkip: 312, channels: 1, samples: 16_000 * 6 - 100 });
  const pages = oggPages(file);
  assert.ok(pages.every((p) => p.crcOk), 'every CRC checks');
  assert.deepEqual(pages.map((p) => p.seq), pages.map((_, i) => i));
  assert.equal(pages[0].flags, 2, 'the first page begins the stream');
  assert.equal(text(pages[0].packets[0].subarray(0, 8)), 'OpusHead');
  const head = new DataView(pages[0].packets[0].buffer, pages[0].packets[0].byteOffset);
  assert.deepEqual([head.getUint8(8), head.getUint8(9), head.getUint16(10, true), head.getUint32(12, true), head.getUint8(18)], [1, 1, 312, 16_000, 0]);
  assert.equal(text(pages[1].packets[0].subarray(0, 8)), 'OpusTags');
  assert.deepEqual([pages[0].granule, pages[1].granule], [0, 0]);
  const audio = pages.slice(2);
  assert.ok(audio.length >= 2, 'the packets need more than one page');
  assert.deepEqual(audio.flatMap((p) => p.packets).map((p) => p.length), packets(301).map((p) => p.length), 'every packet, whole and in order');
  for (const [i, p] of audio.entries()) {
    const through = audio.slice(0, i + 1).reduce((n, q) => n + q.packets.length, 0) * 960;
    if (i < audio.length - 1) assert.equal(p.granule, through, 'a page ends at its last packet');
    assert.equal(p.flags, i === audio.length - 1 ? 4 : 0);
  }
  assert.equal(audio.at(-1)?.granule, 312 + Math.ceil(((16_000 * 6 - 100) * 48_000) / 16_000), 'the last granule trims to the input');
  assert.deepEqual(oggOpus(packets(301), { rate: 16_000, preSkip: 312, samples: 16_000 * 6 - 100 }), file, 'the same packets give the same bytes');
});

test('a packet of 255 bytes or more is laced across segments and comes back whole', () => {
  const big = [Uint8Array.from({ length: 255 }, () => 0x48), Uint8Array.from({ length: 600 }, () => 0x48), Uint8Array.of(0x48)];
  const pages = oggPages(oggOpus(big, { rate: 16_000, preSkip: 312 }));
  assert.deepEqual(pages.slice(2).flatMap((p) => p.packets).map((p) => p.length), [255, 600, 1]);
  assert.equal(pages.at(-1)?.granule, 3 * 960, 'without the input length, the end is all the packets decode to');
});

test('a WebM Opus file: EBML header, DocType webm, one audio track A_OPUS, blocks in time order', () => {
  const file = webmOpus(packets(101), { rate: 16_000, preSkip: 312, channels: 1, samples: 32_000 });
  const [[hid, header], [sid, segment]] = ebml(file);
  assert.equal(hid, 0x1a45dfa3);
  assert.equal(text(/** @type {Uint8Array} */ (child(header, 0x4282))), 'webm');
  assert.equal(sid, 0x18538067);
  const info = /** @type {Uint8Array} */ (child(segment, 0x1549a966));
  assert.equal(num(child(info, 0x2ad7b1)), 1_000_000);
  const duration = /** @type {Uint8Array} */ (child(info, 0x4489));
  assert.equal(new DataView(duration.buffer, duration.byteOffset).getFloat64(0), 2000);
  const track = /** @type {Uint8Array} */ (child(/** @type {Uint8Array} */ (child(segment, 0x1654ae6b)), 0xae));
  assert.equal(text(/** @type {Uint8Array} */ (child(track, 0x86))), 'A_OPUS');
  assert.equal(num(child(track, 0x83)), 2, 'an audio track');
  assert.equal(text(/** @type {Uint8Array} */ (child(track, 0x63a2)).subarray(0, 8)), 'OpusHead');
  assert.equal(num(child(track, 0x56aa)), 6_500_000, 'the codec delay is the pre-skip, in ns');
  assert.equal(num(child(/** @type {Uint8Array} */ (child(track, 0xe1)), 0x9f)), 1, 'one channel');
  const clusters = ebml(segment).filter(([id]) => id === 0x1f43b675).map(([, b]) => b);
  assert.equal(clusters.length, 1);
  const blocks = ebml(clusters[0]).filter(([id]) => id === 0xa3).map(([, b]) => b);
  assert.equal(blocks.length, 101);
  assert.deepEqual(blocks.slice(0, 3).map((b) => [b[0], (b[1] << 8) | b[2], b[3]]), [[0x81, 0, 0x80], [0x81, 20, 0x80], [0x81, 40, 0x80]]);
  assert.deepEqual([...blocks[100].subarray(4)], [...packets(101)[100]]);
});

test('a WebM segment longer than 30 s goes on in a new cluster, so block times fit their 16 bits', () => {
  const file = webmOpus(packets(2000), { rate: 16_000, preSkip: 312 });
  const segment = ebml(file)[1][1];
  const clusters = ebml(segment).filter(([id]) => id === 0x1f43b675).map(([, b]) => b);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((c) => num(child(c, 0xe7))), [0, 30_020]);
});

test('ADTS frames carry the right length and sample-rate index; FLAC starts fLaC with STREAMINFO', () => {
  const frames = [Uint8Array.of(1, 2, 3), new Uint8Array(300)];
  const out = adts(frames, { rate: 16_000, channels: 1 });
  assert.equal(out.length, 3 + 300 + 14);
  assert.deepEqual([out[0], out[1] & 0xf6], [0xff, 0xf0]);
  assert.equal(out[1] & 1, 1, 'no checksum');
  assert.equal((out[2] >> 6) + 1, 2, 'AAC LC');
  assert.equal((out[2] >> 2) & 0xf, 8, '16 kHz');
  assert.equal(((out[2] & 1) << 2) | (out[3] >> 6), 1, 'one channel');
  const len = ((out[3] & 3) << 11) | (out[4] << 3) | (out[5] >> 5);
  assert.equal(len, 10);
  assert.equal(out[len], 0xff, 'the next frame starts where the length says');
  assert.equal(((out[len + 3] & 3) << 11) | (out[len + 4] << 3) | (out[len + 5] >> 5), 307);
  assert.deepEqual(adts([out.subarray(0, 10)], { rate: 16_000, channels: 1 }), out.subarray(0, 10), 'ADTS already: kept');
  assert.throws(() => adts(frames, { rate: 17_000, channels: 1 }), /no sample rate 17000/);

  const streaminfo = new Uint8Array(34).fill(7);
  const marked = Uint8Array.from([...'fLaC'].map((c) => c.charCodeAt(0)).concat([0x80, 0, 0, 34], [...streaminfo]));
  const flac = flacFile(marked, [Uint8Array.of(0xff, 0xf8, 1), Uint8Array.of(0xff, 0xf8, 2)]);
  assert.equal(text(flac.subarray(0, 4)), 'fLaC');
  assert.deepEqual([...flac.subarray(4, 8)], [0x80, 0, 0, 34], 'STREAMINFO, the last metadata block');
  assert.equal(flac.length, 42 + 6);
  assert.deepEqual(flacFile(streaminfo, []), marked, 'a bare STREAMINFO gets the marker and its block header');
  assert.throws(() => flacFile(null, []), /no STREAMINFO/);
});
