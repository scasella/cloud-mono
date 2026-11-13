import { SpectrumSynth, SYNTH_BANDS, resampleSpectrum } from '../engine/spectrum';
import {
  NO_DISALLOWS,
  type Capabilities,
  type ChangeKind,
  type Disallows,
  type EngineNotice,
  type Listener,
  type NoticeListener,
  type PlaybackStatus,
  type PlayerEngine,
  type PlayerState,
  type Track,
} from '../engine/types';
import { SpotifyApiError, type SpotifyApi } from './api';
import { diag } from './diag';
import type { RemoteState, RepeatMode } from './parse';

export type EngineMode = 'sdk' | 'connect';

export interface SourceInfo {
  kind: 'playlist' | 'liked';
  /** Playlist id, or 'liked'. */
  id: string;
  name: string;
  /** Context to start playback in (playlists); null for Liked Songs (URI list). */
  contextUri: string | null;
  externalUrl?: string;
  snapshotId?: string;
}

export interface PlayRequest {
  context_uri?: string;
  uris?: string[];
  offset?: { position: number } | { uri: string };
  position_ms?: number;
}

/** How long an optimistic value wins over contradicting remote state. */
const HOLD_MS = 3500;
/** Liked Songs have no usable context; playback gets this many URIs from the tapped row on. */
export const URI_WINDOW = 100;
const PREV_RESTART_S = 3;
const TICK_MS = 500;

type HoldKey = 'status' | 'track' | 'position' | 'shuffle' | 'repeat';

const norm = (s: string) => s.toLowerCase().replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Shared Spotify engine: track list + source, interpolated position, optimistic
 * commands with reconciliation from real state, one serial command queue
 * (Spotify may apply concurrent player commands out of order), synthesised
 * spectrum seeded per track. Subclasses provide the transport (SDK or Connect).
 */
export abstract class SpotifyEngineBase implements PlayerEngine {
  abstract readonly mode: EngineMode;

  protected tracks: Track[] = [];
  /** Playlist position of each loaded track (entries we skipped still count). */
  protected positions: number[] = [];
  private uriIndex = new Map<string, number[]>();
  protected source: SourceInfo | null = null;
  protected loading = false;

  protected remote: RemoteState | null = null;
  protected current: Track | null = null;
  protected index = -1;
  protected status: PlaybackStatus = 'stopped';
  private anchorPos = 0;
  private anchorTime = performance.now();
  protected durationS = 0;
  protected volume: number;
  protected shuffle = false;
  protected repeatMode: RepeatMode = 'off';
  protected caps: Capabilities;
  protected disallows: Disallows = NO_DISALLOWS;
  /** STOP pressed: show stopped while Spotify reports paused at the start. */
  private stoppedLocal = false;
  /** Index the user asked for, to disambiguate duplicates in the list. */
  private requestedIndex = -1;

  private holds = new Map<HoldKey, { value: unknown; until: number }>();
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<Listener>();
  private noticeListeners = new Set<NoticeListener>();
  private synth = new SpectrumSynth();
  private synthBuf = new Float32Array(SYNTH_BANDS);
  private synthKey = '';
  private ticker: number;
  private volTimer: number | undefined;
  private pendingVolume: number | null = null;
  protected disposed = false;
  lastNotice: EngineNotice | null = null;

  constructor(protected api: SpotifyApi, opts: { volume: number; caps: Capabilities }) {
    this.volume = opts.volume;
    this.caps = opts.caps;
    this.ticker = window.setInterval(() => {
      if (this.status === 'playing') this.emit('tick');
    }, TICK_MS);
  }

  // ---- transport (subclasses) ---------------------------------------------

  protected abstract tPlay(req: PlayRequest | null): Promise<void>;
  protected abstract tPause(): Promise<void>;
  protected abstract tNext(): Promise<void>;
  protected abstract tPrev(): Promise<void>;
  protected abstract tSeek(ms: number): Promise<void>;
  protected abstract tVolume(v: number): Promise<void>;
  protected abstract tShuffle(on: boolean): Promise<void>;
  protected abstract tRepeat(mode: RepeatMode): Promise<void>;
  /** Fetch real state now and apply it. */
  abstract refreshState(): Promise<void>;
  /** Is there playback on the device we control (so resume/pause apply)? */
  protected abstract hasActivePlayback(): boolean;
  abstract describe(): Record<string, string>;
  userGesture() {}

  // ---- state ----------------------------------------------------------------

