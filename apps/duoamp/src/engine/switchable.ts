import type { ChangeKind, EngineNotice, Listener, NoticeListener, PlayerEngine, PlayerState } from './types';

const ALL_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['tick', 'status', 'track', 'tracks', 'settings', 'caps']);

/**
 * The engine the UI holds for its whole lifetime. It forwards to one inner
 * engine (the demo mock, or a Spotify engine) and re-emits its events; swapping
 * the inner engine tells every listener that everything changed.
 */
export class SwitchableEngine implements PlayerEngine {
  private listeners = new Set<Listener>();
  private noticeListeners = new Set<NoticeListener>();
  private unsub: Array<() => void> = [];

  constructor(private inner: PlayerEngine) {
    this.attach();
  }

  get current(): PlayerEngine {
    return this.inner;
  }

  /** Replace the inner engine. The previous one is disposed unless `keepOld`. */
  swap(next: PlayerEngine, keepOld = false) {
    if (next === this.inner) return;
    const old = this.inner;
    for (const u of this.unsub) u();
    this.unsub = [];
    this.inner = next;
    if (!keepOld) old.dispose();
    this.attach();
    const s = next.getState();
    for (const l of this.listeners) l(s, ALL_KINDS);
  }

  private attach() {
    this.unsub.push(
      this.inner.subscribe((s, k) => {
        for (const l of this.listeners) l(s, k);
      }),
      this.inner.subscribeNotices((n) => this.notify(n)),
    );
  }

  /** Lets non-engine code (the service) put a notice on the same channel. */
  notify(n: EngineNotice) {
    for (const l of this.noticeListeners) l(n);
  }

  getState(): PlayerState {
    return this.inner.getState();
  }
  getPosition() {
    return this.inner.getPosition();
  }
  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  subscribeNotices(l: NoticeListener) {
    this.noticeListeners.add(l);
    return () => this.noticeListeners.delete(l);
  }
  userGesture(kind?: string) {
    this.inner.userGesture(kind);
  }
  play() {
    return this.inner.play();
  }
  pause() {
    return this.inner.pause();
  }
  togglePause() {
    return this.inner.togglePause();
  }
  stop() {
    return this.inner.stop();
  }
  next() {
    return this.inner.next();
  }
  prev() {
    return this.inner.prev();
  }
  seek(s: number) {
    return this.inner.seek(s);
  }
  playIndex(i: number) {
    return this.inner.playIndex(i);
  }
  setVolume(v: number) {
    return this.inner.setVolume(v);
  }
  setBalance(b: number) {
    return this.inner.setBalance(b);
  }
  setShuffle(on: boolean) {
    return this.inner.setShuffle(on);
  }
  setRepeat(on: boolean) {
    return this.inner.setRepeat(on);
  }
  readSpectrum(out: Float32Array) {
    return this.inner.readSpectrum(out);
  }
  readWaveform(out: Float32Array) {
    return this.inner.readWaveform(out);
  }
  dispose() {
    for (const u of this.unsub) u();
    this.inner.dispose();
    this.listeners.clear();
    this.noticeListeners.clear();
  }
}
