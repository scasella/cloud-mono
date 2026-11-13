import { SKINS } from '../../skins';
import type { VisMode } from '../../prefs';
import type { AppContext, WinComponent } from '../context';
import { titleBar, windowTitle } from '../context';
import { h } from '../dom';
import { pressable } from '../controls';
import { PixelCanvas } from '../pixels';
import { Bars } from '../bars';

const MODES: VisMode[] = ['bars', 'scope', 'off'];
const BAR_W = 5;
const BAR_GAP = 2;

/** Spectrum analyser / oscilloscope. Tap cycles bars -> scope -> off. */
export class VisWindow implements WinComponent {
  readonly el: HTMLElement;
  private canvas = new PixelCanvas('vis-canvas');
  private bars = new Bars(32);
  private wave = new Float32Array(256);
  private u = 1;

  constructor(private ctx: AppContext) {
    this.el = h('section', 'win win-vis', [], { 'aria-label': 'Visualization' });
    this.el.append(titleBar(windowTitle('VISUALIZATION')));
    const screen = h('button', 'lcd vis-screen', [this.canvas.el], { type: 'button', 'aria-label': 'Cycle visualization mode' });
    pressable(screen, () => {
      const i = MODES.indexOf(ctx.prefs.visMode);
      ctx.prefs.visMode = MODES[(i + 1) % MODES.length];
      ctx.commitPrefs();
      const label = { bars: 'SPECTRUM ANALYZER', scope: 'OSCILLOSCOPE', off: 'VISUALIZATION OFF' }[ctx.prefs.visMode];
      ctx.message(`VIS: ${label}`, 1200);
    });
    this.el.append(screen);
  }

  layout(u: number) {
    this.u = u;
    requestAnimationFrame(() => {
      this.canvas.fit(this.u);
      const n = Math.max(8, Math.floor((this.canvas.wU - 2 + BAR_GAP) / (BAR_W + BAR_GAP)));
      this.bars.resize(n);
    });
  }

  frame(_now: number, dt: number) {
    const c = this.canvas;
    if (c.width < 2) return;
    const tk = SKINS[this.ctx.prefs.skin];
    const mode = this.ctx.prefs.visMode;
    c.clear(tk.visBg);
    if (mode === 'off') return;
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
    this.bars.update(this.ctx, dt);
    const n = this.bars.n;
    const used = n * (BAR_W + BAR_GAP) - BAR_GAP;
    const x0 = (W - used) / 2;
    const top = 1;
    const usableH = H - top - 1;
    // Segmented bars: 1u lit / 1u dark rows; colour by height.
    const seg = 2;
    const rowsN = Math.floor(usableH / seg);
    const bottom = top + rowsN * seg;
    const colours = [tk.visLo, tk.visMid, tk.visHi];
    for (let i = 0; i < n; i++) {
      const lit = Math.round(this.bars.level[i] * rowsN);
      const x = x0 + i * (BAR_W + BAR_GAP);
      for (let r = 0; r < lit; r++) {
        const f = r / rowsN;
        c.ctx.fillStyle = colours[f < 0.45 ? 0 : f < 0.8 ? 1 : 2];
        c.rect(x, bottom - (r + 1) * seg, BAR_W, seg - 1);
      }
      const pk = Math.round(this.bars.peak[i] * rowsN);
      if (this.bars.active && pk > 0 && !this.ctx.reducedMotion) {
        c.ctx.fillStyle = tk.visPeak;
        c.rect(x, bottom - (pk + 1) * seg - 1, BAR_W, 1);
      }
    }
  }
}
