import { SKINS } from '../../skins';
import type { VisMode } from '../../prefs';
import type { AppContext, WinComponent } from '../context';
import { titleBar, windowTitle } from '../context';
import { h } from '../dom';
import { pressable } from '../controls';
import { PixelCanvas } from '../pixels';
import { Bars } from '../bars';

const MODES: VisMode[] = ['bars', 'scope', 'art', 'off'];
/** Bar geometry per skin (units): light = finely segmented, classic = solid chunky bars. */
const GEOM = { light: { w: 5, gap: 2 }, classic: { w: 6, gap: 1 } } as const;

/**
 * Spectrum analyser / oscilloscope / cover art. Tap cycles bars -> scope -> art -> off.
 * ART shows the current track's artwork exactly as supplied: scaled to fit
 * (object-fit: contain, never cropped or stretched) with nothing drawn over it.
 */
export class VisWindow implements WinComponent {
  readonly el: HTMLElement;
  private canvas = new PixelCanvas('vis-canvas');
  private bars = new Bars(32);
  private wave = new Float32Array(256);
  private u = 1;
  private art: HTMLImageElement;
  private artNone: HTMLElement;
  private artUrl = '';

  constructor(private ctx: AppContext) {
    this.el = h('section', 'win win-vis', [], { 'aria-label': 'Visualization' });
    this.el.append(titleBar(windowTitle('VISUALIZATION')));
    this.art = h('img', 'vis-art', [], { alt: '', decoding: 'async', draggable: 'false' });
    this.art.addEventListener('error', () => this.art.classList.add('is-broken'));
    this.art.addEventListener('load', () => this.art.classList.remove('is-broken'));
    this.artNone = h('span', 'vis-art-none', 'NO COVER ART');
    const screen = h('button', 'lcd vis-screen', [this.canvas.el, this.art, this.artNone], { type: 'button', 'aria-label': 'Cycle visualization mode' });
    pressable(screen, () => {
      const i = MODES.indexOf(ctx.prefs.visMode);
      ctx.prefs.visMode = MODES[(i + 1) % MODES.length];
      ctx.commitPrefs();
      const label = { bars: 'SPECTRUM ANALYZER', scope: 'OSCILLOSCOPE', art: 'COVER ART', off: 'VISUALIZATION OFF' }[ctx.prefs.visMode];
      ctx.message(`VIS: ${label}`, 1200);
    });
    this.el.append(screen);
  }

  private syncArt(on: boolean) {
    const cur = this.ctx.engine.getState().current;
    const url = on ? cur?.artUrl ?? '' : '';
    if (url !== this.artUrl) {
      this.artUrl = url;
      if (url) {
        this.art.src = url;
        this.art.alt = cur?.album ? `Cover art: ${cur.album}` : 'Cover art';
      } else this.art.removeAttribute('src');
    }
    this.el.classList.toggle('is-art', on);
    this.el.classList.toggle('has-art', on && !!url);
  }

  layout(u: number) {
    this.u = u;
    requestAnimationFrame(() => {
      this.canvas.fit(this.u);
      this.resizeBars();
    });
  }

  private resizeBars() {
    const { w, gap } = GEOM[this.ctx.prefs.skin];
    this.bars.resize(Math.max(8, Math.floor((this.canvas.wU - 2 + gap) / (w + gap))));
  }

  frame(_now: number, dt: number) {
    const c = this.canvas;
    if (c.width < 2) return;
    const tk = SKINS[this.ctx.prefs.skin];
    const mode = this.ctx.prefs.visMode;
    this.syncArt(mode === 'art');
    c.clear(tk.visBg);
    if (mode === 'off' || mode === 'art') return;
    const W = c.wU;
    const H = c.hU;
    if (mode === 'scope') {
      const live = this.ctx.engine.readWaveform(this.wave);
      c.ctx.fillStyle = tk.visHi;
      const mid = H / 2;
      const amp = (H / 2 - 2) * (this.ctx.engine.getState().volume * 0.6 + 0.4);
      let prev = mid;
      for (let x = 0; x < W - 1; x++) {
        const s = this.wave[Math.floor((x / W) * this.wave.length)] ?? 0;
        const y = Math.round(mid - (live ? s : 0) * amp);
        const y0 = Math.min(y, prev);
        c.rect(x + 1, y0, 1, Math.abs(y - prev) + 1);
        prev = y;
      }
      return;
    }
    const geom = GEOM[this.ctx.prefs.skin];
    if (this.bars.n !== Math.max(8, Math.floor((W - 2 + geom.gap) / (geom.w + geom.gap)))) this.resizeBars();
    this.bars.update(this.ctx, dt);
    const n = this.bars.n;
    const bw = geom.w;
    const step = bw + geom.gap;
    const used = n * step - geom.gap;
    const x0 = (W - used) / 2;
    const showPeaks = this.bars.active && !this.ctx.reducedMotion;
    if (this.ctx.prefs.skin === 'classic') {
      // Solid bars coloured by height, each with a lighter cap row; floating peaks above.
      const top = 1;
      const usableH = H - 2;
      const bottom = top + usableH;
      const grad = c.ctx.createLinearGradient(0, bottom * c.k, 0, top * c.k);
      grad.addColorStop(0, tk.visLo);
      grad.addColorStop(0.55, tk.visMid);
      grad.addColorStop(1, tk.visHi);
      for (let i = 0; i < n; i++) {
        const x = x0 + i * step;
        const bh = Math.round(this.bars.level[i] * usableH);
        if (bh > 0) {
          c.ctx.fillStyle = grad;
          c.rect(x, bottom - bh, bw, bh);
          c.ctx.fillStyle = tk.visCap;
          c.rect(x, bottom - bh, bw, 1);
        }
        const pk = Math.round(this.bars.peak[i] * usableH);
        if (showPeaks && pk > bh + 1) {
          c.ctx.fillStyle = tk.visPeak;
          c.rect(x, bottom - pk - 1, bw, 1);
        }
      }
      return;
    }
    // Light: segmented bars, 1u lit / 1u dark rows, coloured by height.
    const top = 1;
    const seg = 2;
    const rowsN = Math.floor((H - 2) / seg);
    const bottom = top + rowsN * seg;
    const colours = [tk.visLo, tk.visMid, tk.visHi];
    for (let i = 0; i < n; i++) {
      const lit = Math.round(this.bars.level[i] * rowsN);
      const x = x0 + i * step;
      for (let r = 0; r < lit; r++) {
        const f = r / rowsN;
        c.ctx.fillStyle = colours[f < 0.45 ? 0 : f < 0.8 ? 1 : 2];
        c.rect(x, bottom - (r + 1) * seg, bw, seg - 1);
      }
      const pk = Math.round(this.bars.peak[i] * rowsN);
      if (showPeaks && pk > 0) {
        c.ctx.fillStyle = tk.visPeak;
        c.rect(x, bottom - (pk + 1) * seg - 1, bw, 1);
      }
    }
  }
}
