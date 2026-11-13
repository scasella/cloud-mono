import { GRID, type Posture } from '../config';
import type { PlayerEngine } from '../engine/types';
import type { SpotifyService } from '../spotify/service';
import { EqStore, autoPresetFor } from '../eq';
import { planLayout, watchLayoutChanges, type LayoutPlan } from '../posture';
import { savePrefs, type Prefs, type SkinId, type UrlOverrides } from '../prefs';
import { applySkin } from '../skins';
import type { AppContext, SheetKind, WinComponent } from './context';
import { h, prefersReducedMotion } from './dom';
import { Overlays } from './overlay';
import { SimChrome } from './sim';
import { MainWindow } from './windows/main';
import { EqWindow } from './windows/eq';
import { PlaylistWindow } from './windows/playlist';
import { VisWindow } from './windows/vis';
import { DockWindow } from './windows/dock';

interface Entry {
  w: WinComponent;
  /** Fixed height in units. */
  fixed?: number;
  /** Flexible: min / max height in units. */
  min?: number;
  max?: number;
}

/**
 * Which windows go in which pane, per posture.
 *
 * cover:    Main / [EQ or Vis] / Playlist. Hiding PL lets Vis fill the rest.
 * book:     left = Main / EQ? / Vis(fill); right = Playlist. EQ shares the
 *           left pane with Main because both are fixed-aspect, and Vis is the
 *           natural filler; the playlist keeps a full-height pane.
 * tabletop: top = Main / [Vis strip or compact EQ]; bottom = Playlist. The
 *           top pane only has a short strip under Main, so EQ uses its compact
 *           layout there rather than squeezing the playlist below the fold.
 * Hiding PL in a two-pane posture gives the freed pane to Vis; any leftover
 * space in the other pane gets the blank dock panel.
 */
export function compose(p: Posture, eqOn: boolean, plOn: boolean, w: Record<'main' | 'eq' | 'pl' | 'vis' | 'dock', WinComponent>): Entry[][] {
  const main: Entry = { w: w.main, fixed: GRID.mainHeight };
  const eq: Entry = { w: w.eq, fixed: GRID.eqHeight };
  const visFill: Entry = { w: w.vis, min: GRID.visMin };
  const plFill: Entry = { w: w.pl, min: GRID.playlistMin };
  const dock: Entry = { w: w.dock, min: 0 };
  if (p === 'cover') {
    if (plOn) return [[main, eqOn ? eq : { w: w.vis, fixed: GRID.eqHeight }, plFill]];
    return [eqOn ? [main, eq, visFill] : [main, visFill]];
  }
  if (p === 'book') {
    if (plOn) return [eqOn ? [main, eq, visFill] : [main, visFill], [plFill]];
    return [eqOn ? [main, eq, dock] : [main, dock], [visFill]];
  }
  const eqStrip: Entry = { w: w.eq, min: 40, max: GRID.eqHeight };
  if (plOn) return [[main, eqOn ? eqStrip : visFill], [plFill]];
  return [[main, eqOn ? eqStrip : dock], [visFill]];
}

/** Max relative change accepted when snapping a font pixel to whole device pixels. */
const SNAP_TOLERANCE = 0.06;

/**
 * Snap a font pixel to whole device pixels when that changes its size by no
 * more than SNAP_TOLERANCE; otherwise keep the exact size (slightly soft
 * edges beat text that no longer fits). When 1u is itself a whole number of
 * device pixels (the simulator picks such a zoom when it can) the grid is
 * pixel-perfect and snapping is always applied.
 */
function snapFp(px: number, dpr: number, snapAlways: boolean) {
  const snapped = Math.max(1, Math.round(px * dpr)) / dpr;
  return snapAlways || Math.abs(snapped - px) / px <= SNAP_TOLERANCE ? snapped : px;
}

/** Font sizes snapped so pixel-font pixels land on whole device pixels. */
function typeVars(pane: HTMLElement, u: number) {
  const dpr = window.devicePixelRatio || 1;
  const s = pane.style;
  const exactGrid = Math.abs(u * dpr - Math.round(u * dpr)) < 0.02;
  pane.dataset.pixelGrid = exactGrid ? 'exact' : 'fractional';
  s.setProperty('--u', `${u}px`);
  // Silkscreen: 8 font-pixels per em.
  s.setProperty('--fs-label', `${8 * snapFp(0.8 * u, dpr, exactGrid)}px`);
  s.setProperty('--fs-title-sk', `${8 * snapFp(0.95 * u, dpr, exactGrid)}px`);
  // DuoPixel: 8 font pixels per em; each font pixel snapped to whole device pixels.
  // --fp-* is the font pixel itself, so tracking can be a whole number of font pixels too.
  const dp = (name: string, k: number) => {
    const fp = snapFp(k * u, dpr, exactGrid);
    s.setProperty(`--fp-${name}`, `${fp}px`);
    s.setProperty(`--fs-${name}`, `${8 * fp}px`);
  };
  // Multipliers chosen so the researched pane widths land within the snap tolerance at 3x.
  dp('title', 0.95);
  dp('marquee', 1.2);
  dp('readout', 1);
  dp('pl', 1);
  dp('info', 0.95);
  dp('menu', 1);
  dp('logo', 1.75);
}

