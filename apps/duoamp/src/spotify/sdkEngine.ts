import type { Capabilities } from '../engine/types';
import type { SpotifyApi } from './api';
import type { SpotifyAuth } from './auth';
import { DEVICE_NAME, SDK_URL } from './config';
import { diag } from './diag';
import { SpotifyEngineBase, type PlayRequest } from './engineBase';
import { parseSdkState, type RepeatMode } from './parse';

/** Minimal typing of the Web Playback SDK surface we use. */
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(ev: string, cb: (arg: unknown) => void): boolean;
  removeListener(ev: string, cb?: (arg: unknown) => void): boolean;
  getCurrentState(): Promise<unknown>;
  setName(n: string): Promise<void>;
  getVolume(): Promise<number>;
  setVolume(v: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  togglePlay(): Promise<void>;
  seek(ms: number): Promise<void>;
  previousTrack(): Promise<void>;
  nextTrack(): Promise<void>;
  activateElement(): Promise<void>;
}

interface SdkGlobal {
  Player: new (o: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number; enableMediaSession?: boolean }) => SdkPlayer;
}

declare global {
  interface Window {
    Spotify?: SdkGlobal;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export type SdkFailure = 'script_load_failed' | 'initialization_error' | 'account_error' | 'authentication_error' | 'autoplay_failed' | 'timeout' | 'connect_failed';

export class SdkStartError extends Error {
  constructor(public reason: SdkFailure, message: string) {
    super(message);
  }
}

let sdkLoad: Promise<SdkGlobal> | null = null;

/** Load https://sdk.scdn.co/spotify-player.js once; onSpotifyWebPlaybackSDKReady is defined first. */
export function loadSdk(timeoutMs = 15000): Promise<SdkGlobal> {
  if (window.Spotify?.Player) return Promise.resolve(window.Spotify);
  if (sdkLoad) return sdkLoad;
  sdkLoad = new Promise<SdkGlobal>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SdkStartError('timeout', 'SDK script timed out')), timeoutMs);
    window.onSpotifyWebPlaybackSDKReady = () => {
      clearTimeout(timer);
      if (window.Spotify?.Player) resolve(window.Spotify);
      else reject(new SdkStartError('script_load_failed', 'SDK ready without Spotify.Player'));
    };
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => {
      clearTimeout(timer);
      reject(new SdkStartError('script_load_failed', 'SDK script failed to load'));
    };
    document.head.append(s);
  }).catch((e) => {
    sdkLoad = null;
    throw e;
  });
  return sdkLoad;
}

export interface SdkHooks {
  /** In-browser playback cannot work (after start): the service falls back to Connect. */
  onFatal(reason: SdkFailure, message: string): void;
  onDevice(): void;
}

/** Autoplay failures (playback arrived paused for want of a gesture) before falling back. */
const AUTOPLAY_FAILS_BEFORE_FALLBACK = 2;
const RESYNC_MS = 5000;

/** Heuristic: iOS / iPadOS WebKit, where the SDK cannot set volume. Confirmed by a probe after ready. */
function looksLikeIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** This browser is the Spotify Connect device ("DuoAmp"). */
export class SdkEngine extends SpotifyEngineBase {
  readonly mode = 'sdk' as const;
  private player: SdkPlayer | null = null;
  deviceId: string | null = null;
  ready = false;
  private autoplayFails = 0;
  /** activateElement() succeeded inside a gesture and audio has played since. */
  private unlocked = false;
  private lastActivate = 0;
  private resync: number | undefined;
  private authRetries = 0;
  sdkEvents: string[] = [];

  constructor(api: SpotifyApi, private auth: SpotifyAuth, private hooks: SdkHooks, opts: { volume: number }) {
    super(api, {
      volume: opts.volume,
      caps: { volume: !looksLikeIos(), balance: false, seek: true, inBrowserAudio: true, needsGesture: true, streamInfo: false } satisfies Capabilities,
    });
  }

