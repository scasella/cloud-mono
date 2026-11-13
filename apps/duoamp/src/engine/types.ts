/**
 * The only surface the UI talks to. A later Spotify-backed engine implements
 * the same interface; nothing in src/ui may import MockEngine directly.
 */

export interface Track {
  id: string;
  artist: string;
  title: string;
  /** Seconds. */
  duration: number;
  /** Stream info shown in the KBPS / KHZ boxes; services may not expose these. */
  kbps?: number;
  khz?: number;
  channels?: 1 | 2;
}

export type PlaybackStatus = 'playing' | 'paused' | 'stopped';

export interface PlayerState {
  readonly tracks: readonly Track[];
  /** Index into tracks of the current track (-1 when the list is empty). */
  readonly index: number;
  readonly status: PlaybackStatus;
  /** Seconds into the current track, sampled when the state was produced. */
  readonly position: number;
  /** Seconds; duration of the current track (0 when none). */
  readonly duration: number;
  /** 0..1 */
  readonly volume: number;
  /** -1 (left) .. 0 .. 1 (right) */
  readonly balance: number;
  readonly shuffle: boolean;
  readonly repeat: boolean;
  /** Human label for where the tracks come from, e.g. a playlist or service name. */
  readonly sourceLabel: string;
}

/** What changed, so listeners can skip work. 'tick' = position only. */
export type ChangeKind = 'tick' | 'status' | 'track' | 'tracks' | 'settings';

export type Listener = (state: PlayerState, kinds: ReadonlySet<ChangeKind>) => void;

export interface PlayerEngine {
  getState(): PlayerState;
  /** Live playback position in seconds, interpolated; cheap to call every frame. */
  getPosition(): number;
  subscribe(listener: Listener): () => void;

  play(): void;
  pause(): void;
  /** Pause if playing, otherwise play. */
  togglePause(): void;
  stop(): void;
  next(): void;
  prev(): void;
  /** Seconds. Clamped to the track. */
  seek(seconds: number): void;
  playIndex(index: number): void;
  setVolume(v: number): void;
  setBalance(b: number): void;
  setShuffle(on: boolean): void;
  setRepeat(on: boolean): void;

  /**
   * Fill `out` with spectrum magnitudes 0..1, low to high frequency, log-spaced.
   * Real services do not expose samples, so implementations may synthesise this.
   * Returns false when silent (stopped/paused) so visualisers can fall to rest.
   */
  readSpectrum(out: Float32Array): boolean;
  /** Fill `out` with a waveform -1..1 for an oscilloscope view. */
  readWaveform(out: Float32Array): boolean;

  dispose(): void;
}
