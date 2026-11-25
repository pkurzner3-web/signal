// Turns browser audio into 16 kHz, 16-bit mono chunks of 50 ms for AssemblyAI.
class PcmSender extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // sampleRate is the AudioContext rate (usually 44100 or 48000)
    this.phase = 0;
    this.acc = 0;
    this.count = 0;
    this.out = new Int16Array(800); // 800 samples = 50 ms at 16 kHz
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const channels = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      this.acc += s / channels;
      this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let v = this.acc / this.count;
        this.acc = 0;
        this.count = 0;
        v = Math.max(-1, Math.min(1, v));
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.out.length) {
          const chunk = this.out.slice(0);
          this.port.postMessage(chunk.buffer, [chunk.buffer]);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-sender', PcmSender);