  getPosition(): number {
    if (this.status !== 'playing') return this.anchorPos;
    const p = this.anchorPos + (performance.now() - this.anchorTime) / 1000;
    return this.durationS > 0 ? Math.min(this.durationS, p) : p;
  }

  getState(): PlayerState {
    return {
      tracks: this.tracks,
      index: this.index,
      current: this.current,
      status: this.status,
      position: this.getPosition(),
      duration: this.durationS,
      volume: this.volume,
      balance: 0,
      shuffle: this.shuffle,
      repeat: this.repeatMode !== 'off',
      sourceLabel: this.source?.name ?? 'NO PLAYLIST LOADED',
      serviceLabel: 'SPOTIFY',
      loading: this.loading,
      capabilities: this.caps,
      disallows: this.disallows,
    };
  }

  getSource() {
    return this.source;
  }

  getPositions(): readonly number[] {
    return this.positions;
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  subscribeNotices(l: NoticeListener) {
    this.noticeListeners.add(l);
    return () => this.noticeListeners.delete(l);
  }

  protected emit(...kinds: ChangeKind[]) {
    if (this.disposed) return;
    const set = new Set(kinds);
    const s = this.getState();
    for (const l of this.listeners) l(s, set);
  }

  notice(n: EngineNotice) {
    this.lastNotice = n;
    diag.add('engine', n.level, `${n.code ?? 'notice'}: ${n.text}`);
    for (const l of this.noticeListeners) l(n);
  }

  private setAnchor(pos: number, at = performance.now()) {
    this.anchorPos = Math.max(0, pos);
    this.anchorTime = at;
  }

  private hold(k: HoldKey, value: unknown) {
    this.holds.set(k, { value, until: performance.now() + HOLD_MS });
  }

  private held(k: HoldKey): { value: unknown } | null {
    const h = this.holds.get(k);
    if (!h) return null;
    if (performance.now() > h.until) {
      this.holds.delete(k);
      return null;
    }
    return h;
  }

  /** Forget optimistic values so the next real state wins (e.g. playback was blocked). */
  protected clearHolds() {
    this.holds.clear();
  }

  protected setCaps(c: Partial<Capabilities>) {
    const next = { ...this.caps, ...c };
    if (JSON.stringify(next) === JSON.stringify(this.caps)) return;
    this.caps = next;
    this.emit('caps', 'settings');
  }

  // ---- track list -----------------------------------------------------------

  /** Replace the list (new source). `positions[i]` = playlist position of tracks[i]. */
  setTracks(source: SourceInfo | null, tracks: Track[], positions: number[], loading: boolean) {
    this.source = source;
    this.tracks = tracks.slice();
    this.positions = positions.slice();
    this.loading = loading;
    this.reindex();
    this.index = this.matchIndex(this.remote);
    this.emit('tracks', 'track');
  }

  /** Append a page while a long list streams in. */
  appendTracks(tracks: Track[], positions: number[], loading: boolean) {
    const start = this.tracks.length;
    this.tracks = this.tracks.concat(tracks);
    this.positions = this.positions.concat(positions);
    this.loading = loading;
    tracks.forEach((t, i) => this.addIndex(t, start + i));
    const before = this.index;
    if (this.index < 0) this.index = this.matchIndex(this.remote);
    this.emit(...(this.index !== before ? (['tracks', 'track'] as const) : (['tracks'] as const)));
  }

  setLoading(loading: boolean) {
    if (this.loading === loading) return;
    this.loading = loading;
    this.emit('tracks');
  }

  private reindex() {
    this.uriIndex.clear();
    this.tracks.forEach((t, i) => this.addIndex(t, i));
  }

  private addIndex(t: Track, i: number) {
    if (!t.uri) return;
    const a = this.uriIndex.get(t.uri);
    if (a) a.push(i);
    else this.uriIndex.set(t.uri, [i]);
  }

  /**
   * Row for the remote track: by URI (own, then linked_from), preferring the
   * row the user tapped when the URI occurs more than once; then, when playing
   * from the loaded context, by normalised title + artist + duration (catches
   * relinked tracks whose original URI Spotify no longer reports).
   */
  private matchIndex(r: RemoteState | null): number {
    if (!r?.track) return -1;
    for (const uri of r.uris) {
      const rows = this.uriIndex.get(uri);
      if (!rows) continue;
      if (rows.includes(this.requestedIndex)) return this.requestedIndex;
      if (rows.includes(this.index)) return this.index;
      // Next occurrence after the previous row, else the first.
      return rows.find((i) => i > this.index) ?? rows[0];
    }
    const fromContext = !!this.source && (this.source.contextUri ? r.contextUri === this.source.contextUri : !r.contextUri || r.contextUri.includes('collection'));
    if (!fromContext) return -1;
    const title = norm(r.track.title);
    const artist = norm(r.track.artist.split(',')[0] ?? '');
    const hits: number[] = [];
    this.tracks.forEach((t, i) => {
      if (norm(t.title) === title && norm(t.artist.split(',')[0] ?? '') === artist && Math.abs(t.duration - r.durationMs / 1000) < 3) hits.push(i);
    });
    if (hits.includes(this.requestedIndex)) return this.requestedIndex;
    return hits.length ? hits[0] : -1;
  }

  // ---- reconciliation -------------------------------------------------------

  /** Apply real state (from the SDK event or a poll). null = nothing playing on our device. */
  protected applyRemote(r: RemoteState | null) {
    if (this.disposed) return;
    const kinds = new Set<ChangeKind>();
    const prevRemote = this.remote;
    this.remote = r;
    if (!r) {
      if (this.status === 'playing' && !this.held('status')) {
        this.setAnchor(this.getPosition());
        this.status = 'paused';
        kinds.add('status');
      }
      if (this.disallows !== NO_DISALLOWS) {
        this.disallows = NO_DISALLOWS;
        kinds.add('caps');
      }
      if (kinds.size) this.emitSet(kinds);
      return;
    }

    // Track
    const heldTrack = this.held('track');
    const trackAgrees = !heldTrack || r.uris.includes(heldTrack.value as string);
    if (heldTrack && trackAgrees) this.holds.delete('track');
    if (trackAgrees) {
      const prevUri = this.current?.uri;
      const newUri = r.track?.uri;
      if (r.track && (newUri !== prevUri || !this.current)) {
        this.current = r.track;
        kinds.add('track');
      } else if (r.track && this.current && r.track.artUrl && !this.current.artUrl) {
        this.current = { ...this.current, artUrl: r.track.artUrl };
        kinds.add('track');
      }
      if (!r.track && this.current && prevRemote?.track) {
        this.current = null;
        kinds.add('track');
      }
      const idx = this.matchIndex(r);
      if (idx !== this.index) {
        this.index = idx;
        kinds.add('track');
      }
      if (newUri !== prevUri) this.requestedIndex = idx >= 0 ? idx : this.requestedIndex;
      const dur = r.durationMs / 1000 || r.track?.duration || 0;
      if (dur !== this.durationS) {
        this.durationS = dur;
        kinds.add('track');
      }
    }

    // Status
    const remoteStatus: PlaybackStatus = r.paused ? (this.stoppedLocal && r.positionMs < 1500 ? 'stopped' : 'paused') : 'playing';
    if (!r.paused) this.stoppedLocal = false;
    const heldStatus = this.held('status');
    if (heldStatus && (heldStatus.value === remoteStatus || (heldStatus.value === 'stopped' && remoteStatus === 'paused'))) this.holds.delete('status');
    if (!this.held('status') && trackAgrees && remoteStatus !== this.status) {
      this.status = remoteStatus;
      kinds.add('status');
    }

    // Position (re-anchor unless an optimistic seek / track start is still pending)
    if (trackAgrees) {
      const heldPos = this.held('position');
      const remotePos = r.positionMs / 1000 + (r.paused ? 0 : (performance.now() - r.sampledAt) / 1000);
      if (heldPos && Math.abs(remotePos - (heldPos.value as number)) < 3) this.holds.delete('position');
      if (!this.held('position')) {
        if (Math.abs(remotePos - this.getPosition()) > 0.25 || kinds.has('status') || kinds.has('track')) kinds.add('tick');
        this.setAnchor(this.status === 'stopped' ? 0 : r.positionMs / 1000, r.sampledAt);
      }
    }

    // Shuffle / repeat
    const hs = this.held('shuffle');
    if (hs && hs.value === r.shuffle) this.holds.delete('shuffle');
    if (!this.held('shuffle') && r.shuffle !== this.shuffle) {
      this.shuffle = r.shuffle;
      kinds.add('settings');
    }
    const hr = this.held('repeat');
    if (hr && (hr.value === r.repeat || (hr.value !== 'off' && r.repeat !== 'off'))) this.holds.delete('repeat');
    if (!this.held('repeat') && r.repeat !== this.repeatMode) {
      this.repeatMode = r.repeat;
      kinds.add('settings');
    }

    const d: Disallows = {
      pause: !!r.disallows.pause,
      resume: !!r.disallows.resume,
      seek: !!r.disallows.seek,
      next: !!r.disallows.next,
      prev: !!r.disallows.prev,
      shuffle: !!r.disallows.shuffle,
      repeat: !!r.disallows.repeat,
    };
    if (JSON.stringify(d) !== JSON.stringify(this.disallows)) {
      this.disallows = Object.values(d).some(Boolean) ? d : NO_DISALLOWS;
      kinds.add('caps');
    }
    if (kinds.size) this.emitSet(kinds);
  }

  private emitSet(kinds: Set<ChangeKind>) {
    this.emit(...kinds);
  }

  // ---- command plumbing -----------------------------------------------------

  /** Run a transport call after all earlier ones; errors become notices + a resync. */
  protected run(label: string, fn: () => Promise<void>): Promise<void> {
    const p = this.queue.then(async () => {
      if (this.disposed) return;
      try {
        await fn();
        diag.info('engine', `${this.mode} ${label} ok`);
      } catch (e) {
        this.onCommandError(label, e);
      }
    });
    this.queue = p;
    return p;
  }

  protected onCommandError(label: string, e: unknown) {
    this.holds.clear();
    if (e instanceof SpotifyApiError) {
      this.notice({ level: 'error', text: e.message, code: e.kind });
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      diag.error('engine', `${this.mode} ${label} failed: ${msg}`);
      this.notice({ level: 'error', text: 'SPOTIFY COMMAND FAILED', code: 'command_failed' });
    }
    // Put the real state back on screen.
    void this.refreshState().catch(() => undefined);
  }

  private refuse(what: string) {
    this.notice({ level: 'warn', text: `${what}: NOT ALLOWED RIGHT NOW`, code: 'disallowed' });
    return Promise.resolve();
  }

  // ---- commands -------------------------------------------------------------

  async play() {
    if (this.status === 'playing') {
      // Like the classic deck: PLAY while playing restarts the track.
      return this.seek(0);
    }
    if (this.disallows.resume && this.hasActivePlayback()) return this.refuse('PLAY');
    if (!this.hasActivePlayback() && this.tracks.length) {
      return this.playIndex(this.index >= 0 ? this.index : 0);
    }
    const from = this.status === 'stopped' ? 0 : this.anchorPos;
    const wasStopped = this.status === 'stopped' && this.stoppedLocal;
    this.stoppedLocal = false;
    this.status = 'playing';
    this.setAnchor(from);
    this.hold('status', 'playing');
    this.emit('status', 'tick');
    return this.run('resume', async () => {
      if (wasStopped) await this.tSeek(0);
      await this.tPlay(null);
    });
  }

  async pause() {
    if (this.status === 'paused') return this.play();
    if (this.status !== 'playing') return;
    if (this.disallows.pause) return this.refuse('PAUSE');
    this.setAnchor(this.getPosition());
    this.status = 'paused';
    this.hold('status', 'paused');
    this.emit('status', 'tick');
    return this.run('pause', () => this.tPause());
  }

  async togglePause() {
    return this.status === 'playing' ? this.pause() : this.play();
  }

  async stop() {
    if (this.status === 'stopped') return;
    const wasPlaying = this.status === 'playing';
    this.stoppedLocal = true;
    this.status = 'stopped';
    this.setAnchor(0);
    this.hold('status', 'stopped');
    this.hold('position', 0);
    this.emit('status', 'tick');
    return this.run('stop', async () => {
      if (wasPlaying) await this.tPause();
      if (this.caps.seek) await this.tSeek(0);
    });
  }

  async next() {
    if (this.disallows.next) return this.refuse('NEXT');
    if (!this.shuffle && this.index >= 0 && this.index + 1 < this.tracks.length) this.optimisticTrack(this.index + 1);
    else this.optimisticRestart();
    return this.run('next', () => this.tNext());
  }

  async prev() {
    if (this.getPosition() > PREV_RESTART_S && this.status === 'playing') {
      // Spotify restarts the track too; keep the row.
      this.optimisticRestart();
    } else {
      if (this.disallows.prev) return this.refuse('PREVIOUS');
      if (!this.shuffle && this.index > 0) this.optimisticTrack(this.index - 1);
      else this.optimisticRestart();
    }
    return this.run('prev', () => this.tPrev());
  }

  private optimisticRestart() {
    this.setAnchor(0);
    this.hold('position', 0);
    this.emit('tick');
  }

  private optimisticTrack(i: number) {
    const t = this.tracks[i];
    if (!t) return;
    this.index = i;
    this.requestedIndex = i;
    this.current = t;
    this.durationS = t.duration;
    if (this.status === 'stopped') this.status = 'paused';
    this.setAnchor(0);
    if (t.uri) this.hold('track', t.uri);
    this.hold('position', 0);
    this.emit('track', 'status', 'tick');
  }

  async seek(seconds: number) {
    if (!this.caps.seek || (this.disallows.seek && this.hasActivePlayback())) return this.refuse('SEEK');
    if (!this.current) return;
    const pos = Math.max(0, Math.min(Math.max(0, this.durationS - 0.5), seconds));
    this.setAnchor(pos);
    this.hold('position', pos);
    this.emit('tick');
    return this.run('seek', () => this.tSeek(Math.round(pos * 1000)));
  }

  async playIndex(index: number) {
    const t = this.tracks[index];
    if (!t?.uri) return;
    const src = this.source;
    let req: PlayRequest;
    if (src?.contextUri) {
      const dupes = (this.uriIndex.get(t.uri)?.length ?? 0) > 1;
      req = { context_uri: src.contextUri, offset: dupes ? { position: this.positions[index] ?? index } : { uri: t.uri } };
    } else {
      req = { uris: this.tracks.slice(index, index + URI_WINDOW).map((x) => x.uri!).filter(Boolean) };
    }
    this.stoppedLocal = false;
    this.index = index;
    this.requestedIndex = index;
    this.current = t;
    this.durationS = t.duration;
    this.status = 'playing';
    this.setAnchor(0);
    this.hold('track', t.uri);
    this.hold('status', 'playing');
    this.hold('position', 0);
    this.emit('track', 'status', 'tick');
    return this.run(`play #${index + 1}`, () => this.tPlay(req));
  }

  async setVolume(v: number) {
    if (!this.caps.volume) {
      this.notice({
        level: 'info',
        text: this.caps.inBrowserAudio ? 'VOLUME: USE THE PHONE VOLUME BUTTONS' : 'VOLUME: NOT ADJUSTABLE ON THIS DEVICE',
        code: 'volume_unsupported',
      });
      // Let the slider snap back to the real value.
      this.emit('settings');
      return;
    }
    this.volume = Math.max(0, Math.min(1, v));
    this.emit('settings');
    // Throttled, latest value wins.
    this.pendingVolume = this.volume;
    if (this.volTimer !== undefined) return;
    this.volTimer = window.setTimeout(() => {
      this.volTimer = undefined;
      const val = this.pendingVolume;
      this.pendingVolume = null;
      if (val !== null) void this.run('volume', () => this.tVolume(val));
    }, 250);
  }

  async setBalance() {
    this.notice({ level: 'info', text: 'BALANCE: NOT AVAILABLE WITH SPOTIFY', code: 'balance_unsupported' });
    this.emit('settings');
  }

  async setShuffle(on: boolean) {
    if (this.disallows.shuffle) {
      this.emit('settings');
      return this.refuse('SHUFFLE');
    }
    this.shuffle = on;
    this.hold('shuffle', on);
    this.emit('settings');
    return this.run('shuffle', () => this.tShuffle(on));
  }

  /** Our single REP toggle = context repeat on / off. */
  async setRepeat(on: boolean) {
    if (this.disallows.repeat) {
      this.emit('settings');
      return this.refuse('REPEAT');
    }
    const mode: RepeatMode = on ? 'context' : 'off';
    this.repeatMode = mode;
    this.hold('repeat', mode);
    this.emit('settings');
    return this.run('repeat', () => this.tRepeat(mode));
  }

  // ---- visuals --------------------------------------------------------------

  private syncSynth() {
    const key = this.current?.uri ?? '';
    if (key === this.synthKey) return;
    this.synthKey = key;
    this.synth.setTrack(key || 'none', this.durationS || 200);
  }

  readSpectrum(out: Float32Array): boolean {
    if (this.status !== 'playing' || !this.current) {
      out.fill(0);
      return false;
    }
    this.syncSynth();
    this.synth.compute(this.getPosition(), this.synthBuf);
    resampleSpectrum(this.synthBuf, out);
    return true;
  }

  readWaveform(out: Float32Array): boolean {
    if (this.status !== 'playing' || !this.current) {
      out.fill(0);
      return false;
    }
    this.syncSynth();
    this.synth.waveform(this.getPosition(), out);
    return true;
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.ticker);
    if (this.volTimer !== undefined) clearTimeout(this.volTimer);
    this.listeners.clear();
    this.noticeListeners.clear();
  }
}
