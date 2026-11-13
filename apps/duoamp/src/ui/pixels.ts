/**
 * Hand-authored pixel maps and a canvas wrapper that draws on the logical
 * unit grid while snapping every logical pixel edge to whole device pixels,
 * so artwork stays crisp at any pane width and devicePixelRatio.
 */

// LCD digits: 9×13 cells with 2-px strokes, built from seven segments so the
// shapes stay consistent (and the "1" sits on the right, as on a real LCD).
const DW = 9;
const DH = 13;
const SEG: Record<string, [number, number, number, number]> = {
  // [row0, row1 (exclusive), col0, col1 (exclusive)]
  a: [0, 2, 0, DW],
  b: [0, 7, DW - 2, DW],
  c: [5, DH, DW - 2, DW],
  d: [DH - 2, DH, 0, DW],
  e: [5, DH, 0, 2],
  f: [0, 7, 0, 2],
  g: [5, 7, 0, DW],
};
const DIGIT_SEGS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];

function segmentGlyph(segs: string): string[] {
  const g = Array.from({ length: DH }, () => Array<string>(DW).fill('.'));
  for (const s of segs) {
    const [r0, r1, c0, c1] = SEG[s];
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) g[r][c] = '#';
  }
  // Round the four outer corners.
  for (const [r, c] of [[0, 0], [0, DW - 1], [DH - 1, 0], [DH - 1, DW - 1]]) g[r][c] = '.';
  return g.map((row) => row.join(''));
}

const DIGITS: Record<string, string[]> = {
  '-': segmentGlyph('g').map((row) => row.slice(1, DW - 1)),
  // The colon has its own 6-px cell with the dots centred, so it sits midway
  // between the minute and second pairs whatever digits surround it.
  ':': Array.from({ length: DH }, (_, r) => (r === 3 || r === 4 || r === 8 || r === 9 ? '..##..' : '......')),
  ' ': Array.from({ length: DH }, () => '.'.repeat(DW)),
};
DIGIT_SEGS.forEach((segs, i) => (DIGITS[String(i)] = segmentGlyph(segs)));
// The "1" is a centred 2-px stroke with a small flag: a right-aligned segment
// "1" leaves pairs like 01 / 10 and the colon looking lopsided.
DIGITS['1'] = Array.from({ length: DH }, (_, r) => {
  if (r === 0) return '....##...';
  if (r === 1 || r === 2) return '..####...';
  return '....##...';
});
export const DIGIT_H = DH;

// 5×7 play-state glyphs.
export const GLYPHS: Record<string, string[]> = {
  play: ['#....', '##...', '###..', '####.', '###..', '##...', '#....'],
  pause: ['##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##'],
  stop: ['.....', '#####', '#####', '#####', '#####', '#####', '.....'],
};

export function glyphWidth(ch: string): number {
  return (DIGITS[ch] ?? DIGITS[' '])[0].length;
}

/** Width in pixels of a digit string with 1px spacing. */
export function digitsWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += glyphWidth(ch) + 1;
  return Math.max(0, w - 1);
}

export class PixelCanvas {
  readonly el: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** device pixels per unit */
  k = 1;
  wU = 0;
  hU = 0;

  constructor(cls = 'pxcanvas') {
    this.el = document.createElement('canvas');
    this.el.className = cls;
    this.ctx = this.el.getContext('2d')!;
  }

  /** Size the backing store to the element's CSS box at the current DPR. */
  fit(unitPx: number) {
    const dpr = window.devicePixelRatio || 1;
    const r = this.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const hh = Math.max(1, Math.round(r.height * dpr));
    if (this.el.width !== w) this.el.width = w;
    if (this.el.height !== hh) this.el.height = hh;
    this.k = unitPx * dpr;
    this.wU = w / this.k;
    this.hU = hh / this.k;
    this.ctx.imageSmoothingEnabled = false;
  }

  get width() {
    return this.el.width;
  }
  get height() {
    return this.el.height;
  }

  clear(color?: string) {
    if (color) {
      this.ctx.fillStyle = color;
      this.ctx.fillRect(0, 0, this.el.width, this.el.height);
    } else this.ctx.clearRect(0, 0, this.el.width, this.el.height);
  }

  /** Fill a rect given in units, snapped to device pixels (never thinner than 1 px). */
  rect(x: number, y: number, w: number, hh: number) {
    const k = this.k;
    const x0 = Math.round(x * k);
    const y0 = Math.round(y * k);
    const x1 = Math.max(x0 + 1, Math.round((x + w) * k));
    const y1 = Math.max(y0 + 1, Math.round((y + hh) * k));
    this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  /** Draw a pixel map with logical pixel size p (units) at x,y (units). */
  map(rows: string[], x: number, y: number, p: number, gap = 0) {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        if (row.charCodeAt(c) === 35 /* # */) this.rect(x + c * p, y + r * p, p - gap, p - gap);
      }
    }
  }

  /** Draw LCD digits; returns width in units. */
  digits(text: string, x: number, y: number, p: number, gap = 0): number {
    let cx = x;
    for (const ch of text) {
      const g = DIGITS[ch] ?? DIGITS[' '];
      this.map(g, cx, y, p, gap);
      cx += (g[0].length + 1) * p;
    }
    return cx - x - p;
  }
}
