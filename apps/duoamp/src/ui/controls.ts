import { TOUCH } from '../config';
import { h, svg } from './dom';

/**
 * Touch-first press handling: pressed state on pointerdown, activation on
 * pointerup inside the (slop-expanded) control, cancel when dragged away.
 * Keyboard activation (Enter/Space on the <button>) also works.
 */
export function pressable(el: HTMLElement, onActivate: () => void, opts: { repeatMs?: number } = {}) {
  let active = false;
  let repeatTimer: number | undefined;
  const inside = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    const slop = Math.max(14, r.height * 0.6);
    return e.clientX >= r.left - slop && e.clientX <= r.right + slop && e.clientY >= r.top - slop && e.clientY <= r.bottom + slop;
  };
  const stopRepeat = () => {
    if (repeatTimer !== undefined) clearInterval(repeatTimer);
    repeatTimer = undefined;
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    active = true;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    el.classList.add('is-pressed');
    if (opts.repeatMs) {
      onActivate();
      repeatTimer = window.setInterval(onActivate, opts.repeatMs);
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    el.classList.toggle('is-pressed', inside(e));
  });
  el.addEventListener('pointerup', (e) => {
    if (!active) return;
    active = false;
    el.classList.remove('is-pressed');
    stopRepeat();
    if (inside(e) && !opts.repeatMs) onActivate();
  });
  const cancel = () => {
    active = false;
    el.classList.remove('is-pressed');
    stopRepeat();
  };
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('lostpointercapture', () => {
    if (active) cancel();
  });
  el.addEventListener('click', (e) => {
    // detail === 0: keyboard-initiated click; pointer clicks were handled above.
    if ((e as MouseEvent).detail === 0) onActivate();
  });
}

export interface ButtonOpts {
  cls: string;
  label?: string;
  icon?: string;
  led?: boolean;
  aria: string;
  onPress: () => void;
  repeatMs?: number;
}

export class SkinButton {
  readonly el: HTMLButtonElement;
  private ledEl?: HTMLElement;
  constructor(o: ButtonOpts) {
    const parts: Node[] = [];
    if (o.led) {
      this.ledEl = h('span', 'led');
      parts.push(this.ledEl);
    }
    if (o.icon) {
      // Icon pixels map to 0.8 grid units so icons stay on the window grid.
      const icon = svg(o.icon);
      const [, , vw, vh] = (icon.getAttribute('viewBox') ?? '0 0 8 8').split(' ').map(Number);
      icon.style.width = `calc(var(--u) * ${vw * 0.8})`;
      icon.style.height = `calc(var(--u) * ${vh * 0.8})`;
      parts.push(icon);
    }
    if (o.label) parts.push(h('span', 'btn-label', o.label));
    this.el = h('button', `btn ${o.cls}`, parts, { type: 'button', 'aria-label': o.aria });
    pressable(this.el, o.onPress, { repeatMs: o.repeatMs });
  }
  setOn(on: boolean) {
    this.el.classList.toggle('is-on', on);
    this.el.setAttribute('aria-pressed', String(on));
  }
}

export type SliderPhase = 'start' | 'move' | 'end';

export interface SliderOpts {
  orientation: 'h' | 'v';
  cls: string;
  aria: string;
  value: number;
  /** Snap to 0.5 when within TOUCH.centreSnap. */
  snapCentre?: boolean;
  /** Double-tap resets to this value. */
  resetTo?: number;
  /** Optional discrete steps (e.g. 0.5 dB on a 24 dB range). */
  steps?: number;
  onInput: (v: number, phase: SliderPhase) => void;
}

/**
 * Generic slider. Grabbing the knob drags relative to the grab point;
 * tapping the track jumps there and continues dragging. The root element is
 * the hit area (CSS extends it beyond the drawn track).
 */
export class Slider {
  readonly el: HTMLDivElement;
  readonly knob: HTMLDivElement;
  readonly fill: HTMLDivElement;
  private v: number;
  dragging = false;
  private grabOffset = 0;
  private lastDown = 0;

  constructor(private o: SliderOpts) {
    this.fill = h('div', 'slider-fill');
    const track = h('div', 'slider-track', [this.fill]);
    this.knob = h('div', 'slider-knob', [h('i', 'grip')]);
    this.el = h('div', `slider slider--${o.orientation} ${o.cls}`, [track, this.knob], {
      role: 'slider',
      'aria-label': o.aria,
      tabindex: '0',
      'aria-orientation': o.orientation === 'h' ? 'horizontal' : 'vertical',
    });
    this.v = o.value;
    this.render();
    this.bind();
  }

  get value() {
    return this.v;
  }

  set(v: number) {
    if (this.dragging) return;
    this.v = clamp01(v);
    this.render();
  }

  private render() {
    this.el.style.setProperty('--v', this.v.toFixed(4));
    this.el.setAttribute('aria-valuenow', String(Math.round(this.v * 100)));
  }

  private valueFromPointer(e: PointerEvent, useOffset: boolean): number {
    const r = this.el.getBoundingClientRect();
    const k = this.knob.getBoundingClientRect();
    let v: number;
    if (this.o.orientation === 'h') {
      const span = r.width - k.width;
      const x = e.clientX - r.left - k.width / 2 - (useOffset ? this.grabOffset : 0);
      v = span > 0 ? x / span : 0;
    } else {
      const span = r.height - k.height;
      const y = e.clientY - r.top - k.height / 2 - (useOffset ? this.grabOffset : 0);
      v = span > 0 ? 1 - y / span : 0;
    }
    v = clamp01(v);
    if (this.o.steps) v = Math.round(v * this.o.steps) / this.o.steps;
    if (this.o.snapCentre && Math.abs(v - 0.5) < TOUCH.centreSnap) v = 0.5;
    return v;
  }

  private bind() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      const now = performance.now();
      if (this.o.resetTo !== undefined && now - this.lastDown < TOUCH.doubleTapMs) {
        this.lastDown = 0;
        this.v = this.o.resetTo;
        this.render();
        this.o.onInput(this.v, 'start');
        this.o.onInput(this.v, 'end');
        return;
      }
      this.lastDown = now;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
      this.dragging = true;
      el.classList.add('is-dragging');
      const k = this.knob.getBoundingClientRect();
      const slop = 6;
      const onKnob = this.o.orientation === 'h'
        ? e.clientX >= k.left - slop && e.clientX <= k.right + slop
        : e.clientY >= k.top - slop && e.clientY <= k.bottom + slop;
      this.grabOffset = onKnob
        ? this.o.orientation === 'h'
          ? e.clientX - (k.left + k.width / 2)
          : e.clientY - (k.top + k.height / 2)
        : 0;
      this.v = this.valueFromPointer(e, true);
      this.render();
      this.o.onInput(this.v, 'start');
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const v = this.valueFromPointer(e, true);
      if (v !== this.v) {
        this.v = v;
        this.render();
        this.o.onInput(v, 'move');
      }
    });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      el.classList.remove('is-dragging');
      this.o.onInput(this.v, 'end');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('keydown', (e) => {
      const step = this.o.steps ? 1 / this.o.steps : 0.02;
      let d = 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -step;
      else return;
      e.preventDefault();
      e.stopPropagation();
      this.v = clamp01(this.v + d);
      this.render();
      this.o.onInput(this.v, 'start');
      this.o.onInput(this.v, 'end');
    });
  }
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}
