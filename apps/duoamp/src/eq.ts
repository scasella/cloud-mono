import type { EqSettings } from './prefs';

export const EQ_LABELS = ['60', '170', '310', '600', '1K', '3K', '6K', '12K', '14K', '16K'];
export const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
export const EQ_RANGE = 12;

export interface EqPreset {
  name: string;
  preamp: number;
  bands: number[];
}

export const EQ_PRESETS: EqPreset[] = [
  { name: 'FLAT', preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'CLUB', preamp: 0, bands: [0, 0, 4, 5, 5, 5, 3, 0, 0, 0] },
  { name: 'DANCE', preamp: 0, bands: [8, 6, 2, 0, 0, -4, -5, -5, 0, 0] },
  { name: 'DEEP HOUSE', preamp: -2, bands: [7, 5, 1, -2, -1, 0, 2, 3, 2, 1] },
  { name: 'FULL BASS', preamp: -3, bands: [9, 9, 9, 5, 1, -4, -8, -10, -11, -11] },
  { name: 'FULL TREBLE', preamp: -3, bands: [-9, -9, -9, -4, 2, 9, 12, 12, 12, 12] },
  { name: 'LAPTOP', preamp: 0, bands: [4, 9, 4, -3, -2, 1, 4, 8, 10, 11] },
  { name: 'LIVE', preamp: 0, bands: [-4, 0, 3, 4, 4, 4, 3, 2, 2, 2] },
  { name: 'POP', preamp: 0, bands: [-1, 4, 6, 7, 4, -1, -2, -2, -1, -1] },
  { name: 'ROCK', preamp: 0, bands: [7, 4, -5, -7, -3, 4, 8, 10, 10, 10] },
  { name: 'VOCAL', preamp: 0, bands: [-3, -3, -1, 3, 6, 5, 3, 0, -2, -3] },
];

type Listener = (eq: EqSettings) => void;

/**
 * Equaliser state. Purely cosmetic for now (no audio path); it shapes the
 * synthesised visualiser and is persisted with the other preferences.
 */
export class EqStore {
  private listeners = new Set<Listener>();
  constructor(private state: EqSettings) {}

  get(): EqSettings {
    return this.state;
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l(this.state);
  }

  setBand(i: number, db: number) {
    this.state.bands[i] = clampDb(db);
    this.emit();
  }

  setPreamp(db: number) {
    this.state.preamp = clampDb(db);
    this.emit();
  }

  setOn(on: boolean) {
    this.state.on = on;
    this.emit();
  }

  setAuto(on: boolean) {
    this.state.auto = on;
    this.emit();
  }

  applyPreset(p: EqPreset) {
    this.state.preamp = p.preamp;
    this.state.bands = p.bands.slice();
    this.emit();
  }

  /**
   * Linear gain multiplier for a frequency, used to tint the visualiser.
   * Interpolates band dB values in log-frequency.
   */
  gainAt(freq: number): number {
    if (!this.state.on) return 1;
    const b = this.state.bands;
    const lf = Math.log2(freq);
    let db: number;
    if (freq <= EQ_FREQS[0]) db = b[0];
    else if (freq >= EQ_FREQS[9]) db = b[9];
    else {
      let i = 0;
      while (i < 8 && freq > EQ_FREQS[i + 1]) i++;
      const a = Math.log2(EQ_FREQS[i]);
      const c = Math.log2(EQ_FREQS[i + 1]);
      const t = (lf - a) / (c - a);
      db = b[i] * (1 - t) + b[i + 1] * t;
    }
    db += this.state.preamp;
    // Exaggerated a little so slider moves are visible in the bars.
    return Math.pow(10, (db * 1.4) / 20);
  }
}

export function clampDb(v: number) {
  return Math.max(-EQ_RANGE, Math.min(EQ_RANGE, v));
}

/** Deterministic preset pick for AUTO mode (no metadata to go on yet). */
export function autoPresetFor(trackId: string): EqPreset {
  let h = 0;
  for (let i = 0; i < trackId.length; i++) h = (h * 31 + trackId.charCodeAt(i)) >>> 0;
  const choices = EQ_PRESETS.filter((p) => ['CLUB', 'DANCE', 'DEEP HOUSE', 'POP', 'LIVE', 'VOCAL'].includes(p.name));
  return choices[h % choices.length];
}
