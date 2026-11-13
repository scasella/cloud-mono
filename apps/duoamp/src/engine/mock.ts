import { NO_DISALLOWS, type Capabilities, type ChangeKind, type Listener, type NoticeListener, type PlaybackStatus, type PlayerEngine, type PlayerState, type Track } from './types';
import { SpectrumSynth, SYNTH_BANDS, resampleSpectrum } from './spectrum';

export interface MockEngineOptions {
  tracks: Track[];
  startIndex?: number;
  sourceLabel?: string;
  volume?: number;
  balance?: number;
  shuffle?: boolean;
  repeat?: boolean;
  /** Playback speed multiplier (tests/screenshots). */
  rate?: number;
}

const PREV_RESTART_THRESHOLD = 3;
const MOCK_CAPS: Capabilities = Object.freeze({
  volume: true, balance: true, seek: true, inBrowserAudio: false, needsGesture: false, streamInfo: true,
});
const TICK_MS = 250;

/**
 * Silent playback simulator. Keeps a monotonic clock while "playing",
 * auto-advances, honours shuffle/repeat, and synthesises spectrum data.
 */
export class MockEngine implements PlayerEngine {
  private tracks: Track[];
  private index: number;
  private status: PlaybackStatus = 'stopped';
  /** Position at `anchorTime` (seconds). */
  private anchorPos = 0;
  private anchorTime = 0;
  private volume: number;
  private balance: number;
  private shuffle: boolean;
  private repeat: boolean;
  private sourceLabel: string;
  private rate: number;
  private listeners = new Set<Listener>();
  private noticeListeners = new Set<NoticeListener>();
  private timer: number | undefined;
  private synth = new SpectrumSynth();
  private synthBuf = new Float32Array(SYNTH_BANDS);
  /** Shuffle history so PREV walks back through what was actually played. */
  private history: number[] = [];