  private ev(name: string, detail = '') {
    this.sdkEvents.push(name);
    diag.info('sdk', `${name}${detail ? ' ' + detail : ''}`);
  }

  /** Load the SDK, connect, and wait for `ready`. Rejects with SdkStartError. */
  async start(): Promise<void> {
    const Spotify = await loadSdk();
    if (this.disposed) return;
    this.ev('script loaded');
    const player = new Spotify.Player({
      name: DEVICE_NAME,
      getOAuthToken: (cb) => {
        this.auth.getAccessToken().then(cb, () => cb(''));
      },
      volume: this.volume,
      enableMediaSession: true,
    });
    this.player = player;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: SdkStartError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => done(new SdkStartError('timeout', 'SDK did not become ready')), 20000);
      player.addListener('ready', (a) => {
        this.deviceId = (a as { device_id?: string })?.device_id ?? null;
        this.ready = true;
        this.ev('ready', `device ${this.deviceId?.slice(0, 8) ?? '?'}...`);
        this.hooks.onDevice();
        void this.probeVolume();
        done();
      });
      player.addListener('not_ready', () => {
        this.ready = false;
        this.ev('not_ready');
        this.notice({ level: 'warn', text: 'SPOTIFY PLAYER WENT OFFLINE, RECONNECTING...', code: 'sdk_not_ready' });
        this.hooks.onDevice();
      });
      player.addListener('player_state_changed', (s) => {
        if (s === null && this.remote) this.notice({ level: 'info', text: 'PLAYBACK MOVED TO ANOTHER DEVICE', code: 'sdk_inactive' });
        const st = parseSdkState(s);
        if (st && !st.paused) {
          this.unlocked = true;
          this.autoplayFails = 0;
        }
        this.applyRemote(st);
      });
      player.addListener('autoplay_failed', () => {
        this.autoplayFails++;
        this.ev('autoplay_failed', `#${this.autoplayFails}`);
        this.unlocked = false;
        if (this.autoplayFails >= AUTOPLAY_FAILS_BEFORE_FALLBACK) {
          this.hooks.onFatal('autoplay_failed', 'THIS BROWSER BLOCKED AUDIO; SWITCHING TO REMOTE CONTROL');
        } else {
          this.notice({ level: 'warn', text: 'TAP PLAY TO START AUDIO', code: 'autoplay_failed' });
          void this.refreshState();
        }
      });
      player.addListener('initialization_error', (e) => {
        const m = (e as { message?: string })?.message ?? '';
        this.ev('initialization_error', m);
        const err = new SdkStartError('initialization_error', m || 'initialization error');
        if (settled) this.hooks.onFatal('initialization_error', 'IN-BROWSER PLAYBACK UNAVAILABLE HERE');
        done(err);
      });
      player.addListener('authentication_error', (e) => {
        const m = (e as { message?: string })?.message ?? '';
        this.ev('authentication_error', m);
        if (this.authRetries++ < 1) {
          this.auth.refresh().then(
            () => {
              player.disconnect();
              void player.connect();
            },
            () => undefined,
          );
        } else {
          this.notice({ level: 'error', text: 'SPOTIFY REJECTED THE SIGN-IN FOR PLAYBACK', code: 'authentication_error' });
          if (!settled) done(new SdkStartError('authentication_error', m));
        }
      });
      player.addListener('account_error', (e) => {
        const m = (e as { message?: string })?.message ?? '';
        this.ev('account_error', m);
        this.notice({ level: 'error', text: 'SPOTIFY PREMIUM IS NEEDED TO PLAY MUSIC HERE', code: 'account_error' });
        if (settled) this.hooks.onFatal('account_error', 'SPOTIFY PREMIUM IS NEEDED TO PLAY MUSIC HERE');
        done(new SdkStartError('account_error', m));
      });
      player.addListener('playback_error', (e) => {
        const m = (e as { message?: string })?.message ?? '';
        this.ev('playback_error', m);
        this.notice({ level: 'error', text: 'SPOTIFY COULD NOT PLAY THIS TRACK', code: 'playback_error' });
      });
      player.connect().then((ok) => {
        this.ev('connect()', String(ok));
        if (!ok) done(new SdkStartError('connect_failed', 'connect() returned false'));
      }, () => done(new SdkStartError('connect_failed', 'connect() rejected')));
    });

    this.resync = window.setInterval(() => {
      if (!document.hidden && this.ready) void this.refreshState();
    }, RESYNC_MS);
  }

  /** setVolume is a no-op on iOS (getVolume stays 1): find out for real. */
  private async probeVolume() {
    const p = this.player;
    if (!p) return;
    try {
      const target = Math.min(0.99, Math.max(0.05, this.volume));
      await p.setVolume(target);
      const got = await p.getVolume();
      const works = Math.abs(got - target) < 0.02;
      diag.info('sdk', `volume probe: set ${target.toFixed(2)} got ${Number(got).toFixed(2)} -> ${works ? 'controllable' : 'fixed'}`);
      this.setCaps({ volume: works });
    } catch {
      /* keep heuristic */
    }
  }

  /** Must run synchronously inside the gesture: iOS only unlocks audio from a tap. */
  override userGesture() {
    const p = this.player;
    if (!p || this.unlocked) return;
    const now = performance.now();
    if (now - this.lastActivate < 400) return;
    this.lastActivate = now;
    try {
      p.activateElement().catch(() => undefined);
      diag.info('sdk', 'activateElement() in gesture');
    } catch {
      /* older SDK without activateElement */
    }
  }

  async refreshState() {
    if (!this.player) return;
    const s = await this.player.getCurrentState().catch(() => null);
    this.applyRemote(parseSdkState(s));
  }

  protected hasActivePlayback() {
    return this.remote !== null;
  }

  private need(): SdkPlayer {
    if (!this.player || !this.deviceId) throw new Error('SDK player not ready');
    return this.player;
  }

  protected async tPlay(req: PlayRequest | null) {
    this.need();
    if (!req && this.remote) return this.player!.resume();
    // Starting from here also transfers playback to this browser.
    await this.api.put('/me/player/play', { query: { device_id: this.deviceId }, body: req ?? undefined });
  }
  protected async tPause() {
    if (this.remote) await this.need().pause();
  }
  protected async tNext() {
    if (this.remote) await this.need().nextTrack();
  }
  protected async tPrev() {
    if (this.remote) await this.need().previousTrack();
  }
  protected async tSeek(ms: number) {
    if (this.remote) await this.need().seek(ms);
  }
  protected async tVolume(v: number) {
    await this.need().setVolume(v);
  }
  protected async tShuffle(on: boolean) {
    await this.api.put('/me/player/shuffle', { query: { state: on, device_id: this.deviceId } });
  }
  protected async tRepeat(mode: RepeatMode) {
    await this.api.put('/me/player/repeat', { query: { state: mode, device_id: this.deviceId } });
  }

  describe() {
    return {
      mode: 'IN-BROWSER (WEB PLAYBACK SDK)',
      sdk: this.ready ? 'READY' : this.player ? 'NOT READY' : 'NOT LOADED',
      device: this.deviceId ? `${this.deviceId.slice(0, 10)}... (${DEVICE_NAME})` : '-',
      active: this.remote ? 'YES' : 'NO',
      volume: this.caps.volume ? 'CONTROLLABLE' : 'FIXED (DEVICE BUTTONS)',
      audioUnlocked: this.unlocked ? 'YES' : 'NO',
      autoplayFailures: String(this.autoplayFails),
    };
  }

  override dispose() {
    super.dispose();
    if (this.resync !== undefined) clearInterval(this.resync);
    try {
      this.player?.disconnect();
    } catch {
      /* ignore */
    }
    this.player = null;
  }
}
