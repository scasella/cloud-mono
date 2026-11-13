import { GRID } from '../../config';
import { SKINS } from '../../skins';
import type { PlayerState } from '../../engine/types';
import type { AppContext, WinComponent } from '../context';
import { titleBar, windowTitle } from '../context';
import { fmtTime, h, place } from '../dom';
import { SkinButton, Slider, pressable } from '../controls';
import { ICONS } from '../icons';
import { GLYPHS, PixelCanvas, digitsWidth } from '../pixels';
import { Bars } from '../bars';
import { pixelText } from '../pixelText';

const LCD = { x: 8, y: 18, w: 94, h: 44 };
const DIGIT_P = 1.25;
const MARQUEE_SPEED_U = 16; // units per second
/** Each track's text starts with its number at the left edge and holds this long. */
const MARQUEE_HOLD_MS = 2000;

export class MainWindow implements WinComponent {
  readonly el: HTMLElement;
  private lcd = new PixelCanvas('lcd-canvas');
  private bars = new Bars(21);
  private marquee: HTMLElement;
  private marqueeText: HTMLElement;
  private marqueeStr = '';
  private marqueeOffset = 0;
  private marqueeW = 0;
  private msg: string | null = null;
  private msgTimer: number | undefined;
  private kbps: HTMLElement;
  private khz: HTMLElement;
  private mono: HTMLElement;
  private stereo: HTMLElement;
  private vol: Slider;
  private bal: Slider;
  private seek: Slider;
  private eqBtn: SkinButton;
  private plBtn: SkinButton;
  private shuffleBtn: SkinButton;
  private repBtn: SkinButton;
  private u = 1;
  private state: PlayerState;
  /** Marquee holds at the start of each track (ms timestamp). */
  private holdUntil = 0;
  /** Test hook: show this many seconds on the LCD instead of the live position. */
  lcdOverride: number | null = null;

