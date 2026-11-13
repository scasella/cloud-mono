import { APP_NAME, APP_VERSION, type LayoutPref } from '../config';
import { EQ_PRESETS } from '../eq';
import type { SkinId, TimeMode, VisMode } from '../prefs';
import type { AppContext, SheetKind } from './context';
import { titleBar } from './context';
import { h, svg } from './dom';
import { pressable } from './controls';
import { ICONS } from './icons';

/**
 * Skinned menus and sheets. They open inside the pane that holds the control
 * that opened them, so nothing ever straddles the fold.
 */
export class Overlays {
  private openEl: HTMLElement | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };

  constructor(private ctx: AppContext) {}

  get isOpen() {
    return this.openEl !== null;
  }

  close() {
    if (!this.openEl) return;
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
      group<VisMode>('VISUAL', [['bars', 'BARS'], ['scope', 'SCOPE'], ['off', 'OFF']], prefs.visMode, (v) => {
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
      item('CONNECT MUSIC SERVICE...', () => this.openSheet('connect', anchor)),
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
    const close = h('button', 'btn sheet-close', [svg(ICONS.close)], { type: 'button', 'aria-label': 'Close' });
    pressable(close, () => this.close());
    const ok = h('button', 'btn btn-toggle sheet-ok', [h('span', 'btn-label', 'OK')], { type: 'button' });
    pressable(ok, () => this.close());
    const body = h('div', 'lcd sheet-body');
    let title: string;
    if (kind === 'connect') {
      title = 'CONNECT A MUSIC SERVICE';
      body.append(
        h('div', 'sheet-big', 'COMING SOON'),
        h('p', '', 'STREAMING SERVICES WILL PLUG IN HERE.'),
        h('p', '', `UNTIL THEN ${APP_NAME} PLAYS A SILENT DEMO LIBRARY.`),
        h('div', 'sheet-row', [h('span', '', 'SPOTIFY'), h('span', 'dim', 'SOON')]),
        h('div', 'sheet-row', [h('span', '', 'OTHER SERVICES'), h('span', 'dim', 'LATER')]),
      );
    } else {
      title = `ABOUT ${APP_NAME}`;
      body.append(
        h('div', 'sheet-big', `${APP_NAME} ${APP_VERSION}`),
        h('p', '', 'A RETRO DECK FOR ONE, TWO OR FOLDED SCREENS.'),
        h('p', '', 'ALL ARTWORK IS DRAWN IN CODE.'),
        h('p', '', 'FONTS: SILKSCREEN BY JASON KOTTKE, VT323 BY PETER HULL. SIL OPEN FONT LICENSE 1.1.'),
        h('p', 'dim', 'KEYS: Z X C V B = PREV PLAY PAUSE STOP NEXT. SPACE PAUSE. ARROWS VOLUME / SEEK. S SHUFFLE, R REPEAT.'),
      );
    }
    const head = titleBar(title);
    head.append(close);
    const panel = h('div', 'popup sheet win', [head, body, h('div', 'sheet-actions', [ok])], { role: 'dialog', 'aria-label': title });
    this.host(from, panel, (a, b, p) => this.centre(a, b, p));
  }
}
