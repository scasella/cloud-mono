import { DETECT, DEVICE, GRID, type Insets, type LayoutPref, type Posture } from './config';

/**
 * Resolves which layout to use (cover | book | tabletop), whether to draw the
 * simulator, and where the panes go. All thresholds come from config.ts.
 *
 * Progressive enhancement: when the browser exposes the Viewport Segments API
 * (window.viewport.segments) the panes are placed exactly on the segments;
 * the Device Posture API is consulted for the folded/continuous hint. Neither
 * is required.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export type LayoutSource = 'override' | 'segments' | 'heuristic' | 'simulator';

export interface LayoutPlan {
  mode: 'sim' | 'bleed';
  posture: Posture;
  source: LayoutSource;
  /** Screen size the panes live in (viewport in bleed, display in sim), CSS px. */
  screen: { w: number; h: number };
  insets: Insets;
  panes: Rect[];
  /** The fold gutter between panes, if any. */
  fold?: Rect;
  /** devicePosture.type when available. */
  devicePosture?: string;
}

interface ViewportWithSegments { segments?: ReadonlyArray<DOMRectReadOnly> }
interface DevicePostureLike extends EventTarget { type?: string }

export function viewportSegments(): DOMRectReadOnly[] | null {
  const vp = (window as unknown as { viewport?: ViewportWithSegments }).viewport;
  const segs = vp?.segments;
  if (segs && segs.length === 2) return Array.from(segs);
  return null;
}

function devicePosture(): DevicePostureLike | undefined {
  return (navigator as unknown as { devicePosture?: DevicePostureLike }).devicePosture;
}

export function detectPosture(w: number, h: number, segs: DOMRectReadOnly[] | null): { posture: Posture; source: LayoutSource } {
  if (segs) {
    const sideBySide = Math.abs(segs[0].top - segs[1].top) < 1;
    return { posture: sideBySide ? 'book' : 'tabletop', source: 'segments' };
  }
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  if (short <= DETECT.coverMaxShort && long <= DETECT.coverMaxLong) return { posture: 'cover', source: 'heuristic' };
  if (short >= DETECT.innerMinShort && long >= DETECT.innerMinLong) {
    return { posture: w >= h ? 'book' : 'tabletop', source: 'heuristic' };
  }
  return { posture: 'cover', source: 'heuristic' };
}

export function isSimulatorViewport(w: number, h: number): boolean {
  return Math.min(w, h) > DETECT.simMinShort || Math.max(w, h) > DETECT.simMinLong;
}

/** Pane rectangles inside a screen of size W×H with system insets. */
export function computePanes(
  posture: Posture,
  W: number,
  H: number,
  insets: Insets,
  gutter: number,
  segs?: DOMRectReadOnly[] | null,
  corner: { x: number; y: number } = { x: 0, y: 0 },
): { panes: Rect[]; fold?: Rect } {
  // Edges with no system inset get a small corner inset so nothing sits under the rounded glass.
  const cx = insets.left > 0 ? insets.left : corner.x;
  const cy = insets.top > 0 ? insets.top : corner.y;
  const cr = W - (insets.right > 0 ? insets.right : corner.x);
  const cb = H - (insets.bottom > 0 ? insets.bottom : corner.y);
  const clip = (r: Rect): Rect => {
    const x = Math.max(r.x, cx);
    const y = Math.max(r.y, cy);
    return { x, y, w: Math.max(0, Math.min(r.x + r.w, cr) - x), h: Math.max(0, Math.min(r.y + r.h, cb) - y) };
  };
  if (posture !== 'cover' && segs && segs.length === 2) {
    const [a, b] = segs.map((s) => clip({ x: s.left, y: s.top, w: s.width, h: s.height }));
    const fold = posture === 'book'
      ? { x: a.x + a.w, y: 0, w: b.x - (a.x + a.w), h: H }
      : { x: 0, y: a.y + a.h, w: W, h: b.y - (a.y + a.h) };
    return { panes: [a, b], fold };
  }
  if (posture === 'cover') return { panes: [clip({ x: 0, y: 0, w: W, h: H })] };
  if (posture === 'book') {
    // The fold is at the physical centre of the screen, not of the safe area.
    const fx = W / 2;
    return {
      panes: [clip({ x: 0, y: 0, w: fx - gutter / 2, h: H }), clip({ x: fx + gutter / 2, y: 0, w: W, h: H })],
      fold: { x: fx - gutter / 2, y: 0, w: gutter, h: H },
    };
  }
  const fy = H / 2;
  return {
    panes: [clip({ x: 0, y: 0, w: W, h: fy - gutter / 2 }), clip({ x: 0, y: fy + gutter / 2, w: W, h: H })],
    fold: { x: 0, y: fy - gutter / 2, w: W, h: gutter },
  };
}