  constructor(private ctx: AppContext) {
    const { engine } = ctx;
    this.state = engine.getState();
    this.el = h('section', 'win win-main', [], { 'aria-label': 'Player' });
    this.el.style.setProperty('--win-h', String(GRID.mainHeight));
    this.el.append(titleBar(windowTitle(), { onMenu: (b) => ctx.openMenu(b) }));

    // LCD: play state, time, mini spectrum. Tapping the time toggles elapsed/remaining.
    const lcdBox = place(h('div', 'lcd lcd-main'), LCD.x, LCD.y, LCD.w, LCD.h);
    lcdBox.append(this.lcd.el);
    const timeHit = h('button', 'hit time-hit', [], { type: 'button', 'aria-label': 'Toggle elapsed / remaining time' });
    place(timeHit, 18, -2, 76, 26);
    pressable(timeHit, () => {
      ctx.prefs.timeMode = ctx.prefs.timeMode === 'elapsed' ? 'remaining' : 'elapsed';
      ctx.commitPrefs();
    });
    lcdBox.append(timeHit);
    this.el.append(lcdBox);

    this.marqueeText = h('span', 'marquee-text');
    this.marquee = place(h('div', 'lcd marquee', [this.marqueeText]), 108, 18, 160, 12);
    this.el.append(this.marquee);

    // Readout row as a flex strip with real gaps, so it survives small text-size differences.
    this.kbps = h('div', 'lcd readout readout-kbps', '256');
    this.khz = h('div', 'lcd readout readout-khz', '44');
    this.mono = h('span', 'lbl ind', 'MONO');
    this.stereo = h('span', 'lbl ind', 'STEREO');
    const infoRow = place(h('div', 'info-row', [
      this.kbps,
      h('span', 'lbl', 'KBPS'),
      this.khz,
      h('span', 'lbl', 'KHZ'),
      h('span', 'info-spacer'),
      this.mono,
      this.stereo,
    ]), 108, 34, 160, 10);
    this.el.append(infoRow);

    this.vol = new Slider({
      orientation: 'h',
      cls: 'sl-volume',
      aria: 'Volume',
      value: this.state.volume,
      onInput: (v, phase) => {
        engine.setVolume(v);
        ctx.prefs.volume = v;
        ctx.commitPrefs();
        this.dragMessage(phase, `VOLUME: ${Math.round(v * 100)}%`);
      },
    });
    place(this.vol.el, 108, 48, 66, 11);
    this.bal = new Slider({
      orientation: 'h',
      cls: 'sl-balance',
      aria: 'Balance',
      value: (this.state.balance + 1) / 2,
      snapCentre: true,
      resetTo: 0.5,
      onInput: (v, phase) => {
        const b = v * 2 - 1;
        engine.setBalance(b);
        ctx.prefs.balance = b;
        ctx.commitPrefs();
        const pct = Math.round(Math.abs(b) * 100);
        this.dragMessage(phase, pct === 0 ? 'BALANCE: CENTER' : `BALANCE: ${pct}% ${b < 0 ? 'LEFT' : 'RIGHT'}`);
      },
    });
    place(this.bal.el, 180, 48, 36, 11);

    this.eqBtn = new SkinButton({
      cls: 'btn-toggle btn-eq', label: 'EQ', led: true, aria: 'Toggle equalizer',
      onPress: () => {
        const p = ctx.posture();
        ctx.prefs.showEq[p] = !ctx.prefs.showEq[p];
        ctx.commitPrefs();
        ctx.relayout();
      },
    });
    place(this.eqBtn.el, 222, 48, 22, 11);
    this.plBtn = new SkinButton({
      cls: 'btn-toggle btn-pl', label: 'PL', led: true, aria: 'Toggle playlist',
      onPress: () => {
        ctx.prefs.showPl = !ctx.prefs.showPl;
        ctx.commitPrefs();
        ctx.relayout();
      },
    });
    place(this.plBtn.el, 246, 48, 22, 11);
    this.el.append(this.vol.el, this.bal.el, this.eqBtn.el, this.plBtn.el);

    this.seek = new Slider({
      orientation: 'h',
      cls: 'sl-seek',
      aria: 'Seek',
      value: 0,
      onInput: (v, phase) => {
        const d = engine.getState().duration;
        const t = v * d;
        if (phase === 'end') {
          engine.seek(t);
          this.dragMessage('end', '');
        } else {
          this.dragMessage(phase, `SEEK TO: ${fmtTime(t)}/${fmtTime(d)} (${Math.round(v * 100)}%)`);
        }
      },
    });
    place(this.seek.el, 8, 70, 260, 11);
    this.el.append(this.seek.el);

    const tb = (cls: string, icon: string, aria: string, x: number, fn: () => void) => {
      const b = new SkinButton({ cls: `btn-transport ${cls}`, icon, aria, onPress: fn });
      place(b.el, x, 88, 22, 21);
      this.el.append(b.el);
      return b;
    };
    tb('t-prev', ICONS.prev, 'Previous track', 8, () => engine.prev());
    tb('t-play', ICONS.play, 'Play', 31, () => engine.play());
    tb('t-pause', ICONS.pause, 'Pause', 54, () => engine.pause());
    tb('t-stop', ICONS.stop, 'Stop', 77, () => engine.stop());
    tb('t-next', ICONS.next, 'Next track', 100, () => engine.next());
    const ej = tb('t-eject', ICONS.eject, 'Open music source', 127, () => ctx.openSheet('connect', ej.el));

    this.shuffleBtn = new SkinButton({
      cls: 'btn-toggle btn-shuffle', label: 'SHUFFLE', led: true, aria: 'Shuffle',
      onPress: () => {
        const on = !engine.getState().shuffle;
        engine.setShuffle(on);
        ctx.prefs.shuffle = on;
        ctx.commitPrefs();
        ctx.message(on ? 'SHUFFLE: ON' : 'SHUFFLE: OFF', 900);
      },
    });
    place(this.shuffleBtn.el, 156, 91.5, 44, 14);
    this.repBtn = new SkinButton({
      cls: 'btn-toggle btn-rep', label: 'REP', led: true, aria: 'Repeat',
      onPress: () => {
        const on = !engine.getState().repeat;
        engine.setRepeat(on);
        ctx.prefs.repeat = on;
        ctx.commitPrefs();
        ctx.message(on ? 'REPEAT: ON' : 'REPEAT: OFF', 900);
      },
    });
    place(this.repBtn.el, 203, 91.5, 28, 14);
    const logo = h('button', 'btn logo-tile', [h('span', 'logo-us'), h('span', 'logo-d', 'D'), h('span', 'logo-us')], { type: 'button', 'aria-label': 'About' });
    pressable(logo, () => ctx.openSheet('about', logo));
    place(logo, 243, 88, 25, 21);
    this.el.append(this.shuffleBtn.el, this.repBtn.el, logo);

    engine.subscribe((s, kinds) => this.onState(s, kinds));
    this.onState(this.state, new Set(['track', 'status', 'settings']));
  }

  private dragMessage(phase: 'start' | 'move' | 'end', text: string) {
    if (phase === 'end') this.ctx.message(null);
    else this.ctx.message(text, 0);
  }

  /** Marquee message API, driven by ctx.message. */
  setMessage(text: string | null, lingerMs: number) {
    if (this.msgTimer !== undefined) clearTimeout(this.msgTimer);
    this.msgTimer = undefined;
    if (text) {
      this.msg = text;
      if (lingerMs > 0) this.msgTimer = window.setTimeout(() => this.setMessage(null, 0), lingerMs);
    } else if (this.msg !== null) {
      // Let the last value linger briefly after a drag ends.
      this.msgTimer = window.setTimeout(() => {
        this.msg = null;
        this.renderMarquee();
      }, 700);
      return;
    }
    this.renderMarquee();
  }

