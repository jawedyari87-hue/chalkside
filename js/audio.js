// Microphone capture (16 kHz PCM for Gemini) and playback of the tutor's 24 kHz voice.

const WORKLET = `
class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.ratio = sampleRate / (o.targetRate || 16000);
    this.chunk = o.chunk || 1280;
    this.out = new Int16Array(this.chunk);
    this.n = 0;
    this.t = 0;
    this.last = 0;
    this.y1 = 0;
    this.y2 = 0;
    // Two one-pole low-pass stages before decimating, to keep aliasing down.
    this.alpha = this.ratio > 1.01 ? 1 - Math.exp(-2 * Math.PI * 6500 / sampleRate) : 1;
    this.sumSq = 0;
    this.tmp = new Float32Array(128);
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const ch = input[0];
    const N = ch.length;
    if (this.tmp.length !== N) this.tmp = new Float32Array(N);
    const x = this.tmp;
    const a = this.alpha;
    let y1 = this.y1, y2 = this.y2;
    for (let i = 0; i < N; i++) { y1 += a * (ch[i] - y1); y2 += a * (y1 - y2); x[i] = y2; }
    this.y1 = y1; this.y2 = y2;
    let t = this.t;
    while (t <= N - 1) {
      const i = Math.floor(t);
      const f = t - i;
      const s0 = i < 0 ? this.last : x[i];
      const s1 = i + 1 < N ? x[i + 1] : s0;
      let v = s0 + (s1 - s0) * f;
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      this.sumSq += v * v;
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.chunk) {
        const rms = Math.sqrt(this.sumSq / this.chunk);
        this.port.postMessage({ pcm: this.out.buffer, rms }, [this.out.buffer]);
        this.out = new Int16Array(this.chunk);
        this.n = 0;
        this.sumSq = 0;
      }
      t += this.ratio;
    }
    this.t = t - N;
    this.last = x[N - 1];
    return true;
  }
}
registerProcessor('pcm16-capture', Pcm16Capture);
`;

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.sources = new Set();
    this.playHead = 0;
    this.stream = null;
  }

  // Call from a click handler: the AudioContext must be created inside a user gesture.
  async init() {
    // resume() can stay pending without a fresh tap, so never wait on it for long.
    const resumeSoon = (p) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    if (this.ctx) {
      if (this.ctx.state !== 'running') await resumeSoon(this.ctx.resume());
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const resumed = resumeSoon(this.ctx.resume());
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.out = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.levelBuf = new Float32Array(this.analyser.fftSize);
    this.out.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    await resumed;
  }

  async startMic(onChunk) {
    this.stopMic();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('This browser cannot use the microphone here.'), { name: 'NotSupportedError' });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm16-capture', {
      processorOptions: { targetRate: 16000, chunk: 1280 },
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.onmessage = (e) => onChunk(new Int16Array(e.data.pcm), e.data.rms);
    // The worklet has to be pulled by the graph, so route it into a silent gain.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.src.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    const track = this.stream.getAudioTracks()[0];
    track?.addEventListener('ended', () => this.dispatchEvent(new Event('mic-ended')));
  }

  stopMic() {
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* already disconnected */
    }
    if (this.node) this.node.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.src = this.node = this.sink = null;
  }

  // Queue a chunk of 16-bit mono PCM for gapless playback.
  play(int16, rate = 24000) {
    if (!this.ctx || !int16.length) return;
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    const buf = this.ctx.createBuffer(1, f32.length, rate);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const now = this.ctx.currentTime;
    if (this.playHead < now + 0.02) this.playHead = now + 0.08;
    src.start(this.playHead);
    this.playHead += buf.duration;
    const wasIdle = this.sources.size === 0;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.dispatchEvent(new Event('idle'));
    };
    if (wasIdle) this.dispatchEvent(new Event('speaking'));
  }

  // Stop the tutor mid-sentence (barge-in, or the student pressed stop).
  flush() {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    const had = this.sources.size > 0;
    this.sources.clear();
    this.playHead = 0;
    if (had) this.dispatchEvent(new Event('idle'));
  }

  get speaking() {
    return this.sources.size > 0;
  }

  outputLevel() {
    if (!this.analyser || !this.sources.size) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let s = 0;
    for (let i = 0; i < this.levelBuf.length; i++) s += this.levelBuf[i] * this.levelBuf[i];
    return Math.sqrt(s / this.levelBuf.length);
  }
}