/** Reads env(safe-area-inset-*) per edge (never assumes left == right). */
let probe: HTMLDivElement | null = null;
export function readSafeAreaInsets(): Insets {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

export interface PlanInput {
  layoutPref: LayoutPref;
  simOverride?: boolean;
  zoomOverride?: number;
  /** Room the simulator needs around the device (control bar etc.), CSS px. */
  simChrome: { w: number; h: number };
}

/** Largest zoom the simulator may use, and how far below best fit it may go for crisp pixels. */
const SIM_MAX_ZOOM = 1.25;
const SIM_MIN_FRACTION = 0.78;

/**
 * Pick a simulator zoom at which 1 grid unit in the first pane (the one with
 * Main) is a whole number of device pixels, so the artwork is pixel-perfect
 * on ordinary monitors. Falls back to the best-fit zoom when no such zoom is
 * within SIM_MIN_FRACTION of it.
 */
export function pixelPerfectZoom(posture: Posture, fit: number): number {
  const target = Math.max(0.35, Math.min(SIM_MAX_ZOOM, fit));
  const spec = DEVICE[posture];
  const corner = DEVICE.cornerInset;
  const w1 = computePanes(posture, spec.width, spec.height, spec.insets, DEVICE.foldGutter, null, corner).panes[0].w;
  const dpr = window.devicePixelRatio || 1;
  const perK = GRID.width / (w1 * dpr); // zoom needed per device pixel per unit
  let best: number | null = null;
  for (let k = Math.max(1, Math.floor(target / perK)); k <= Math.ceil(target / perK) + 1; k++) {
    const z = k * perK;
    if (z > Math.min(fit, SIM_MAX_ZOOM) || z < target * SIM_MIN_FRACTION) continue;
    if (best === null || Math.abs(z - target) < Math.abs(best - target)) best = z;
  }
  return best ?? target;
}

export function planLayout(input: PlanInput): LayoutPlan & { zoom: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const segs = viewportSegments();
  const sim = input.simOverride ?? isSimulatorViewport(vw, vh);
  const dp = devicePosture()?.type;

  if (sim) {
    const posture: Posture = input.layoutPref === 'auto' ? 'cover' : input.layoutPref;
    const spec = DEVICE[posture];
    const bez = DEVICE.bezel * 2;
    const fit = Math.min((vw - input.simChrome.w) / (spec.width + bez), (vh - input.simChrome.h) / (spec.height + bez));
    const zoom = input.zoomOverride ?? pixelPerfectZoom(posture, fit);
    const W = spec.width * zoom;
    const H = spec.height * zoom;
    const insets: Insets = {
      top: spec.insets.top * zoom,
      right: spec.insets.right * zoom,
      bottom: spec.insets.bottom * zoom,
      left: spec.insets.left * zoom,
    };
    const corner = { x: DEVICE.cornerInset.x * zoom, y: DEVICE.cornerInset.y * zoom };
    const { panes, fold } = computePanes(posture, W, H, insets, DEVICE.foldGutter * zoom, null, corner);
    return {
      mode: 'sim',
      posture,
      source: input.layoutPref === 'auto' ? 'simulator' : 'override',
      screen: { w: W, h: H },
      insets,
      panes,
      fold,
      zoom,
      devicePosture: dp,
    };
  }

  const detected = detectPosture(vw, vh, segs);
  const posture = input.layoutPref === 'auto' ? detected.posture : input.layoutPref;
  const source: LayoutSource = input.layoutPref === 'auto' ? detected.source : 'override';
  const insets = readSafeAreaInsets();
  const useSegs = segs && ((posture === 'book' && detected.posture === 'book') || (posture === 'tabletop' && detected.posture === 'tabletop'));
  const { panes, fold } = computePanes(posture, vw, vh, insets, DEVICE.foldGutter, useSegs ? segs : null, DEVICE.cornerInset);
  return { mode: 'bleed', posture, source, screen: { w: vw, h: vh }, insets, panes, fold, zoom: 1, devicePosture: dp };
}

/** Calls `cb` whenever anything that can change the plan changes. */
export function watchLayoutChanges(cb: () => void): () => void {
  let raf = 0;
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => cb());
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  const vp = (window as unknown as { viewport?: EventTarget }).viewport;
  vp?.addEventListener?.('segmentschange', schedule);
  const dp = devicePosture();
  dp?.addEventListener?.('change', schedule);
  const mqs = ['(horizontal-viewport-segments: 2)', '(vertical-viewport-segments: 2)', '(device-posture: folded)']
    .map((q) => window.matchMedia(q));
  mqs.forEach((m) => m.addEventListener?.('change', schedule));
  return () => {
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    vp?.removeEventListener?.('segmentschange', schedule);
    dp?.removeEventListener?.('change', schedule);
    mqs.forEach((m) => m.removeEventListener?.('change', schedule));
  };
}
