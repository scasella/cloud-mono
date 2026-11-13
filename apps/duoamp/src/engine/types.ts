/**
 * The only surface the UI talks to. Implementations: MockEngine (silent demo),
 * the Spotify engines (src/spotify), and SwitchableEngine, which the app holds
 * and which forwards to whichever of those is active. Nothing in src/ui may
 * import a concrete engine.
 */

export interface Track {
  /** Stable key within a list (a URI for streaming services). */
  id: string;
  /** Service URI used to start playback, when the source has one. */
  uri?: string;
  artist: string;
  title: string;
  album?: string;
  /** Seconds. */
  duration: number;
  /** Stream info shown in the KBPS / KHZ boxes; services may not expose these. */
  kbps?: number;
  khz?: number;
  channels?: 1 | 2;
  /** Cover art URL, shown unmodified in the visualiser's ART mode. */
  artUrl?: string;
  /** Link back to the item on the service (attribution). */
  externalUrl?: string;
}

export type PlaybackStatus = 'playing' | 'paused' | 'stopped';

/** What the active engine can actually do. The UI adapts instead of failing silently. */
export interface Capabilities {
  /** Volume can be changed from here (false e.g. on iOS, or a remote device without volume control). */
  volume: boolean;
  balance: boolean;
  seek: boolean;
  /** Audio plays in this browser (false when remote-controlling another device). */
  inBrowserAudio: boolean;
  /** Audio can only start from a user gesture; call PlayerEngine.userGesture() inside one. */
  needsGesture: boolean;
  /** KBPS / KHZ / channel readouts are real data. */
  streamInfo: boolean;
}

/** Commands the current playback state does not allow; the UI disables them and engines ignore them. */
export interface Disallows {
  pause: boolean;
  resume: boolean;
  seek: boolean;
  next: boolean;
  prev: boolean;
  shuffle: boolean;
  repeat: boolean;
}

export const NO_DISALLOWS: Disallows = Object.freeze({
  pause: false, resume: false, seek: false, next: false, prev: false, shuffle: false, repeat: false,
});

export interface PlayerState {
  readonly tracks: readonly Track[];
  /** Index into tracks of the current track; -1 when the list is empty or the current track is not in it. */
  readonly index: number;
  /** The track being played, even when it is not in `tracks` (e.g. started elsewhere). */
  readonly current: Track | null;
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
  /** Short service/attribution label for the footer ("SPOTIFY"); empty for the demo. */
  readonly serviceLabel: string;
  /** True while the list is still being fetched (it may grow). */
  readonly loading: boolean;
  readonly capabilities: Capabilities;
  readonly disallows: Disallows;
}

/** What changed, so listeners can skip work. 'tick' = position only. */
export type ChangeKind = 'tick' | 'status' | 'track' | 'tracks' | 'settings' | 'caps';

export type Listener = (state: PlayerState, kinds: ReadonlySet<ChangeKind>) => void;

export interface EngineNotice {
  level: 'info' | 'warn' | 'error';
  /** Short upper-case text for the marquee. */
  text: string;
  /** Machine-readable code for diagnostics/tests, e.g. 'volume_unsupported', 'no_active_device'. */
  code?: string;
}

export type NoticeListener = (n: EngineNotice) => void;

export interface PlayerEngine {
  getState(): PlayerState;
  /** Live playback position in seconds, interpolated; cheap to call every frame. */
  getPosition(): number;
  subscribe(listener: Listener): () => void;
  /** Transient messages (errors, unsupported actions) for the marquee. */
  subscribeNotices(listener: NoticeListener): () => void;

  /**
   * Called synchronously from inside user-gesture handlers (pointerup, keydown).
   * Engines that need a gesture to unlock audio do it here; must be cheap.
   */
  userGesture(): void;

  // Commands resolve when the engine has applied them (optimistically) and sent
  // them on; failures are reported through notices, never thrown.
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Pause if playing, otherwise play. */
  togglePause(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  /** Seconds. Clamped to the track. */
  seek(seconds: number): Promise<void>;
  playIndex(index: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  setBalance(b: number): Promise<void>;
  setShuffle(on: boolean): Promise<void>;
  setRepeat(on: boolean): Promise<void>;

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