  constructor(opts: MockEngineOptions) {
    this.tracks = opts.tracks.slice();
    this.index = Math.min(Math.max(opts.startIndex ?? 0, 0), this.tracks.length - 1);
    this.volume = opts.volume ?? 0.72;
    this.balance = opts.balance ?? 0;
    this.shuffle = opts.shuffle ?? false;
    this.repeat = opts.repeat ?? false;
    this.sourceLabel = opts.sourceLabel ?? 'DEMO';
    this.rate = opts.rate ?? 1;
    this.loadSynth();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  // ---- state ---------------------------------------------------------------

  private now() {
    return performance.now() / 1000;
  }

  getPosition(): number {
    if (this.status !== 'playing') return this.anchorPos;
    const d = this.current()?.duration ?? 0;
    return Math.min(d, this.anchorPos + (this.now() - this.anchorTime) * this.rate);
  }

  private current(): Track | undefined {
    return this.tracks[this.index];
  }

  getState(): PlayerState {
    return {
      tracks: this.tracks,
      index: this.index,
      current: this.current() ?? null,
      status: this.status,
      position: this.getPosition(),
      duration: this.current()?.duration ?? 0,
      volume: this.volume,
      balance: this.balance,
      shuffle: this.shuffle,
      repeat: this.repeat,
      sourceLabel: this.sourceLabel,
      serviceLabel: '',
      loading: false,
      capabilities: MOCK_CAPS,
      disallows: NO_DISALLOWS,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeNotices(listener: NoticeListener): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  userGesture() {}

  private emit(...kinds: ChangeKind[]) {
    const set = new Set(kinds);
    const state = this.getState();
    for (const l of this.listeners) l(state, set);
  }

  private setAnchor(pos: number) {
    this.anchorPos = pos;
    this.anchorTime = this.now();
  }

  private loadSynth() {
    const t = this.current();
    if (t) this.synth.setTrack(t.id, t.duration);
  }

  private tick() {
    if (this.status !== 'playing') return;
    const t = this.current();
    if (t && this.getPosition() >= t.duration) {
      this.advance(true);
      return;
    }
    this.emit('tick');
  }

  /** Move to the following track; `auto` = reached end of track. */
  private advance(auto: boolean) {
    const next = this.pickNext();
    if (next === -1) {
      // End of list without repeat: stop on the last track like a deck would.
      this.status = 'stopped';
      this.setAnchor(0);
      this.emit('status', 'tick');
      return;
    }
    this.goto(next, auto ? 'playing' : this.status);
  }

  private pickNext(): number {
    const n = this.tracks.length;
    if (n === 0) return -1;
    if (this.shuffle) {
      if (n === 1) return this.repeat ? 0 : -1;
      let r = this.index;
      while (r === this.index) r = Math.floor(Math.random() * n);
      return r;
    }
    if (this.index + 1 < n) return this.index + 1;
    return this.repeat ? 0 : -1;
  }

  private goto(i: number, status: PlaybackStatus, pushHistory = true) {
    if (pushHistory && i !== this.index) {
      this.history.push(this.index);
      if (this.history.length > 200) this.history.shift();
    }
    this.index = i;
    this.status = status === 'paused' ? 'stopped' : status;
    this.setAnchor(0);
    this.loadSynth();
    this.emit('track', 'status', 'tick');
  }

  // ---- commands ------------------------------------------------------------

  async play() {
    if (!this.current()) return;
    if (this.status === 'playing') {
      // Like the classic deck: PLAY while playing restarts the track.
      this.setAnchor(0);
      this.emit('tick');
      return;
    }
    const pos = this.status === 'paused' ? this.anchorPos : 0;
    this.status = 'playing';
    this.setAnchor(pos);
    this.emit('status', 'tick');
  }

  async pause() {
    if (this.status === 'playing') {
      this.setAnchor(this.getPosition());
      this.status = 'paused';
      this.emit('status', 'tick');
    } else if (this.status === 'paused') {
      this.status = 'playing';
      this.setAnchor(this.anchorPos);
      this.emit('status', 'tick');
    }
  }

  async togglePause() {
    if (this.status === 'playing') this.pause();
    else this.play();
  }

  async stop() {
    if (this.status === 'stopped' && this.anchorPos === 0) return;
    this.status = 'stopped';
    this.setAnchor(0);
    this.emit('status', 'tick');
  }

  async next() {
    const n = this.pickNext();
    const target = n === -1 ? 0 : n;
    this.goto(target, this.status);
  }

  async prev() {
    if (this.getPosition() > PREV_RESTART_THRESHOLD && this.status === 'playing') {
      this.setAnchor(0);
      this.emit('tick');
      return;
    }
    const n = this.tracks.length;
    if (n === 0) return;
    let target: number;
    if (this.shuffle && this.history.length) target = this.history.pop()!;
    else target = this.index > 0 ? this.index - 1 : this.repeat ? n - 1 : 0;
    this.goto(target, this.status, false);
  }

  async seek(seconds: number) {
    const d = this.current()?.duration ?? 0;
    const pos = Math.max(0, Math.min(d - 0.05, seconds));
    if (this.status === 'stopped') {
      // Seeking a stopped deck starts it at that point.
      this.status = 'playing';
      this.setAnchor(pos);
      this.emit('status', 'tick');
      return;
    }
    this.setAnchor(pos);
    this.emit('tick');
  }

  async playIndex(index: number) {
    if (index < 0 || index >= this.tracks.length) return;
    this.goto(index, 'playing');
  }

  async setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.emit('settings');
  }

  async setBalance(b: number) {
    this.balance = Math.max(-1, Math.min(1, b));
    this.emit('settings');
  }

  async setShuffle(on: boolean) {
    this.shuffle = on;
    this.emit('settings');
  }

  async setRepeat(on: boolean) {
    this.repeat = on;
    this.emit('settings');
  }

  readSpectrum(out: Float32Array): boolean {
    if (this.status !== 'playing') {
      out.fill(0);
      return false;
    }
    this.synth.compute(this.getPosition(), this.synthBuf);
    resampleSpectrum(this.synthBuf, out);
    return true;
  }

  readWaveform(out: Float32Array): boolean {
    if (this.status !== 'playing') {
      out.fill(0);
      return false;
    }
    this.synth.waveform(this.getPosition(), out);
    return true;
  }

  dispose() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.listeners.clear();
    this.noticeListeners.clear();
  }
}
