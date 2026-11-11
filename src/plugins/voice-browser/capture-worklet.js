/**
 * The microphone's samples, from the audio thread to the page in batches of 2048 (about 40 ms at
 * 48 kHz): an AudioWorklet captures PCM (spec §10.2). Loaded by the voice-browser plugin with
 * addModule, from annai's own origin (the security policy allows only 'self'). It also posts 'ran' once,
 * the first time process() runs, sound or not (a muted track runs it too): the page's proof that the audio thread runs.
 */
const scope = /** @type {any} */ (globalThis);

class Capture extends scope.AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.n = 0;
    this.ran = false;
  }

  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    if (!this.ran) {
      this.ran = true;
      this.port.postMessage('ran');
    }
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.batch[this.n++] = channel[i];
        if (this.n === this.batch.length) {
          this.port.postMessage(this.batch, [this.batch.buffer]);
          this.batch = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

scope.registerProcessor('annai-capture', Capture);
