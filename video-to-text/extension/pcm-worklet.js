// Downmix to mono, resample to 16 kHz, emit Int16 frames of 3200 samples (0.2 s).
class PCM extends AudioWorkletProcessor {
  constructor() { super(); this.r = sampleRate / 16000; this.pos = 0; this.out = new Int16Array(3200); this.n = 0; }
  process(inputs) {
    const a = inputs[0][0], b = inputs[0][1];
    if (!a) return true;
    while (this.pos < a.length - 1) {
      const i = Math.max(0, Math.floor(this.pos)), f = Math.max(0, this.pos - i);
      let x = a[i] * (1 - f) + a[i + 1] * f;
      if (b) x = (x + b[i] * (1 - f) + b[i + 1] * f) / 2;
      this.out[this.n++] = Math.max(-1, Math.min(1, x)) * 32767;
      if (this.n === 3200) { this.port.postMessage(this.out.slice(0).buffer); this.n = 0; }
      this.pos += this.r;
    }
    this.pos -= a.length;
    return true;
  }
}
registerProcessor("pcm", PCM);
