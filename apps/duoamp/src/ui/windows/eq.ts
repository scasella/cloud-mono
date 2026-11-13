import { GRID } from '../../config';
import { EQ_LABELS, EQ_RANGE } from '../../eq';
import { SKINS } from '../../skins';
import type { EqSettings } from '../../prefs';
import type { AppContext, WinComponent } from '../context';
import { titleBar, windowTitle } from '../context';
import { h, place } from '../dom';
import { SkinButton, Slider, type SliderPhase } from '../controls';
import { PixelCanvas } from '../pixels';

const toV = (db: number) => (db + EQ_RANGE) / (2 * EQ_RANGE);
const toDb = (v: number) => v * 2 * EQ_RANGE - EQ_RANGE;
const fmtDb = (db: number) => `${db > 0 ? '+' : db < 0 ? '-' : '+'}${Math.abs(db).toFixed(1)} DB`;

export class EqWindow implements WinComponent {
  readonly el: HTMLElement;
  private graph = new PixelCanvas('eq-graph-canvas');
  private graphBox: HTMLElement;
  private onBtn: SkinButton;
  private autoBtn: SkinButton;
  private presetsBtn: HTMLButtonElement;
  private preamp: Slider;
  private bands: Slider[] = [];
  private bandLabels: HTMLElement[] = [];
  private scale: HTMLElement[];
  private preampLabel: HTMLElement;
  private dirty = true;
  private u = 1;

  constructor(private ctx: AppContext) {
    const { eq } = ctx;
    this.el = h('section', 'win win-eq', [], { 'aria-label': 'Equalizer' });
    this.el.append(titleBar(windowTitle('EQUALIZER')));

    this.onBtn = new SkinButton({
      cls: 'btn-toggle btn-eq-on', label: 'ON', led: true, aria: 'Equalizer on',
      onPress: () => {
        eq.setOn(!eq.get().on);
        ctx.message(eq.get().on ? 'EQUALIZER: ON' : 'EQUALIZER: OFF', 900);
      },
    });
    this.autoBtn = new SkinButton({
      cls: 'btn-toggle btn-eq-auto', label: 'AUTO', led: true, aria: 'Automatic equalizer presets',
      onPress: () => {
        eq.setAuto(!eq.get().auto);
        ctx.message(eq.get().auto ? 'EQ AUTO: ON' : 'EQ AUTO: OFF', 900);
      },
    });
    const presets = new SkinButton({ cls: 'btn-toggle btn-presets', label: 'PRESETS', aria: 'Equalizer presets', onPress: () => ctx.openPresets(this.presetsBtn) });
    this.presetsBtn = presets.el;
    this.graphBox = h('div', 'lcd eq-graph', [this.graph.el]);

    const st = eq.get();
    this.preamp = new Slider({
      orientation: 'v', cls: 'sl-eq sl-preamp', aria: 'Preamp', value: toV(st.preamp), snapCentre: true, resetTo: 0.5, steps: 48,
      onInput: (v, phase) => {
        eq.setPreamp(toDb(v));
        this.drag(phase, `PREAMP: ${fmtDb(toDb(v))}`);
      },
    });
    for (let i = 0; i < 10; i++) {
      const s = new Slider({
        orientation: 'v', cls: 'sl-eq', aria: `${EQ_LABELS[i]} Hz`, value: toV(st.bands[i]), snapCentre: true, resetTo: 0.5, steps: 48,
        onInput: (v, phase) => {
          eq.setBand(i, toDb(v));
          const hz = EQ_LABELS[i].endsWith('K') ? `${EQ_LABELS[i]}HZ` : `${EQ_LABELS[i]} HZ`;
          this.drag(phase, `${hz}: ${fmtDb(toDb(v))}`);
        },
      });
      this.bands.push(s);
      this.bandLabels.push(h('span', 'lbl eq-freq', EQ_LABELS[i]));
    }
    this.scale = ['+12DB', '+0DB', '-12DB'].map((t) => h('span', 'lbl eq-scale', t));
    this.preampLabel = h('span', 'lbl eq-freq', 'PREAMP');

    this.el.append(this.onBtn.el, this.autoBtn.el, this.graphBox, this.presetsBtn, this.preamp.el, this.preampLabel, ...this.scale);
    this.bands.forEach((b, i) => this.el.append(b.el, this.bandLabels[i]));

    eq.subscribe((s) => this.sync(s));
    this.sync(st);
  }

  private drag(phase: SliderPhase, text: string) {
    if (phase === 'end') this.ctx.message(null);
    else this.ctx.message(text, 0);
  }

  private sync(s: EqSettings) {
    this.onBtn.setOn(s.on);
    this.autoBtn.setOn(s.auto);
    this.preamp.set(toV(s.preamp));
    this.bands.forEach((b, i) => b.set(toV(s.bands[i])));
    this.el.classList.toggle('is-eq-off', !s.on);
    this.dirty = true;
  }

