/**
 * Single source for names, the logical pixel grid and everything device-specific.
 * Device numbers come from the iPhone Duo research (points == CSS px). They have
 * not been validated on hardware, so every threshold lives here and nowhere else.
 */

export const APP_NAME = 'DUOAMP';
export const APP_VERSION = '0.1.0';

/** Logical design grid. All window artwork is laid out in these units ("u"). */
export const GRID = {
  /** Width of every window in units; the pane width is divided by this to get 1u. */
  width: 275,
  /** Fixed-aspect windows. */
  mainHeight: 112,
  eqHeight: 116,
  /** Below this slot height (in u) the equaliser switches to its compact layout. */
  eqCompactBelow: 100,
  /** Smallest useful heights for the flexible windows (in u). */
  playlistMin: 64,
  visMin: 26,
  /** Gap between stacked windows (in u, per skin shape via CSS too). */
  windowGap: 0.5,
} as const;

export type Posture = 'cover' | 'book' | 'tabletop';
export type LayoutPref = Posture | 'auto';

export interface Insets { top: number; right: number; bottom: number; left: number }

export interface ScreenSpec {
  /** Full display size in CSS px, as drawn by the simulator. */
  width: number;
  height: number;
  /** System chrome the simulator paints (status strip/row, home indicator). */
  insets: Insets;
  /** Corner radius of the display glass in the simulator. */
  radius: number;
}

export const DEVICE = {
  /** Outer (folded) display, portrait. Status strip on the trailing edge. */
  cover: { width: 466, height: 678, insets: { top: 0, right: 84, bottom: 26, left: 0 }, radius: 28 } as ScreenSpec,
  /** Inner display opened like a book: landscape, fold runs vertically through the centre. */
  book: { width: 951, height: 669, insets: { top: 0, right: 84, bottom: 21, left: 0 }, radius: 28 } as ScreenSpec,
  /** Inner display opened like a laptop: portrait, fold runs horizontally through the centre. */
  tabletop: { width: 669, height: 951, insets: { top: 59, right: 0, bottom: 26, left: 0 }, radius: 28 } as ScreenSpec,
  /**
   * Gutter kept free of content where the fold is, in CSS px, used when the
   * Viewport Segments API is not available. Controls never sit in it.
   */
  foldGutter: 10,
  /**
   * Extra inset (CSS px) applied to pane edges that touch the display edge
   * where the system safe area is 0, so controls clear the rounded corners.
   */
  cornerInset: { x: 0, y: 0 },
  /**
   * Home Screen web app on the inner screen: in landscape the page reaches the
   * display's top edge (safe-area top 0, left 0) and the 28 pt rounded corner
   * clipped Main's menu button. 14 pt clears it (checked in the iOS 27.1 Simulator).
   */
  standaloneInnerCornerInset: { x: 0, y: 14 },
  /** Bezel thickness drawn around the display in the simulator. */
  bezel: 14,
} as const;

/** Auto-detection thresholds (CSS px). No user-agent sniffing. */
export const DETECT = {
  /** Outer display: shorter side <= this AND longer side <= coverMaxLong. */
  coverMaxShort: 470,
  coverMaxLong: 700,
  /**
   * Inner display: shorter side >= innerMinShort AND longer side >= innerMinLong.
   * Measured in the iOS 27.1 Simulator (Safari, iPhone Duo): inner landscape
   * 951 x 543 (tab bar showing) to 951 x 589; inner portrait 669 x 825 to 669 x 871.
   * Cover never exceeds 466 x 678. Set in the gap, below Safari's smallest inner size.
   */
  innerMinShort: 500,
  innerMinLong: 760,
  /** Delay (ms) for the second layout pass after a resize/posture change, once Safari's segments settle. */
  settleMs: 400,
  /** Anything larger than these is treated as desktop/tablet -> simulator. */
  simMinShort: 700,
  simMinLong: 1000,
} as const;

/** Timings for touch interactions (ms / px). */
export const TOUCH = {
  doubleTapMs: 320,
  tapSlopPx: 8,
  /** Relative distance (0..1) from centre within which balance/EQ snap to centre. */
  centreSnap: 0.06,
  /** How long a transient marquee message lingers after a drag ends. */
  messageLingerMs: 900,
} as const;
