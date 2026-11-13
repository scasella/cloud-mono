/**
 * Hand-authored pixel maps and a canvas wrapper that draws on the logical
 * unit grid while snapping every logical pixel edge to whole device pixels,
 * so artwork stays crisp at any pane width and devicePixelRatio.
 */

// 7×12 LCD digits. '#' = lit. Drawn for this project.
const DIGITS: Record<string, string[]> = {
  '0': ['.#####.', '#######', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '#######', '.#####.'],
  '1': ['...##..', '..###..', '.####..', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..', '.######', '.######'],
  '2': ['.#####.', '#######', '##...##', '.....##', '.....##', '.######', '######.', '##.....', '##.....', '##.....', '#######', '#######'],
  '3': ['######.', '#######', '.....##', '.....##', '.....##', '..#####', '..#####', '.....##', '.....##', '.....##', '#######', '######.'],
  '4': ['##...##', '##...##', '##...##', '##...##', '##...##', '#######', '.######', '.....##', '.....##', '.....##', '.....##', '.....##'],
  '5': ['#######', '#######', '##.....', '##.....', '##.....', '######.', '#######', '.....##', '.....##', '.....##', '#######', '######.'],
  '6': ['.######', '#######', '##.....', '##.....', '##.....', '######.', '#######', '##...##', '##...##', '##...##', '#######', '.#####.'],
  '7': ['#######', '#######', '.....##', '.....##', '....##.', '....##.', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..'],
  '8': ['.#####.', '#######', '##...##', '##...##', '##...##', '.#####.', '#######', '##...##', '##...##', '##...##', '#######', '.#####.'],
  '9': ['.#####.', '#######', '##...##', '##...##', '##...##', '#######', '.######', '.....##', '.....##', '.....##', '#######', '######.'],
  '-': ['.....', '.....', '.....', '.....', '.....', '#####', '#####', '.....', '.....', '.....', '.....', '.....'],
  ':': ['..', '..', '..', '##', '##', '..', '..', '##', '##', '..', '..', '..'],
  ' ': ['.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......'],
};
export const DIGIT_H = 12;

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
