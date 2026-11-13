import { TOUCH } from '../../config';
import type { PlayerState, Track } from '../../engine/types';
import type { AppContext, WinComponent } from '../context';
import { titleBar, windowTitle } from '../context';
import { fmtTime, h } from '../dom';
import { SkinButton } from '../controls';

import { DUOPIXEL_ADVANCE, DUOPIXEL_PX_PER_EM } from '../../fonts/duopixel-charset';
import { pixelText } from '../pixelText';

/** Monospace advance of DuoPixel as a fraction of the font size. */
const ADVANCE_EM = DUOPIXEL_ADVANCE / DUOPIXEL_PX_PER_EM;

export class PlaylistWindow implements WinComponent {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private rowsEl: HTMLElement;
  private rows: HTMLElement[] = [];
  private names: HTMLElement[] = [];
  private bar: HTMLElement;
  private thumb: HTMLElement;
  private info1: HTMLElement;
  private info2: HTMLElement;
  private selected = -1;
  private current = -1;
  private state: PlayerState;
  private charsFit = 0;
  private lastTap = { row: -1, t: 0 };
  private u = 1;
  private firstLayout = true;
  /** Tracks the rows were built from, to append instead of rebuilding while a list streams in. */
  private builtFrom: readonly Track[] = [];

  constructor(private ctx: AppContext) {
    const { engine } = ctx;
    this.state = engine.getState();
    this.el = h('section', 'win win-pl', [], { 'aria-label': 'Playlist' });
    this.el.append(titleBar(windowTitle('PLAYLIST')));

    this.rowsEl = h('div', 'pl-rows', [], { role: 'listbox', 'aria-label': 'Tracks' });
    this.scroller = h('div', 'pl-scroll', [this.rowsEl]);
    const body = h('div', 'lcd pl-body', [this.scroller]);
    this.thumb = h('div', 'pl-thumb');
    this.bar = h('div', 'pl-scrollbar', [this.thumb], { 'aria-hidden': 'true' });

    const add = new SkinButton({ cls: 'btn-toggle btn-pl-add', label: 'ADD', aria: 'Add music', onPress: () => ctx.openSheet('library', add.el) });
    const now = new SkinButton({ cls: 'btn-toggle btn-pl-now', label: 'NOW', aria: 'Jump to current track', onPress: () => this.jumpToCurrent() });
    this.info1 = h('div', 'pl-info-line');
    this.info2 = h('div', 'pl-info-line');
    const info = h('div', 'lcd pl-info', [this.info1, this.info2]);
    const footer = h('div', 'pl-footer', [add.el, now.el, info]);
    this.el.append(body, this.bar, footer);

    this.bindRows();
    this.bindScrollbar();
    this.scroller.addEventListener('scroll', () => this.syncThumb(), { passive: true });
    const userScrolled = () => (this.firstLayout = false);
    this.scroller.addEventListener('touchstart', userScrolled, { passive: true });
    this.scroller.addEventListener('wheel', userScrolled, { passive: true });
    this.bar.addEventListener('pointerdown', userScrolled);
    engine.subscribe((s, kinds) => {
      this.state = s;
      if (kinds.has('tracks')) this.build();
      else if (kinds.has('caps')) this.renderInfo();
      if (kinds.has('track') || kinds.has('tracks')) this.setCurrent(s.index, true);
    });
    this.build();
    this.setCurrent(this.state.index, false);
  }

  private build() {
    const s = this.state;
    const old = this.builtFrom;
    const appendOnly = old.length > 0 && s.tracks.length >= old.length && old.every((t, i) => s.tracks[i] === t);
    let from = 0;
    if (appendOnly) from = old.length;
    else {
      this.rowsEl.textContent = '';
      this.rows = [];
      this.names = [];
      this.selected = -1;
      this.current = -1;
    }
    const frag = document.createDocumentFragment();
    for (let i = from; i < s.tracks.length; i++) {
      const t = s.tracks[i];
      const name = h('span', 'pl-name');
      const dur = h('span', 'pl-dur', fmtTime(t.duration));
      const row = h('div', 'pl-row', [name, dur], { role: 'option', 'data-i': String(i) });
      this.rows.push(row);
      this.names.push(name);
      frag.append(row);
    }
    this.rowsEl.append(frag);
    this.builtFrom = s.tracks;
    this.renderInfo();
    if (appendOnly && this.charsFit > 0) this.truncateRange(from, this.charsFit);
    else {
      this.charsFit = 0;
      this.truncate();
    }
    this.syncThumb();
  }

  /** Footer LCD: "SPOTIFY: <playlist>" (attribution) / track count + total time. */
  private renderInfo() {
    const s = this.state;
    const total = s.tracks.reduce((a, t) => a + t.duration, 0);
    this.info1.textContent = pixelText(s.serviceLabel ? `${s.serviceLabel}: ${s.sourceLabel}` : s.sourceLabel);
    this.info2.textContent = `${s.tracks.length} TRACKS ${fmtTime(total)}${s.loading ? ' ...' : ''}`;
  }

