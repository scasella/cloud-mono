import type { AppContext } from './context';

const LOW_HZ = 30;
const HIGH_HZ = 16000;

/**
 * Analyser ballistics shared by the visualisers: fast attack, gravity
 * release, peak caps that hold then fall. Input comes from the engine's
 * spectrum (synthesised for now) shaped by the EQ curve.
 */
export class Bars {
  level: Float32Array;
  peak: Float32Array;
  private raw: Float32Array;
  private hold: Float32Array;
  private vel: Float32Array;
  private freqs: Float32Array;
  active = false;
  private acc = 0;

  constructor(public n: number) {
    this.level = new Float32Array(n);
    this.peak = new Float32Array(n);
    this.raw = new Float32Array(n);
    this.hold = new Float32Array(n);
    this.vel = new Float32Array(n);
    this.freqs = new Float32Array(n);
    this.resize(n);
  }

  resize(n: number) {
    if (n === this.n && this.freqs.length === n && this.freqs[0] > 0) return;
    this.n = n;
    this.level = new Float32Array(n);
    this.peak = new Float32Array(n);
    this.raw = new Float32Array(n);
    this.hold = new Float32Array(n);
    this.vel = new Float32Array(n);
    this.freqs = new Float32Array(n);
    for (let i = 0; i < n; i++) this.freqs[i] = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, (i + 0.5) / n);
  }

  update(ctx: AppContext, dt: number) {
    if (ctx.reducedMotion) {
      // Calm mode: sample a few times a second and glide.
      this.acc += dt;
      if (this.acc < 0.25) {
        for (let i = 0; i < this.n; i++) this.level[i] += (this.raw[i] - this.level[i]) * Math.min(1, dt * 3);
        return;
      }
      this.acc = 0;
    }
    this.active = ctx.engine.readSpectrum(this.raw);
    for (let i = 0; i < this.n; i++) {
      const target = Math.min(1, this.raw[i] * ctx.eq.gainAt(this.freqs[i]));
      this.raw[i] = target;
      if (ctx.reducedMotion) continue;
      let l = this.level[i];
      l = target > l ? l + (target - l) * Math.min(1, dt * 30) : Math.max(target, l - dt * 1.7);
      this.level[i] = l;
      if (l >= this.peak[i]) {
        this.peak[i] = l;
        this.hold[i] = 0.4;
        this.vel[i] = 0;
      } else if (this.hold[i] > 0) {
        this.hold[i] -= dt;
      } else {
        this.vel[i] += dt * 2.4;
        this.peak[i] = Math.max(l, this.peak[i] - this.vel[i] * dt);
      }
    }
  }
}