export class App {
  private ctx: AppContext;
  private stage: HTMLElement;
  private screen: HTMLElement;
  private panes: HTMLElement[] = [];
  private wins: Record<'main' | 'eq' | 'pl' | 'vis' | 'dock', WinComponent>;
  private mainWin: MainWindow;
  private overlays: Overlays;
  private sim: SimChrome;
  private plan: LayoutPlan | null = null;
  private last = performance.now();

  constructor(root: HTMLElement, engine: PlayerEngine, spotify: SpotifyService, private prefs: Prefs, private url: UrlOverrides) {
    const eq = new EqStore(prefs.eq);
    const self = this;
    this.ctx = {
      engine,
      spotify,
      eq,
      prefs,
      reducedMotion: prefersReducedMotion(),
      commitPrefs: () => this.commit(),
      setSkin: (s: SkinId) => this.setSkin(s),
      relayout: () => this.relayout(),
      openMenu: (a) => self.overlays.openMenu(a),
      openPresets: (a) => self.overlays.openPresets(a),
      openSheet: (k: SheetKind, from) => self.overlays.openSheet(k, from),
      message: (t, linger = 1000) => self.mainWin.setMessage(t, linger),
      posture: () => self.plan?.posture ?? 'cover',
    };
    this.overlays = new Overlays(this.ctx);
    applySkin(url.skin ?? prefs.skin);
    if (url.skin) prefs.skin = url.skin;

    this.screen = h('div', 'screen');
    this.stage = h('div', 'stage', [this.screen]);
    root.append(this.stage);
    this.sim = new SimChrome(this.stage, this.screen, {
      setLayout: (l) => {
        this.prefs.layout = l;
        this.url.layout = undefined;
        this.commit();
        this.relayout();
      },
      setSkin: (s) => this.setSkin(s),
      current: () => ({ layout: this.url.layout ?? this.prefs.layout, skin: this.prefs.skin }),
    });

    this.mainWin = new MainWindow(this.ctx);
    this.wins = {
      main: this.mainWin,
      eq: new EqWindow(this.ctx),
      pl: new PlaylistWindow(this.ctx),
      vis: new VisWindow(this.ctx),
      dock: new DockWindow(),
    };

    // Engine notices (errors, unsupported actions) go to the marquee.
    engine.subscribeNotices((n) => this.ctx.message(n.text, n.level === 'info' ? 1800 : 3200));
    // Audio unlock: engines that need a user gesture (iOS) get called synchronously
    // inside every gesture, before any button handler runs (capture phase).
    for (const ev of ['pointerup', 'touchend', 'keydown', 'click'] as const) {
      window.addEventListener(ev, () => engine.userGesture(ev), { capture: true, passive: true });
    }

    eq.subscribe(() => {
      prefs.eq = eq.get();
      this.commit();
    });
    engine.subscribe((s, kinds) => {
      if (kinds.has('track') && eq.get().auto) {
        const t = s.current;
        if (t) {
          const p = autoPresetFor(t.id);
          eq.applyPreset(p);
        }
      }
    });

    // No long-press callouts / context menus on touch.
    this.stage.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', (m) => {
      this.ctx.reducedMotion = m.matches;
    });
    watchLayoutChanges(() => this.relayout());
    this.relayout();
    // Fonts change metrics (truncation, marquee width) once loaded.
    document.fonts?.ready.then(() => this.relayout());
    requestAnimationFrame((t) => this.loop(t));
  }

  private commit() {
    savePrefs(this.prefs);
    this.mainWin.syncToggles();
  }

  private setSkin(s: SkinId) {
    this.prefs.skin = s;
    this.url.skin = undefined;
    applySkin(s);
    this.commit();
    this.relayout();
  }

  relayout() {
    this.overlays.close();
    const layoutPref = this.url.layout ?? this.prefs.layout;
    const plan = planLayout({
      layoutPref,
      simOverride: this.url.sim,
      zoomOverride: this.url.zoom,
      simChrome: { w: 48, h: 120 },
    });
    this.plan = plan;
    const root = document.documentElement;
    root.dataset.mode = plan.mode;
    root.dataset.posture = plan.posture;
    this.stage.dataset.mode = plan.mode;
    this.stage.dataset.posture = plan.posture;
    this.stage.dataset.source = plan.source;
    this.screen.style.width = `${plan.screen.w}px`;
    this.screen.style.height = `${plan.screen.h}px`;
    this.sim.update(plan);
    this.mainWin.syncToggles();

    const layout = compose(plan.posture, this.prefs.showEq[plan.posture], this.prefs.showPl, this.wins);
    while (this.panes.length < layout.length) {
      const p = h('div', 'pane');
      this.panes.push(p);
    }
    this.panes.forEach((p, i) => {
      if (i < layout.length) {
        if (!p.isConnected) this.screen.append(p);
      } else p.remove();
    });
    // Detach everything, then re-attach per composition.
    const used = new Set(layout.flat().map((e) => e.w));
    for (const w of Object.values(this.wins)) if (!used.has(w)) w.el.remove();

    layout.forEach((entries, i) => {
      const pane = this.panes[i];
      const r = plan.panes[i];
      pane.style.left = `${r.x}px`;
      pane.style.top = `${r.y}px`;
      pane.style.width = `${r.w}px`;
      pane.style.height = `${r.h}px`;
      pane.dataset.index = String(i);
      this.layoutPane(pane, r.w, r.h, entries);
    });
  }

  private layoutPane(pane: HTMLElement, W: number, H: number, entries: Entry[]) {
    const gap = GRID.windowGap;
    const minTotal = entries.reduce((a, e) => a + (e.fixed ?? e.min ?? 0), 0) + gap * (entries.length - 1);
    const u = Math.max(0.5, Math.min(W / GRID.width, minTotal > 0 ? H / minTotal : Infinity));
    typeVars(pane, u);
    const availU = H / u - gap * (entries.length - 1);
    const heights = entries.map((e) => e.fixed ?? e.min ?? 0);
    let spare = availU - heights.reduce((a, b) => a + b, 0);
    // Distribute spare space among flexible windows, respecting max.
    for (let pass = 0; pass < 3 && spare > 0.01; pass++) {
      const growers = entries.map((e, i) => (e.fixed === undefined && (e.max === undefined || heights[i] < e.max) ? i : -1)).filter((i) => i >= 0);
      if (!growers.length) break;
      const share = spare / growers.length;
      for (const i of growers) {
        const cap = entries[i].max ?? Infinity;
        const add = Math.min(share, cap - heights[i]);
        heights[i] += add;
        spare -= add;
      }
    }
    const winW = GRID.width * u;
    const x = Math.round((W - winW) / 2);
    let y = 0;
    entries.forEach((e, i) => {
      const el = e.w.el;
      if (el.parentElement !== pane) pane.append(el);
      const hPx = heights[i] * u;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${winW}px`;
      el.style.height = `${hPx}px`;
      el.style.display = hPx < 2 ? 'none' : '';
      y += hPx + gap * u;
      e.w.layout(u, heights[i]);
    });
  }

  private loop(t: number) {
    const dt = Math.min(0.1, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    if (!document.hidden) {
      for (const w of Object.values(this.wins)) if (w.el.isConnected && w.frame) w.frame(t, dt);
      this.sim.frame();
    }
    requestAnimationFrame((n) => this.loop(n));
  }

  private onKey(e: KeyboardEvent) {
    if (this.overlays.isOpen || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement)?.getAttribute?.('role');
    if (tag === 'slider' && e.key.startsWith('Arrow')) return;
    const en = this.ctx.engine;
    const s = en.getState();
    const k = e.key.toLowerCase();
    let handled = true;
    switch (k) {
      case 'z': void en.prev(); break;
      case 'x': void en.play(); break;
      case 'c': void en.pause(); break;
      case 'v': void en.stop(); break;
      case 'b': void en.next(); break;
      case ' ': void en.togglePause(); break;
      case 's': void en.setShuffle(!s.shuffle); this.prefs.shuffle = !s.shuffle; this.commit(); break;
      case 'r': void en.setRepeat(!s.repeat); this.prefs.repeat = !s.repeat; this.commit(); break;
      case 'arrowup':
      case 'arrowdown': {
        const v = Math.max(0, Math.min(1, s.volume + (k === 'arrowup' ? 0.05 : -0.05)));
        void en.setVolume(v);
        if (!s.capabilities.volume) break; // the engine posts why
        this.prefs.volume = v;
        this.commit();
        this.ctx.message(`VOLUME: ${Math.round(v * 100)}%`, 900);
        break;
      }
      case 'arrowleft':
      case 'arrowright':
        if (s.status !== 'stopped') void en.seek(en.getPosition() + (k === 'arrowright' ? 5 : -5));
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  /** Test hook access to the main window (screenshots of the LCD states). */
  get main() {
    return this.mainWin;
  }

  get currentPlan() {
    return this.plan;
  }
}