  /** Classic ".." truncation; DuoPixel is monospaced so this is exact. */
  private truncate() {
    const row = this.rows[0];
    if (!row) return;
    const name = this.names[0];
    const fs = parseFloat(getComputedStyle(name).fontSize) || 12;
    const ls = parseFloat(getComputedStyle(name).letterSpacing) || 0;
    const avail = name.getBoundingClientRect().width;
    const chars = Math.max(4, Math.floor((avail + ls) / (fs * ADVANCE_EM + ls)));
    if (chars === this.charsFit) return;
    this.charsFit = chars;
    this.truncateRange(0, chars);
  }

  private truncateRange(from: number, chars: number) {
    const tracks = this.state.tracks;
    for (let i = from; i < tracks.length && i < this.names.length; i++) {
      const t = tracks[i];
      const full = pixelText(`${i + 1}. ${t.artist} - ${t.title}`);
      this.names[i].textContent = full.length <= chars ? full : full.slice(0, chars - 2) + '..';
    }
  }

  private rowAt(e: PointerEvent): number {
    const el = (e.target as HTMLElement).closest('.pl-row') as HTMLElement | null;
    return el ? Number(el.dataset.i) : -1;
  }

  private bindRows() {
    let down: { x: number; y: number; row: number; t: number } | null = null;
    this.scroller.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, row: this.rowAt(e), t: performance.now() };
    });
    this.scroller.addEventListener('pointermove', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > TOUCH.tapSlopPx) down = null;
    });
    this.scroller.addEventListener('pointercancel', () => (down = null));
    this.scroller.addEventListener('pointerup', (e) => {
      if (!down || down.row < 0 || this.rowAt(e) !== down.row) {
        down = null;
        return;
      }
      const row = down.row;
      down = null;
      const now = performance.now();
      if (this.lastTap.row === row && now - this.lastTap.t < TOUCH.doubleTapMs + 80) {
        this.lastTap = { row: -1, t: 0 };
        void this.ctx.engine.playIndex(row);
      } else {
        this.lastTap = { row, t: now };
        this.select(row);
      }
    });
    this.scroller.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.selected >= 0) void this.ctx.engine.playIndex(this.selected);
    });
  }

  private select(i: number) {
    if (this.selected >= 0) this.rows[this.selected]?.classList.remove('is-selected');
    this.selected = i;
    this.rows[i]?.classList.add('is-selected');
  }

  private setCurrent(i: number, scroll: boolean) {
    if (i === this.current && this.rows[i]?.classList.contains('is-current')) return;
    if (this.current >= 0) this.rows[this.current]?.classList.remove('is-current');
    this.current = i;
    const row = this.rows[i];
    if (!row) return;
    row.classList.add('is-current');
    if (scroll) this.ensureVisible(row, false);
  }

  private ensureVisible(row: HTMLElement, centre: boolean, instant = false) {
    const sc = this.scroller;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    let target: number | null = null;
    if (centre) target = top - (sc.clientHeight - row.offsetHeight) / 2;
    else if (top < sc.scrollTop) target = top;
    else if (bottom > sc.scrollTop + sc.clientHeight) target = bottom - sc.clientHeight;
    if (target === null) return;
    sc.scrollTo({ top: Math.max(0, target), behavior: this.ctx.reducedMotion || instant ? 'auto' : 'smooth' });
  }

  jumpToCurrent() {
    this.firstLayout = false;
    const row = this.rows[this.current];
    if (!row) return;
    this.select(this.current);
    this.ensureVisible(row, true);
  }

  private bindScrollbar() {
    let drag: { startY: number; startTop: number } | null = null;
    const ratio = () => {
      const sc = this.scroller;
      const travel = this.bar.clientHeight - this.thumb.offsetHeight;
      return travel > 0 ? (sc.scrollHeight - sc.clientHeight) / travel : 0;
    };
    this.bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        this.bar.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
      const tr = this.thumb.getBoundingClientRect();
      if (e.clientY < tr.top || e.clientY > tr.bottom) {
        // Jump so the thumb centres on the touch, then keep dragging.
        const br = this.bar.getBoundingClientRect();
        const y = e.clientY - br.top - tr.height / 2;
        this.scroller.scrollTop = y * ratio();
      }
      drag = { startY: e.clientY, startTop: this.scroller.scrollTop };
      this.bar.classList.add('is-dragging');
    });
    this.bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.scroller.scrollTop = drag.startTop + (e.clientY - drag.startY) * ratio();
    });
    const end = () => {
      drag = null;
      this.bar.classList.remove('is-dragging');
    };
    this.bar.addEventListener('pointerup', end);
    this.bar.addEventListener('pointercancel', end);
  }

  private syncThumb() {
    const sc = this.scroller;
    const trackH = this.bar.clientHeight;
    const minH = 10 * this.u;
    const th = sc.scrollHeight > 0 ? Math.max(minH, (sc.clientHeight / sc.scrollHeight) * trackH) : trackH;
    const travel = trackH - th;
    const max = sc.scrollHeight - sc.clientHeight;
    const y = max > 0 ? (sc.scrollTop / max) * travel : 0;
    this.thumb.style.height = `${th}px`;
    this.thumb.style.transform = `translateY(${y}px)`;
  }

  layout(u: number) {
    this.u = u;
    requestAnimationFrame(() => {
      this.charsFit = 0;
      this.truncate();
      this.syncThumb();
      const row = this.rows[this.current];
      // Until the user scrolls, keep the current track centred (layout runs
      // again when fonts load or the posture changes).
      if (row) this.ensureVisible(row, this.firstLayout, this.firstLayout);
    });
  }
}
