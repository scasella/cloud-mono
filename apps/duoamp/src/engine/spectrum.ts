/**
 * Synthesised "musical" spectrum. Streaming services do not expose audio
 * samples, so this is the long-term visualiser source: a tiny arrangement
 * model (kick, bass, clap, hats, pads, lead) driven by the playback clock.
 * It is deterministic in the track position (seeking jumps to the matching
 * section) with a little per-frame jitter for life.
 */

const LOW_HZ = 30;
const HIGH_HZ = 16000;
export const SYNTH_BANDS = 64;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hash2(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Gaussian bump in log-frequency. widthOct is the 1/e half-width in octaves. */
function bump(logRatio: number, widthOct: number): number {
  const x = logRatio / widthOct;
  return Math.exp(-x * x);
}

type Section = 'intro' | 'groove' | 'break' | 'drop' | 'outro';

interface TrackModel {
  bpm: number;
  rootHz: number;
  progression: number[];
  hatDensity: number;
  brightness: number;
  energy: number;
  breakbeat: boolean;
  seed: number;
}

const SCALE = [0, 3, 5, 7, 10, 12, 15];

export class SpectrumSynth {
  private freqs: Float64Array;
  private log2f: Float64Array;
  private model: TrackModel;
  private duration = 240;

  constructor(private bands = SYNTH_BANDS) {
    this.freqs = new Float64Array(bands);
    this.log2f = new Float64Array(bands);
    for (let k = 0; k < bands; k++) {
      const f = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, k / (bands - 1));
      this.freqs[k] = f;
      this.log2f[k] = Math.log2(f);
    }
    this.model = this.makeModel('none');
  }

  setTrack(id: string, duration: number) {
    this.model = this.makeModel(id);
    this.duration = Math.max(1, duration);
  }

  private makeModel(id: string): TrackModel {
    const seed = hashString(id);
    const r = (n: number) => hash2(seed, n);
    const progressions = [
      [0, 5, 3, 7], [0, 8, 3, 10], [0, 3, 8, 7], [0, 10, 8, 5], [0, 7, 5, 3],
    ];
    return {
      bpm: 98 + Math.floor(r(1) * 30),
      rootHz: 41.2 * Math.pow(2, Math.floor(r(2) * 12) / 12),
      progression: progressions[Math.floor(r(3) * progressions.length)],
      hatDensity: r(4),
      brightness: 0.75 + r(5) * 0.5,
      energy: 0.85 + r(6) * 0.3,
      breakbeat: r(7) < 0.2,
      seed,
    };
  }

  private section(bar: number, t: number): Section {
    if (t > this.duration - 14) return 'outro';
    if (bar < 8) return 'intro';
    const s = Math.floor((bar - 8) / 8) % 4;
    return (['groove', 'drop', 'break', 'drop'] as const)[s];
  }

  /** Raw band energies 0..1 at time t (seconds into the track). */
  compute(t: number, out: Float32Array, jitter = true) {
    const m = this.model;
    const beatLen = 60 / m.bpm;
    const beat = t / beatLen;
    const beatIdx = Math.floor(beat);
    const beatFrac = beat - beatIdx;
    const bar = Math.floor(beatIdx / 4);
    const beatInBar = beatIdx % 4;
    const sixteenth = beat * 4;
    const sixFrac = sixteenth - Math.floor(sixteenth);
    const sixIdx = Math.floor(sixteenth) % 16;
    const eighthFrac = (beat * 2) % 1;
    const sec = this.section(bar, t);

    // Instrument envelopes ---------------------------------------------------
    const kickOn = sec === 'groove' || sec === 'drop' || (sec === 'outro' && t < this.duration - 6);
    let kickHit = kickOn;
    if (m.breakbeat && kickOn) kickHit = beatInBar !== 3 || beatFrac < 0.5;
    const kick = kickHit ? Math.exp(-beatFrac * 7.5) : 0;
    const clapOn = sec === 'drop' || sec === 'groove';
    const clap = clapOn && beatInBar % 2 === 1 ? Math.exp(-beatFrac * 5.5) : 0;
    const hatStep = m.hatDensity > 0.5 ? 1 : 2;
    const hatPresent = sec !== 'break' || bar % 2 === 1;
    const hatAccent = sixIdx % 4 === 2 ? 1 : sixIdx % hatStep === 0 ? 0.55 : 0;
    const hat = hatPresent ? hatAccent * Math.exp(-sixFrac * 9) : 0;
    const chordRoot = m.rootHz * Math.pow(2, m.progression[bar % 4] / 12);
    const bassPump = sec === 'break' || sec === 'intro' ? 0.35 : 0.25 + 0.75 * Math.min(1, eighthFrac * 3) * Math.exp(-eighthFrac * 1.5);
    const bassAmp = (sec === 'intro' ? 0.35 : sec === 'break' ? 0.3 : 0.75) * bassPump;
    const padSwell = 0.55 + 0.45 * Math.sin((t / (beatLen * 16)) * Math.PI * 2);
    const padAmp = (sec === 'break' ? 0.75 : sec === 'intro' ? 0.5 : 0.38) * padSwell;
    const leadOn = sec === 'drop' || sec === 'break';
    const leadNote = SCALE[Math.floor(hash2(m.seed + bar, beatIdx * 2 + (eighthFrac < 0.5 ? 0 : 1)) * SCALE.length)];
    const leadHz = chordRoot * 16 * Math.pow(2, leadNote / 12);
    const leadAmp = leadOn ? 0.5 * Math.exp(-((beat * 2) % 1) * 2.2) : 0;

    const fadeIn = Math.min(1, t / 1.2);
    const fadeOut = Math.min(1, Math.max(0, (this.duration - t) / 4));
    const level = m.energy * fadeIn * fadeOut;

    const lKick = Math.log2(52);
    const lBass = Math.log2(chordRoot);
    const lPad = Math.log2(chordRoot * 4);
    const lLead = Math.log2(leadHz);
    const third = (m.progression[bar % 4] % 2 === 0 ? 3 : 4) / 12;

    for (let k = 0; k < this.bands; k++) {
      const lf = this.log2f[k];
      const pos = k / (this.bands - 1);
      // Pink-ish floor with gentle roll-off at the top.
      let e = 0.2 * (1 - pos * 0.3) * (sec === 'intro' ? 0.7 : 1);
      e += kick * (1.15 * bump(lf - lKick, 0.75) + 0.12 * bump(lf - 11.5, 1.4) * Math.exp(-beatFrac * 25));
      e += bassAmp * (bump(lf - lBass, 0.3) + 0.55 * bump(lf - lBass - 1, 0.3) + 0.25 * bump(lf - lBass - 1.58, 0.3));
      e += clap * (0.45 * bump(lf - 7.9, 0.7) + 0.6 * bump(lf - 11.2, 1.5));
      e += hat * m.brightness * (0.75 * bump(lf - 13.1, 0.9) + 0.5 * bump(lf - 13.8, 0.5)) + 0.12 * (kick + clap) * bump(lf - 12.5, 1.6);
      for (let h = 1; h <= 4; h++) {
        const lh = Math.log2(h);
        const a = padAmp / h;
        e += a * (bump(lf - lPad - lh, 0.14) + 0.8 * bump(lf - lPad - third - lh, 0.14) + 0.7 * bump(lf - lPad - 0.585 - lh, 0.14));
      }
      e += leadAmp * (bump(lf - lLead, 0.12) + 0.5 * bump(lf - lLead - 1, 0.14) + 0.25 * bump(lf - lLead - 1.58, 0.16));
      if (jitter) e *= 0.88 + Math.random() * 0.24;
      // Soft saturation into 0..1.
      out[k] = (1 - Math.exp(-e * 1.6)) * level;
    }
  }

  /** Short synthetic waveform window starting at time t. */
  waveform(t: number, out: Float32Array) {
    const m = this.model;
    const beatLen = 60 / m.bpm;
    const n = out.length;
    const window = 0.045;
    const bar = Math.floor(t / beatLen / 4);
    const sec = this.section(bar, t);
    const chordRoot = m.rootHz * Math.pow(2, m.progression[bar % 4] / 12);
    const kickOn = sec === 'groove' || sec === 'drop';
    const fade = Math.min(1, t / 1.2) * Math.min(1, Math.max(0, (this.duration - t) / 4));
    for (let i = 0; i < n; i++) {
      const ts = t + (i / n) * window;
      const beat = ts / beatLen;
      const bf = beat - Math.floor(beat);
      const kickEnv = kickOn ? Math.exp(-bf * 7) : 0;
      const kickPh = 2 * Math.PI * (45 + 70 * Math.exp(-bf * 30)) * bf * beatLen;
      let s = 0.9 * kickEnv * Math.sin(kickPh);
      s += 0.35 * Math.sin(2 * Math.PI * chordRoot * 2 * ts);
      s += 0.18 * Math.sin(2 * Math.PI * chordRoot * 4 * ts) + 0.12 * Math.sin(2 * Math.PI * chordRoot * 5.04 * ts);
      s += 0.1 * Math.sin(2 * Math.PI * chordRoot * 6 * ts + 1.3);
      const six = (beat * 4) % 1;
      s += (Math.random() - 0.5) * 0.35 * Math.exp(-six * 9);
      out[i] = Math.tanh(s * 1.2) * fade * m.energy;
    }
  }
}

/** Resample a SYNTH_BANDS spectrum to any bar count (max-pooling / interpolation). */
export function resampleSpectrum(src: Float32Array, out: Float32Array) {
  const n = out.length;
  const m = src.length;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * m;
    const b = ((i + 1) / n) * m;
    if (b - a >= 1) {
      let v = 0;
      for (let j = Math.floor(a); j < Math.ceil(b) && j < m; j++) v = Math.max(v, src[j]);
      out[i] = v;
    } else {
      const c = (a + b) / 2 - 0.5;
      const j = Math.max(0, Math.min(m - 2, Math.floor(c)));
      const f = Math.max(0, Math.min(1, c - j));
      out[i] = src[j] * (1 - f) + src[j + 1] * f;
    }
  }
}
