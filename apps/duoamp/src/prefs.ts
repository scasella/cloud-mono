import type { LayoutPref, Posture } from './config';

export type SkinId = 'light' | 'classic';
export type VisMode = 'bars' | 'scope' | 'off';
export type TimeMode = 'elapsed' | 'remaining';

export interface EqSettings {
  on: boolean;
  auto: boolean;
  /** dB, -12..12 */
  preamp: number;
  /** dB, -12..12, ten bands */
  bands: number[];
}

export interface Prefs {
  skin: SkinId;
  layout: LayoutPref;
  /** EQ vs Visualization in the secondary slot, remembered per posture. */
  showEq: Record<Posture, boolean>;
  showPl: boolean;
  visMode: VisMode;
  timeMode: TimeMode;
  eq: EqSettings;
  volume: number;
  balance: number;
  shuffle: boolean;
  repeat: boolean;
}

const KEY = 'duoamp.prefs.v1';

export const DEFAULT_PREFS: Prefs = {
  skin: 'light',
  layout: 'auto',
  // Matches the reference photos: EQ on the cover screen, Vis when opened.
  showEq: { cover: true, book: false, tabletop: false },
  showPl: true,
  visMode: 'bars',
  timeMode: 'elapsed',
  eq: { on: true, auto: false, preamp: 0, bands: [1, -1, -2.5, -3.5, -1.5, -3, -4, -7, -7, -5] },
  volume: 0.72,
  balance: 0,
  shuffle: false,
  repeat: false,
};

const SKINS: SkinId[] = ['light', 'classic'];
const LAYOUTS: LayoutPref[] = ['auto', 'cover', 'book', 'tabletop'];
const VIS: VisMode[] = ['bars', 'scope', 'off'];

function sanitize(raw: unknown): Prefs {
  const p = structuredClone(DEFAULT_PREFS);
  if (!raw || typeof raw !== 'object') return p;
  const r = raw as Record<string, unknown>;
  if (SKINS.includes(r.skin as SkinId)) p.skin = r.skin as SkinId;
  if (LAYOUTS.includes(r.layout as LayoutPref)) p.layout = r.layout as LayoutPref;
  const se = r.showEq as Record<string, unknown> | undefined;
  if (se && typeof se === 'object') {
    for (const k of ['cover', 'book', 'tabletop'] as const) if (typeof se[k] === 'boolean') p.showEq[k] = se[k] as boolean;
  }
  if (typeof r.showPl === 'boolean') p.showPl = r.showPl;
  if (VIS.includes(r.visMode as VisMode)) p.visMode = r.visMode as VisMode;
  if (r.timeMode === 'elapsed' || r.timeMode === 'remaining') p.timeMode = r.timeMode;
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  p.volume = num(r.volume, 0, 1, p.volume);
  p.balance = num(r.balance, -1, 1, p.balance);
  if (typeof r.shuffle === 'boolean') p.shuffle = r.shuffle;
  if (typeof r.repeat === 'boolean') p.repeat = r.repeat;
  const eq = r.eq as Record<string, unknown> | undefined;
  if (eq && typeof eq === 'object') {
    if (typeof eq.on === 'boolean') p.eq.on = eq.on;
    if (typeof eq.auto === 'boolean') p.eq.auto = eq.auto;
    p.eq.preamp = num(eq.preamp, -12, 12, p.eq.preamp);
    if (Array.isArray(eq.bands) && eq.bands.length === 10) {
      p.eq.bands = eq.bands.map((b, i) => num(b, -12, 12, DEFAULT_PREFS.eq.bands[i]));
    }
  }
  return p;
}

export function loadPrefs(): Prefs {
  try {
    const s = localStorage.getItem(KEY);
    return sanitize(s ? JSON.parse(s) : null);
  } catch {
    return structuredClone(DEFAULT_PREFS);
  }
}

let saveTimer: number | undefined;
export function savePrefs(p: Prefs) {
  // Debounced: sliders call this continuously while dragging.
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable (private mode, quota): preferences just won't persist */
    }
  }, 150);
}

/** URL overrides: ?skin=light|classic&layout=cover|book|tabletop|auto&sim=1|0. Not persisted. */
export interface UrlOverrides {
  skin?: SkinId;
  layout?: LayoutPref;
  sim?: boolean;
  zoom?: number;
  /** Mock playback rate (testing). */
  rate?: number;
  autoplay?: boolean;
  /** Expose window.duoamp for automated checks. */
  test?: boolean;
}

export function readUrlOverrides(): UrlOverrides {
  const q = new URLSearchParams(location.search);
  const o: UrlOverrides = {};
  const skin = q.get('skin');
  if (SKINS.includes(skin as SkinId)) o.skin = skin as SkinId;
  const layout = q.get('layout');
  if (LAYOUTS.includes(layout as LayoutPref)) o.layout = layout as LayoutPref;
  const sim = q.get('sim');
  if (sim === '1' || sim === 'true') o.sim = true;
  if (sim === '0' || sim === 'false') o.sim = false;
  const zoom = Number(q.get('zoom'));
  if (zoom > 0.2 && zoom < 4) o.zoom = zoom;
  const rate = Number(q.get('rate'));
  if (rate > 0 && rate < 100) o.rate = rate;
  if (q.get('autoplay') === '1') o.autoplay = true;
  if (q.get('test') === '1') o.test = true;
  return o;
}
