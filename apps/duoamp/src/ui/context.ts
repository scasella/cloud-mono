import type { PlayerEngine } from '../engine/types';
import type { SpotifyService } from '../spotify/service';
import type { EqStore } from '../eq';
import type { Prefs } from '../prefs';
import type { SkinId } from '../prefs';
import { APP_NAME, type Posture } from '../config';
import { h, svg } from './dom';
import { ICONS } from './icons';
import { pressable } from './controls';

export type SheetKind = 'library' | 'diag' | 'about';

export interface AppContext {
  engine: PlayerEngine;
  /** Only the library and diagnostics sheets use this; windows talk to `engine`. */
  spotify: SpotifyService;
  eq: EqStore;
  prefs: Prefs;
  /** Persist prefs after mutating them. */
  commitPrefs(): void;
  setSkin(s: SkinId): void;
  /** Re-run window composition (EQ/PL toggles, layout override). */
  relayout(): void;
  openMenu(anchor: HTMLElement): void;
  openPresets(anchor: HTMLElement): void;
  openSheet(kind: SheetKind, from: HTMLElement): void;
  /** Transient marquee message (e.g. while dragging). linger=0 keeps it until cleared. */
  message(text: string | null, lingerMs?: number): void;
  reducedMotion: boolean;
  /** Posture currently laid out. */
  posture(): Posture;
}

/** Window component contract. */
export interface WinComponent {
  readonly el: HTMLElement;
  /** Called after the composer sized the window. u = CSS px per unit, hU = height in units. */
  layout(u: number, hU: number): void;
  frame?(now: number, dt: number): void;
}

export function titleBar(text: string, opts: { onMenu?: (btn: HTMLElement) => void } = {}): HTMLElement {
  const children: Node[] = [];
  if (opts.onMenu) {
    const btn = h('button', 'btn menu-btn', [svg(ICONS.menu)], { type: 'button', 'aria-label': 'Menu' });
    pressable(btn, () => opts.onMenu!(btn));
    children.push(btn);
  } else {
    children.push(h('span', 'menu-spacer'));
  }
  children.push(h('span', 'rail'), h('span', 'title-text', text), h('span', 'rail'));
  children.push(h('span', 'menu-spacer'));
  return h('div', 'titlebar', children);
}

export function windowTitle(suffix?: string): string {
  return suffix ? `${APP_NAME} ${suffix}` : APP_NAME;
}
