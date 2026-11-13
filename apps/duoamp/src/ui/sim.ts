import { DEVICE, type LayoutPref } from '../config';
import type { LayoutPlan } from '../posture';
import type { SkinId } from '../prefs';
import { h, svg } from './dom';

const MOON = `<svg viewBox="0 0 12 12"><path fill="currentColor" d="M7.6 1.2A5 5 0 1 0 10.8 9 4.2 4.2 0 0 1 7.6 1.2Z"/></svg>`;
const WIFI = `<svg viewBox="0 0 16 12"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M1.5 4.2a9.4 9.4 0 0 1 13 0"/><path d="M4 6.8a5.7 5.7 0 0 1 8 0"/></g><circle cx="8" cy="9.6" r="1.5" fill="currentColor"/></svg>`;
const RING = `<svg viewBox="0 0 40 40"><path d="M7 31A16 16 0 1 1 33 31" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

interface SimHooks {
  setLayout(l: LayoutPref): void;
  setSkin(s: SkinId): void;
  current(): { layout: LayoutPref; skin: SkinId };
}

/**
 * Simulator chrome for reviewing on ordinary screens: a drawn device bezel,
 * mock system status (strip or row), fold line, home indicator, and a small
 * control bar outside the device. None of it exists in full-bleed mode.
 */
export class SimChrome {
  private device: HTMLElement;
  private status: HTMLElement;
  private clock: HTMLElement;
  private fold: HTMLElement;
  private home: HTMLElement;
  private bar: HTMLElement;
  private info: HTMLElement;
  private buttons: Array<{ el: HTMLElement; kind: 'layout' | 'skin'; value: string }> = [];
  private lastMinute = -1;
  private mode: 'sim' | 'bleed' | null = null;

  constructor(private stage: HTMLElement, private screen: HTMLElement, private hooks: SimHooks) {
    this.device = h('div', 'sim-device');
    this.clock = h('span', 'sim-clock', '1:18');
    const pill = h('div', 'sim-pill', [h('i', 'sim-lens'), h('i', 'sim-dots')]);
    const wifi = h('div', 'sim-wifi', [svg(RING, 'sim-ring'), svg(WIFI, 'sim-wifi-icon'), h('i', 'sim-ring-dots')]);
    const clockBox = h('div', 'sim-clockbox', [svg(MOON, 'sim-moon'), this.clock]);
    this.status = h('div', 'sim-status', [pill, clockBox, wifi], { 'aria-hidden': 'true' });
    this.fold = h('div', 'sim-fold', [], { 'aria-hidden': 'true' });
    this.home = h('div', 'sim-home', [], { 'aria-hidden': 'true' });

    const mk = (kind: 'layout' | 'skin', value: string, label: string) => {
      const b = h('button', 'sim-btn', label, { type: 'button' });
      b.addEventListener('click', () => (kind === 'layout' ? hooks.setLayout(value as LayoutPref) : hooks.setSkin(value as SkinId)));
      this.buttons.push({ el: b, kind, value });
      return b;
    };
    this.info = h('span', 'sim-info');
    this.bar = h('div', 'sim-bar', [
      h('span', 'sim-group', [h('span', 'sim-cap', 'Posture'), mk('layout', 'cover', 'Cover'), mk('layout', 'book', 'Book'), mk('layout', 'tabletop', 'Tabletop')]),
      h('span', 'sim-group', [h('span', 'sim-cap', 'Skin'), mk('skin', 'light', 'Light'), mk('skin', 'classic', 'Classic')]),
      this.info,
    ]);
  }

  update(plan: LayoutPlan & { zoom?: number }) {
    const sim = plan.mode === 'sim';
    if (sim !== (this.mode === 'sim')) {
      if (sim) {
        this.stage.prepend(this.device);
        this.device.append(this.screen);
        this.screen.append(this.status, this.fold, this.home);
        this.stage.append(this.bar);
      } else {
        this.stage.prepend(this.screen);
        this.device.remove();
        this.status.remove();
        this.fold.remove();
        this.home.remove();
        this.bar.remove();
      }
    }
    this.mode = plan.mode;
    if (!sim) return;
    const z = plan.zoom ?? 1;
    const spec = DEVICE[plan.posture];
    this.device.style.setProperty('--z', String(z));
    this.device.style.padding = `${DEVICE.bezel * z}px`;
    this.device.style.borderRadius = `${(spec.radius + DEVICE.bezel) * z}px`;
    this.screen.style.borderRadius = `${spec.radius * z}px`;

    // Status: a vertical strip on the trailing edge (cover/book) or a row at the top (tabletop).
    const st = this.status.style;
    const vertical = plan.posture !== 'tabletop';
    this.status.classList.toggle('is-row', !vertical);
    if (vertical) {
      st.left = `${plan.screen.w - plan.insets.right}px`;
      st.top = '0px';
      st.width = `${plan.insets.right}px`;
      st.height = `${plan.screen.h}px`;
    } else {
      st.left = '0px';
      st.top = '0px';
      st.width = `${plan.screen.w}px`;
      st.height = `${plan.insets.top}px`;
    }
    if (plan.fold) {
      const f = plan.fold;
      Object.assign(this.fold.style, { display: '', left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
      this.fold.classList.toggle('is-horizontal', plan.posture === 'tabletop');
    } else this.fold.style.display = 'none';
    const contentW = plan.screen.w - plan.insets.left - plan.insets.right;
    const hw = Math.min(134 * z, contentW * 0.36);
    Object.assign(this.home.style, {
      left: `${plan.insets.left + (contentW - hw) / 2}px`,
      top: `${plan.screen.h - Math.max(8 * z, plan.insets.bottom * 0.4) - 2.5 * z}px`,
      width: `${hw}px`,
      height: `${5 * z}px`,
    });
    const cur = this.hooks.current();
    for (const b of this.buttons) {
      const on = b.kind === 'layout' ? (cur.layout === 'auto' ? plan.posture === b.value : cur.layout === b.value) : cur.skin === b.value;
      b.el.classList.toggle('is-on', on);
    }
    const panes = plan.panes.map((p) => `${Math.round(p.w)}×${Math.round(p.h)}`).join(' + ');
    this.info.textContent = `${spec.width}×${spec.height} @ ${Math.round(z * 100)}% · panes ${panes}`;
    this.lastMinute = -1;
    this.frame();
  }

  frame() {
    if (this.mode !== 'sim') return;
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    if (m === this.lastMinute) return;
    this.lastMinute = m;
    const hr = d.getHours() % 12 || 12;
    this.clock.textContent = `${hr}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}
