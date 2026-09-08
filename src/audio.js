/**
 * Procedural audio. No files, no network — every sound is synthesised from
 * noise and oscillators at call time.
 *
 * A gunshot is built from five layers because a single noise burst sounds like
 * a balloon popping:
 *   1. transient  — 1-2 ms click, this is what makes it read as "sharp"
 *   2. body       — filtered noise burst, the actual bang
 *   3. punch      — a falling sine, the low end you feel
 *   4. mechanical — quiet bolt clatter, offset a few ms
 *   5. tail       — the body sent through a synthetic convolution reverb
 * Every shot is pitched +/-3% and re-randomised so sustained fire never turns
 * into a machine-gun-shaped stutter of one identical sample.
 */
export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.7;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    // Stops the mix from clipping when six bots fire at once.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.18;
    this.master.connect(this.limiter).connect(this.ctx.destination);

    this.noiseBuf = this._noise(1.4);
    this.irOutdoor = this._ir(1.5, 3.1, 0.28);
    this.irTight = this._ir(0.45, 5.5, 0.5);
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.irOutdoor;
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.5;
    this.reverb.connect(this.reverbGain).connect(this.master);
    return this.ctx;
  }

  resume() {
    const c = this.ensure();
    if (c && c.state === 'suspended') c.resume();
  }

  _noise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      last = 0.86 * last + 0.14 * w; // a touch of brown noise for body
      d[i] = w * 0.7 + last * 0.9;
    }
    return b;
  }

  /** Synthetic impulse response: noise with an exponential decay + early reflections. */
  _ir(seconds, decay, spread) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const b = this.ctx.createBuffer(2, n, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
      // early reflections give the space a size instead of a wash
      for (let k = 1; k <= 6; k++) {
        const idx = Math.floor(rate * spread * k * (0.03 + ch * 0.004));
        if (idx < n) d[idx] += (k % 2 ? 1 : -1) * 0.45 / k;
      }
    }
    return b;
  }

  _src(buf, rate, offset = 0) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    if (offset) s.loopStart = offset;
    return s;
  }

  setSpace(indoor) {
    if (!this.ctx) return;
    const want = indoor ? this.irTight : this.irOutdoor;
    if (this.reverb.buffer !== want) this.reverb.buffer = want;
    this.reverbGain.gain.value = indoor ? 0.75 : 0.5;
  }

  /**
   * @param {object} p sound params from the weapon definition
   * @param {number} dist metres from the listener (0 = own weapon)
   */
  shot(p, dist = 0) {
    const c = this.ensure();
    if (!c || !this.enabled) return;
    const now = c.currentTime;
    const detune = 1 + (Math.random() - 0.5) * 0.06;
    const distGain = 1 / (1 + dist * 0.16);
    const delay = dist / 343;
    const t = now + delay;
    const out = c.createGain();
    out.gain.value = (p.gain ?? 0.9) * distGain;
    out.connect(this.master);
    const send = c.createGain();
    send.gain.value = 0.55 * distGain;
    send.connect(this.reverb);
    out.connect(send);

    // 1. transient
    const tr = this._src(this.noiseBuf, 3.2 * detune);
    const trg = c.createGain();
    const trf = c.createBiquadFilter();
    trf.type = 'highpass';
    trf.frequency.value = 2600;
    trg.gain.setValueAtTime(0.9, t);
    trg.gain.exponentialRampToValueAtTime(0.0008, t + 0.014);
    tr.connect(trf).connect(trg).connect(out);
    tr.start(t, Math.random() * 0.5);
    tr.stop(t + 0.03);

    // 2. body
    const bd = this._src(this.noiseBuf, detune);
    const bf = c.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.setValueAtTime(p.bodyHz * detune, t);
    bf.frequency.exponentialRampToValueAtTime(Math.max(90, p.bodyHz * 0.32), t + p.decay);
    bf.Q.value = 0.85;
    const bg = c.createGain();
    bg.gain.setValueAtTime(1.0, t);
    bg.gain.exponentialRampToValueAtTime(0.0009, t + p.decay);
    bd.connect(bf).connect(bg).connect(out);
    bd.start(t, Math.random() * 0.5);
    bd.stop(t + p.decay + 0.05);

    // 3. punch
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(p.punchHz * detune, t);
    osc.frequency.exponentialRampToValueAtTime(p.punchHz * 0.35, t + 0.09);
    const og = c.createGain();
    og.gain.setValueAtTime(0.85, t);
    og.gain.exponentialRampToValueAtTime(0.0007, t + 0.13);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.16);

    // 4. mechanical (only audible on your own weapon)
    if (dist < 6) {
      const mech = this._src(this.noiseBuf, 1.6);
      const mf = c.createBiquadFilter();
      mf.type = 'bandpass';
      mf.frequency.value = 3400;
      mf.Q.value = 2.6;
      const mg = c.createGain();
      mg.gain.setValueAtTime(0.0001, t + 0.012);
      mg.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      mg.gain.exponentialRampToValueAtTime(0.0002, t + 0.075);
      mech.connect(mf).connect(mg).connect(out);
      mech.start(t + 0.012, Math.random() * 0.5);
      mech.stop(t + 0.1);
    }

    // 5. distant crack loses the highs before it loses the lows
    if (dist > 12) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(700, 9000 - dist * 95);
      out.disconnect();
      out.connect(lp);
      lp.connect(this.master);
      lp.connect(send);
    }
  }

  /** Short mechanical blip used for reload steps, pickups, UI. */
  click(freq = 900, dur = 0.05, gain = 0.25, type = 'square') {
    const c = this.ensure();
    if (!c || !this.enabled) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.01);
  }

  /** Bullet cracking past your head. */
  whizz(dist) {
    const c = this.ensure();
    if (!c || !this.enabled) return;
    const t = c.currentTime;
    const s = this._src(this.noiseBuf, 2.4);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(2200, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.12);
    f.Q.value = 3.5;
    const g = c.createGain();
    const amp = 0.30 / (1 + dist);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + 0.2);
  }

  impact(kind) {
    const map = { metal: [1800, 0.07], concrete: [420, 0.06], sand: [260, 0.05], flesh: [180, 0.08] };
    const [f, d] = map[kind] || map.concrete;
    this.click(f * (0.85 + Math.random() * 0.3), d, kind === 'metal' ? 0.14 : 0.1, kind === 'metal' ? 'triangle' : 'sine');
  }

  explosion() {
    const c = this.ensure();
    if (!c || !this.enabled) return;
    const t = c.currentTime;
    const s = this._src(this.noiseBuf, 0.55);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 1.1);
    const g = c.createGain();
    g.gain.setValueAtTime(1.1, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 1.3);
    const send = c.createGain();
    send.gain.value = 0.9;
    send.connect(this.reverb);
    s.connect(f).connect(g);
    g.connect(this.master);
    g.connect(send);
    s.start(t, Math.random() * 0.4);
    s.stop(t + 1.4);
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(26, t + 0.5);
    const og = c.createGain();
    og.gain.setValueAtTime(1.0, t);
    og.gain.exponentialRampToValueAtTime(0.0006, t + 0.6);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.65);
  }
}