  layout(u: number, hU: number) {
    this.u = u;
    const compact = hU < GRID.eqCompactBelow;
    this.el.classList.toggle('is-compact', compact);
    if (!compact) {
      place(this.onBtn.el, 10, 18, 24, 11);
      place(this.autoBtn.el, 37, 18, 32, 11);
      place(this.graphBox, 80, 16, 124, 26);
      this.graphBox.style.display = '';
      place(this.presetsBtn, 212, 18, 52, 12);
      // Band sliders run the full height between the graph and the labels;
      // the preamp (left of the graph) starts higher.
      const top = 45;
      const th = 57;
      const ptop = 33;
      const pth = top + th - ptop;
      place(this.preamp.el, 12, ptop, 14, pth);
      // Scale labels sit on the preamp knob centres for +12 / 0 / -12.
      const knob = 10;
      const ys = [ptop + knob / 2, ptop + pth / 2, ptop + pth - knob / 2];
      this.scale.forEach((el, i) => {
        el.style.display = '';
        place(el, 29, ys[i] - 4, 30, 8);
      });
      place(this.preampLabel, 2, 105, 36, 8);
      this.bands.forEach((b, i) => {
        const x = 76 + i * 19.2;
        place(b.el, x, top, 14, th);
        place(this.bandLabels[i], x - 4, 105, 22, 8);
      });
    } else {
      // Compact strip (tabletop slot): controls in a left column, no graph.
      const top = 16;
      const th = Math.max(20, hU - top - 10);
      place(this.onBtn.el, 6, 17, 22, 10);
      place(this.autoBtn.el, 30, 17, 28, 10);
      place(this.presetsBtn, 6, 29, 52, 10);
      this.graphBox.style.display = 'none';
      place(this.preamp.el, 66, top, 14, th);
      this.scale.forEach((el) => (el.style.display = 'none'));
      place(this.preampLabel, 55, top + th + 1, 36, 8);
      this.bands.forEach((b, i) => {
        const x = 94 + i * 17.6;
        place(b.el, x, top, 14, th);
        place(this.bandLabels[i], x - 4, top + th + 1, 22, 8);
      });
    }
    if (!compact) {
      requestAnimationFrame(() => {
        this.graph.fit(this.u);
        this.dirty = true;
      });
    }
  }

  frame() {
    if (!this.dirty || this.el.classList.contains('is-compact')) return;
    this.dirty = false;
    this.drawGraph();
  }

  private drawGraph() {
    const c = this.graph;
    if (c.width < 2) return;
    const tk = SKINS[this.ctx.prefs.skin];
    const s = this.ctx.eq.get();
    c.clear(tk.lcdBg);
    const W = c.wU;
    const H = c.hU;
    const mid = H / 2;
    const amp = mid - 2;
    // Zero line and preamp marker.
    c.ctx.fillStyle = tk.graphZero;
    for (let x = 1; x < W - 1; x += 2) c.rect(x, Math.round(mid - 0.5), 1, 1);
    const py = mid - (s.preamp / EQ_RANGE) * amp;
    c.ctx.fillStyle = tk.graphLine2;
    c.rect(0, py - 0.5, 2, 1);
    // Smooth Catmull-Rom curve through the ten band values, stroked at device resolution.
    const pts = s.bands.map((db, i) => ({ x: 3 + (i * (W - 6)) / 9, y: mid - (db / EQ_RANGE) * amp }));
    const k = c.k;
    const g = c.ctx;
    g.save();
    g.beginPath();
    const steps = Math.max(40, Math.round(W * k / 2));
    for (let n = 0; n <= steps; n++) {
      const fx = pts[0].x + ((pts[9].x - pts[0].x) * n) / steps;
      let i = 0;
      while (i < 8 && fx > pts[i + 1].x) i++;
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(9, i + 2)];
      const t = (fx - p1.x) / (p2.x - p1.x);
      const t2 = t * t;
      const t3 = t2 * t;
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      const yy = Math.max(1, Math.min(H - 1, y));
      if (n === 0) g.moveTo(0, yy * k);
      g.lineTo(fx * k, yy * k);
      if (n === steps) g.lineTo(W * k, yy * k);
    }
    if (!s.on) g.strokeStyle = tk.lcdTextDim;
    else if (this.ctx.prefs.skin === 'classic') {
      // Classic: green near 0 dB shading to yellow at the extremes.
      const grad = g.createLinearGradient(0, 0, 0, H * k);
      grad.addColorStop(0, tk.graphLine2);
      grad.addColorStop(0.35, tk.graphLine);
      grad.addColorStop(0.65, tk.graphLine);
      grad.addColorStop(1, tk.graphLine2);
      g.strokeStyle = grad;
    } else g.strokeStyle = tk.graphLine;
    g.lineWidth = Math.max(1, 1.1 * k);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
    g.restore();
  }
}
