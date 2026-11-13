import { APP_NAME, APP_VERSION, type LayoutPref } from '../config';
import { EQ_PRESETS } from '../eq';
import type { SkinId, TimeMode, VisMode } from '../prefs';
import type { AppContext, SheetKind } from './context';
import { titleBar } from './context';
import { h, svg } from './dom';
import { pressable } from './controls';
import { ICONS } from './icons';
import { buildLibrarySheet } from './sheets/library';
import { buildDiagSheet } from './sheets/diagnostics';
import { para, sheetButton, type SheetSpec } from './sheets/kit';

/**
 * Skinned menus and sheets. They open inside the pane that holds the control
 * that opened them, so nothing ever straddles the fold.
 */
export class Overlays {
  private openEl: HTMLElement | null = null;
  private disposeOpen: (() => void) | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };

  constructor(private ctx: AppContext) {}

  get isOpen() {
    return this.openEl !== null;
  }

  close() {
    if (!this.openEl) return;
    this.disposeOpen?.();
    this.disposeOpen = null;
    this.openEl.remove();
    this.openEl = null;
    window.removeEventListener('keydown', this.onKey, true);
  }

  private host(anchor: HTMLElement, panel: HTMLElement, place: (pane: DOMRect, a: DOMRect, p: HTMLElement) => void) {
    this.close();
    const pane = (anchor.closest('.pane') as HTMLElement | null) ?? document.body;
    const scrim = h('div', 'overlay-scrim');
    const layer = h('div', 'overlay', [scrim, panel]);
    pressable(scrim, () => this.close());
    pane.append(layer);
    this.openEl = layer;
    window.addEventListener('keydown', this.onKey, true);
    const pr = pane.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    place(pr, ar, panel);
  }

  /** Position a dropdown under (or above) the anchor, clamped inside the pane. */
  private dropdown(pane: DOMRect, a: DOMRect, p: HTMLElement) {
    const pw = p.offsetWidth;
    const ph = p.offsetHeight;
    let x = a.left - pane.left;
    let y = a.bottom - pane.top + 2;
    if (y + ph > pane.height - 4) y = Math.max(4, a.top - pane.top - ph - 2);
    x = Math.max(4, Math.min(pane.width - pw - 4, x));
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
  }

  private centre(pane: DOMRect, _a: DOMRect, p: HTMLElement) {
    p.style.left = `${Math.max(4, (pane.width - p.offsetWidth) / 2)}px`;
    p.style.top = `${Math.max(4, (pane.height - p.offsetHeight) / 2)}px`;
  }

  openMenu(anchor: HTMLElement) {
    const { prefs } = this.ctx;
    const panel = h('div', 'popup menu', [], { role: 'menu', 'aria-label': `${APP_NAME} menu` });
    const group = <T extends string>(label: string, opts: Array<[T, string]>, cur: T, pick: (v: T) => void) => {
      const chips = opts.map(([v, text]) => {
        const b = h('button', `btn chip${v === cur ? ' is-on' : ''}`, [h('span', 'led'), h('span', 'btn-label', text)], {
          type: 'button', role: 'menuitemradio', 'aria-checked': String(v === cur),
        });
        pressable(b, () => {
          pick(v);
          this.close();
        });
        return b;
      });
      return h('div', 'menu-group', [h('div', 'menu-label', label), h('div', 'menu-chips', chips)]);
    };
    panel.append(
      h('div', 'menu-head', `${APP_NAME} MENU`),
      group<SkinId>('SKIN', [['light', 'LIGHT'], ['classic', 'CLASSIC']], prefs.skin, (v) => this.ctx.setSkin(v)),
      group<LayoutPref>('LAYOUT', [['auto', 'AUTO'], ['cover', 'COVER'], ['book', 'BOOK'], ['tabletop', 'TABLE']], prefs.layout, (v) => {
        prefs.layout = v;
        this.ctx.commitPrefs();
        this.ctx.relayout();
      }),
      group<VisMode>('VISUAL', [['bars', 'BARS'], ['scope', 'SCOPE'], ['art', 'ART'], ['off', 'OFF']], prefs.visMode, (v) => {
        prefs.visMode = v;
        this.ctx.commitPrefs();
      }),
      group<TimeMode>('TIME', [['elapsed', 'ELAPSED'], ['remaining', 'REMAINING']], prefs.timeMode, (v) => {
        prefs.timeMode = v;
        this.ctx.commitPrefs();
      }),
    );
    const item = (text: string, fn: () => void) => {
      const b = h('button', 'btn menu-item', [h('span', 'btn-label', text)], { type: 'button', role: 'menuitem' });
      pressable(b, fn);
      return b;
    };
    panel.append(
      h('div', 'menu-sep'),
      item(this.ctx.spotify.signedIn ? 'SPOTIFY LIBRARY...' : 'CONNECT SPOTIFY...', () => this.openSheet('library', anchor)),
    );
    // Attribution: link back to the current track on Spotify.
    const cur = this.ctx.engine.getState();
    if (cur.serviceLabel && cur.current?.externalUrl) {
      const a = h('a', 'btn menu-item menu-item-link', [h('span', 'btn-label', 'OPEN TRACK IN SPOTIFY')], {
        href: cur.current.externalUrl, target: '_blank', rel: 'noopener', role: 'menuitem',
      });
      a.addEventListener('click', () => setTimeout(() => this.close(), 0));
      panel.append(a);
    }
    panel.append(
      item('DIAGNOSTICS...', () => this.openSheet('diag', anchor)),
      item(`ABOUT ${APP_NAME}...`, () => this.openSheet('about', anchor)),
    );
    this.host(anchor, panel, (a, b, p) => this.dropdown(a, b, p));
  }

  openPresets(anchor: HTMLElement) {
    const panel = h('div', 'popup menu presets', [h('div', 'menu-head', 'EQ PRESETS')], { role: 'menu' });
    const list = h('div', 'preset-list');
    for (const p of EQ_PRESETS) {
      const b = h('button', 'btn menu-item', [h('span', 'btn-label', p.name)], { type: 'button', role: 'menuitem' });
      pressable(b, () => {
        this.ctx.eq.applyPreset(p);
        this.ctx.message(`EQ PRESET: ${p.name}`, 1200);
        this.close();
      });
      list.append(b);
    }
    panel.append(list);
    this.host(anchor, panel, (a, b, p) => this.dropdown(a, b, p));
  }

  openSheet(kind: SheetKind, from: HTMLElement) {
    const body = h('div', 'lcd sheet-body');
    const closeFn = () => this.close();
    let spec: SheetSpec;
    if (kind === 'library') {
      spec = buildLibrarySheet(this.ctx, body, closeFn, () => this.openSheet('diag', from));
    } else if (kind === 'diag') {
      const d = buildDiagSheet(this.ctx, body);
      spec = { ...d, actions: [...d.actions, sheetButton('OK', closeFn, 'sheet-ok')] };
    } else {
      body.append(
        h('div', 'sheet-big', `${APP_NAME} ${APP_VERSION}`),
        h('p', '', 'A RETRO DECK FOR ONE, TWO OR FOLDED SCREENS.'),
        h('p', '', 'ALL ARTWORK IS DRAWN IN CODE.'),
        h('p', '', 'TEXT FACE: DUOPIXEL, DRAWN FOR THIS PROJECT. LABELS: SILKSCREEN BY JASON KOTTKE (SIL OPEN FONT LICENSE 1.1).'),
        para('MUSIC, TRACK DATA AND COVER ART: SPOTIFY. PLAYBACK RUNS THROUGH SPOTIFY; THE VISUALIZER IS SYNTHESIZED AND THE EQUALIZER DOES NOT CHANGE THE SOUND.'),
        h('p', 'dim', 'KEYS: Z X C V B = PREV PLAY PAUSE STOP NEXT. SPACE PAUSE. ARROWS VOLUME / SEEK. S SHUFFLE, R REPEAT.'),
      );
      spec = { title: `ABOUT ${APP_NAME}`, actions: [sheetButton('OK', closeFn, 'sheet-ok')] };
    }
    const close = h('button', 'btn sheet-close', [svg(ICONS.close)], { type: 'button', 'aria-label': 'Close' });
    pressable(close, closeFn);
    const head = titleBar(spec.title);
    head.append(close);
    const panel = h('div', `popup sheet win sheet-${kind}${spec.wide ? ' is-wide' : ''}`, [head, body, h('div', 'sheet-actions', spec.actions)], {
      role: 'dialog', 'aria-label': spec.title,
    });
    this.host(from, panel, (a, b, p) => this.centre(a, b, p));
    this.disposeOpen = spec.dispose ?? null;
  }
}