  private onState(s: PlayerState, kinds: ReadonlySet<string>) {
    this.state = s;
    if (kinds.has('track') || kinds.has('tracks')) {
      const t = s.tracks[s.index];
      this.marqueeStr = pixelText(t ? `${s.index + 1}. ${t.artist} - ${t.title} (${fmtTime(t.duration)})  ***  ` : `${windowTitle()}  ***  `);
      this.marqueeOffset = 0;
      this.holdUntil = performance.now() + MARQUEE_HOLD_MS;
      this.marqueeText.style.transform = '';
      this.kbps.textContent = String(t?.kbps ?? 256);
      this.khz.textContent = String(t?.khz ?? 44);
      const stereo = (t?.channels ?? 2) === 2;
      this.stereo.classList.toggle('is-lit', stereo);
      this.mono.classList.toggle('is-lit', !stereo);
      this.renderMarquee();
    }
    if (kinds.has('settings') || kinds.has('track')) {
      this.vol.set(s.volume);
      this.bal.set((s.balance + 1) / 2);
      this.shuffleBtn.setOn(s.shuffle);
      this.repBtn.setOn(s.repeat);
    }
    this.syncToggles();
  }

  syncToggles() {
    this.eqBtn.setOn(this.ctx.prefs.showEq[this.ctx.posture()]);
    this.plBtn.setOn(this.ctx.prefs.showPl);
  }

  private renderMarquee() {
    if (this.msg) {
      this.marquee.classList.add('is-message');
      this.marqueeText.textContent = pixelText(this.msg);
      this.marqueeText.style.transform = '';
      return;
    }
    this.marquee.classList.remove('is-message');
    // Two copies so the strip wraps seamlessly.
    this.marqueeText.textContent = this.marqueeStr + this.marqueeStr;
    this.marqueeW = this.marqueeText.scrollWidth / 2;
  }

  layout(u: number) {
    this.u = u;
    this.lcd.fit(u);
    this.renderMarquee();
  }

  frame(now: number, dt: number) {
    const { engine, prefs } = this.ctx;
    const pos = engine.getPosition();
    const s = this.state;
    if (!this.seek.dragging) this.seek.set(s.duration > 0 ? pos / s.duration : 0);

    // Marquee: scroll in whole device pixels for the stepped retro look.
    if (!this.msg && !this.ctx.reducedMotion && this.marqueeW > 0 && now >= this.holdUntil) {
      this.marqueeOffset = (this.marqueeOffset + MARQUEE_SPEED_U * this.u * dt) % this.marqueeW;
      const dpr = window.devicePixelRatio || 1;
      const stepPx = Math.max(1, Math.round(this.u * dpr)) / dpr;
      const x = Math.floor(this.marqueeOffset / stepPx) * stepPx;
      this.marqueeText.style.transform = `translate3d(${-x}px,0,0)`;
    }

    // LCD
    const tk = SKINS[prefs.skin];
    const c = this.lcd;
    c.clear(tk.lcdBg);
    c.ctx.fillStyle = tk.lcdText;
    const glyph = s.status === 'playing' ? GLYPHS.play : s.status === 'paused' ? GLYPHS.pause : GLYPHS.stop;
    c.map(glyph, 5, 5, 1);
    const remaining = prefs.timeMode === 'remaining';
    const shown = this.lcdOverride ?? (remaining ? Math.max(0, s.duration - pos) : pos);
    const total = Math.floor(shown);
    const mm = Math.min(99, Math.floor(total / 60));
    const txt = `${String(mm).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    const blinkOff = this.lcdOverride === null && s.status === 'paused' && !this.ctx.reducedMotion && Math.floor(now / 500) % 2 === 1;
    const dw = digitsWidth(txt) * DIGIT_P;
    const dx = LCD.w - 5 - dw;
    c.ctx.fillStyle = tk.lcdDigit;
    if (!blinkOff) {
      c.digits(txt, dx, 4, DIGIT_P);
      if (remaining) c.digits('-', dx - 9 * DIGIT_P, 4, DIGIT_P);
    }

    // Mini spectrum
    const sy = 24;
    const sh = LCD.h - sy - 4;
    this.bars.update(this.ctx, dt);
    const grad = c.ctx.createLinearGradient(0, (sy + sh) * c.k, 0, sy * c.k);
    grad.addColorStop(0, tk.visLo);
    grad.addColorStop(0.55, tk.visMid);
    grad.addColorStop(1, tk.visHi);
    for (let i = 0; i < this.bars.n; i++) {
      const x = 5 + i * 4;
      const v = this.bars.level[i];
      const bh = Math.round(v * sh);
      if (bh > 0) {
        c.ctx.fillStyle = grad;
        c.rect(x, sy + sh - bh, 3, bh);
      }
      const pk = Math.round(this.bars.peak[i] * sh);
      if (pk > 0 && this.bars.active) {
        c.ctx.fillStyle = tk.visPeak;
        c.rect(x, sy + sh - pk - 1, 3, 1);
      }
    }
  }
}
