import type { PlayerEngine, Track } from '../engine/types';
import type { SwitchableEngine } from '../engine/switchable';
import { SpotifyApi, SpotifyApiError } from './api';
import { AuthError, SpotifyAuth, takeAuthCallback, type AuthCallback } from './auth';
import { builtInClientId, getClientId, isValidClientId, redirectUri, setStoredClientId } from './config';
import { ConnectEngine } from './connectEngine';
import { diag } from './diag';
import type { SourceInfo } from './engineBase';
import { Library, type Profile } from './library';
import type { Device, PlaylistInfo } from './parse';
import { SdkEngine, SdkStartError } from './sdkEngine';
import { LAST_SOURCE_KEY, PREFERRED_DEVICE_KEY, TRACK_CACHE_KEY } from './storageKeys';

interface ListState {
  source: SourceInfo | null;
  tracks: Track[];
  positions: number[];
  loading: boolean;
}

const EMPTY_LIST: ListState = { source: null, tracks: [], positions: [], loading: false };

export type ModePref = 'auto' | 'sdk' | 'connect';
export type SpotifyEngine = SdkEngine | ConnectEngine;

const MODE_PREF_KEY = 'duoamp.spotify.mode.v1';

export interface LoadStatus {
  sourceId: string | null;
  state: 'idle' | 'loading' | 'done' | 'error';
  loaded: number;
  total: number;
  error?: string;
}

/**
 * Orchestrates Spotify: sign-in, library, engine choice (SDK first, Connect
 * fallback, or the user's manual choice), the last source, and swapping the
 * app's SwitchableEngine between the demo mock and the Spotify engine.
 */
export class SpotifyService {
  readonly auth: SpotifyAuth;
  readonly api: SpotifyApi;
  readonly library: Library;
  engine: SpotifyEngine | null = null;
  profile: Profile | null = null;
  playlists: PlaylistInfo[] | null = null;
  likedTotal: number | null = null;
  modePref: ModePref = 'auto';
  /** Why the SDK is not in use (shown in the sheet and diagnostics). */
  sdkFallbackReason: string | null = null;
  loadStatus: LoadStatus = { sourceId: null, state: 'idle', loaded: 0, total: 0 };
  /** Last sign-in problem to show in the connect sheet. */
  authMessage: string | null = null;
  busy = false;
  private listeners = new Set<() => void>();
  private loadSignal = { aborted: false };
  private startToken = 0;
  private sessionToken = 0;
  /** Required scopes the current sign-in lacks; the library sheet offers RECONNECT. */
  missingScopes: string[] = [];
  /**
   * The loaded list lives here, not in an engine: engines come and go (SDK -> Connect
   * fallback, manual switch) while a long playlist is still streaming in.
   */
  private list: ListState = EMPTY_LIST;
  private shownIn: SpotifyEngine | null = null;
  private shownCount = 0;
  private wasSignedIn: boolean;

  constructor(private proxy: SwitchableEngine, private makeDemo: () => PlayerEngine, private volume: () => number) {
    this.auth = new SpotifyAuth();
    this.api = new SpotifyApi(this.auth);
    this.library = new Library(this.api);
    try {
      const m = localStorage.getItem(MODE_PREF_KEY);
      if (m === 'sdk' || m === 'connect' || m === 'auto') this.modePref = m;
    } catch {
      /* ignore */
    }
    this.wasSignedIn = this.auth.signedIn;
    this.auth.subscribe(() => {
      const now = this.auth.signedIn;
      if (this.wasSignedIn && !now) this.onSignedOut();
      this.wasSignedIn = now;
      this.emit();
    });
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const l of this.listeners) l();
  }

  get signedIn() {
    return this.auth.signedIn;
  }

  get clientId() {
    return getClientId();
  }

  get clientIdBuiltIn() {
    return builtInClientId() !== null;
  }

  get redirectUri() {
    return redirectUri();
  }

  /** Startup: finish an OAuth return if there is one, then bring up the engine. */
  async init(cb: AuthCallback | null = takeAuthCallback()) {
    if (cb) {
      try {
        // false: a stale callback (e.g. browser Back) while already signed in; ignore it quietly.
        if (!(await this.auth.completeLogin(cb))) cb = null;
        else this.authMessage = null;
      } catch (e) {
        this.authMessage = e instanceof AuthError ? e.message : 'SIGN-IN FAILED';
        this.proxy.notify({ level: 'error', text: this.authMessage, code: e instanceof AuthError ? e.code : 'auth' });
      }
    }
    if (this.auth.signedIn) {
      this.checkScopes();
      await this.startSignedIn(!!cb);
    }
    this.emit();
  }

  private checkScopes() {
    this.missingScopes = this.auth.missingScopes();
    if (this.missingScopes.length) {
      diag.warn('auth', `granted scopes lack: ${this.missingScopes.join(' ')}`);
      this.proxy.notify({ level: 'warn', text: 'SPOTIFY: RECONNECT TO GRANT NEW PERMISSIONS (EJECT -> RECONNECT)', code: 'scopes_missing' });
    }
  }

  /** Sign in again with the same Client ID (e.g. to grant scopes added in an update). */
  reconnect() {
    const cid = getClientId();
    if (cid) void this.connect(cid);
  }

  async connect(clientId: string) {
    const id = clientId.trim();
    if (!this.clientIdBuiltIn) {
      if (!isValidClientId(id)) {
        this.authMessage = 'CLIENT ID SHOULD BE 32 LETTERS/DIGITS FROM THE DASHBOARD';
        this.emit();
        return;
      }
      setStoredClientId(id);
    }
    const cid = getClientId();
    if (!cid) return;
    try {
      await this.auth.beginLogin(cid, this.redirectUri);
    } catch (e) {
      this.authMessage = e instanceof AuthError ? e.message : 'COULD NOT START SIGN-IN';
      this.emit();
    }
  }

  /** Sign out and forget this account's data (keeps the Client ID and the mode choice). */
  disconnect() {
    for (const k of [LAST_SOURCE_KEY, TRACK_CACHE_KEY, PREFERRED_DEVICE_KEY]) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
    this.library.clearCache();
    this.auth.signOut(null);
  }

  /** Signed in -> out, for any reason (DISCONNECT, invalid_grant), with or without an engine yet. */
  private onSignedOut() {
    const reason = this.auth.lastSignOutReason;
    this.toDemo();
    if (reason) {
      this.authMessage = reason;
      this.proxy.notify({ level: 'warn', text: reason, code: 'signed_out' });
    }
  }

  private toDemo() {
    this.loadSignal.aborted = true;
    this.startToken++;
    this.sessionToken++;
    this.busy = false;
    this.missingScopes = [];
    this.list = EMPTY_LIST;
    this.shownIn = null;
    this.shownCount = 0;
    const hadEngine = this.engine !== null;
    this.engine = null;
    this.profile = null;
    this.playlists = null;
    this.likedTotal = null;
    this.loadStatus = { sourceId: null, state: 'idle', loaded: 0, total: 0 };
    if (hadEngine) {
      this.proxy.swap(this.makeDemo());
      diag.info('app', 'demo mode');
    }
  }

  /** Profile, engine, library and the last source all start at once: none waits for the SDK. */
  private async startSignedIn(fresh: boolean) {
    const token = ++this.sessionToken;
    const profile = this.library.profile().then(
      (p) => {
        if (token !== this.sessionToken) return;
        this.profile = p;
        diag.info('api', `profile loaded (${p.displayName})`);
        this.emit();
      },
      (e) => this.handleApiError(e, 'profile'),
    );
    const engine = this.startEngine();
    void this.refreshLibrary();
    const last = this.lastSource();
    if (last) void this.loadSource(last, true);
    await Promise.all([profile, engine]);
    if (token !== this.sessionToken || !this.auth.signedIn) return;
    if (fresh) this.proxy.notify({ level: 'info', text: `SPOTIFY: SIGNED IN${this.profile ? ' AS ' + this.profile.displayName.toUpperCase() : ''}`, code: 'signed_in' });
  }

  setModePref(m: ModePref) {
    this.modePref = m;
    try {
      localStorage.setItem(MODE_PREF_KEY, m);
    } catch {
      /* ignore */
    }
    this.sdkFallbackReason = null;
    void this.startEngine();
  }

  /** (Re)create the engine for the current mode preference, carrying the loaded list over. */
  async startEngine() {
    const token = ++this.startToken;
    this.busy = true;
    this.emit();
    try {
      await this.startEngineInner(token);
    } finally {
      // Only the latest start owns `busy`; a superseded one must not leave it set (or clear the newer one's).
      if (token === this.startToken) {
        this.busy = false;
        this.emit();
      }
    }
  }

  private async startEngineInner(token: number) {
    const wantSdk = this.modePref === 'sdk' || (this.modePref === 'auto' && !this.sdkFallbackReason);
    let next: SpotifyEngine | null = null;
    if (wantSdk) {
      const sdk = new SdkEngine(this.api, this.auth, {
        onFatal: (reason, msg) => this.sdkFailed(sdk, reason, msg),
        onDevice: () => this.emit(),
      }, { volume: this.volume() });
      this.install(sdk);
      try {
        await sdk.start();
        diag.info('engine', 'SDK mode ready');
        next = sdk;
      } catch (e) {
        const reason = e instanceof SdkStartError ? e.reason : 'initialization_error';
        diag.warn('engine', `SDK start failed: ${reason} ${e instanceof Error ? e.message : ''}`);
        if (token !== this.startToken) return;
        this.sdkFallbackReason = this.reasonText(reason);
        if (this.modePref === 'sdk') {
          this.proxy.notify({ level: 'error', text: `IN-BROWSER PLAYBACK FAILED: ${this.sdkFallbackReason}`, code: 'sdk_failed' });
          next = sdk;
        } else {
          this.proxy.notify({ level: 'warn', text: 'IN-BROWSER PLAYBACK UNAVAILABLE; USING REMOTE CONTROL', code: 'sdk_fallback' });
        }
      }
    }
    if (token !== this.startToken) return;
    if (!next) {
      const con = new ConnectEngine(this.api, { volume: this.volume() }, () => this.emit());
      this.install(con);
      next = con;
      await con.start().catch((e) => this.handleApiError(e, 'connect start'));
    }
  }

  private install(e: SpotifyEngine) {
    this.engine = e;
    this.proxy.swap(e);
    this.syncList(true);
  }

  /** Push the canonical list into the current engine: whole on install/restart, else just the new rows. */
  private syncList(full: boolean) {
    const e = this.engine;
    if (!e) return;
    const l = this.list;
    if (full || this.shownIn !== e || this.shownCount > l.tracks.length) {
      e.setTracks(l.source, l.tracks, l.positions, l.loading);
    } else if (l.tracks.length > this.shownCount) {
      e.appendTracks(l.tracks.slice(this.shownCount), l.positions.slice(this.shownCount), l.loading);
    } else e.setLoading(l.loading);
    this.shownIn = e;
    this.shownCount = l.tracks.length;
  }

  private reasonText(r: string): string {
    return (
      {
        script_load_failed: 'PLAYER SCRIPT DID NOT LOAD',
        initialization_error: 'BROWSER NOT SUPPORTED',
        account_error: 'SPOTIFY PREMIUM REQUIRED',
        authentication_error: 'SIGN-IN REJECTED',
        autoplay_failed: 'AUDIO BLOCKED BY BROWSER',
        timeout: 'PLAYER TIMED OUT',
        connect_failed: 'PLAYER COULD NOT CONNECT',
      } as Record<string, string>
    )[r] ?? r.toUpperCase();
  }

  private sdkFailed(sdk: SdkEngine, reason: string, msg: string) {
    if (this.engine !== sdk) return;
    this.sdkFallbackReason = this.reasonText(reason);
    diag.warn('engine', `SDK fatal: ${reason}`);
    this.proxy.notify({ level: 'warn', text: msg, code: 'sdk_fallback' });
    if (this.modePref !== 'sdk') void this.startEngine();
    else this.emit();
  }

  async refreshLibrary() {
    try {
      const [pls, liked] = await Promise.all([
        this.library.playlists((all) => {
          this.playlists = all;
          this.emit();
        }),
        this.library.likedTotal().catch(() => null),
      ]);
      this.playlists = pls;
      this.likedTotal = liked;
    } catch (e) {
      this.handleApiError(e, 'playlists');
    }
    this.emit();
  }

  async refreshDevices() {
    if (this.engine instanceof ConnectEngine) {
      await this.engine.refreshDevices().catch((e) => this.handleApiError(e, 'devices'));
    }
    this.emit();
  }

  get devices(): Device[] {
    return this.engine instanceof ConnectEngine ? this.engine.devices : [];
  }

  transferTo(id: string) {
    if (this.engine instanceof ConnectEngine) void this.engine.transferTo(id);
  }

  /** Can the user read this playlist's items? (owner or collaborative) */
  readable(p: PlaylistInfo) {
    return p.collaborative || !this.profile || !p.ownerId || p.ownerId === this.profile.id;
  }

  likedSource(): SourceInfo {
    return { kind: 'liked', id: 'liked', name: 'LIKED SONGS', contextUri: null, externalUrl: 'https://open.spotify.com/collection/tracks' };
  }

  playlistSource(p: PlaylistInfo): SourceInfo {
    return { kind: 'playlist', id: p.id, name: p.name, contextUri: p.uri, externalUrl: p.externalUrl ?? `https://open.spotify.com/playlist/${p.id}`, snapshotId: p.snapshotId };
  }

  /** Load a source into the engine (progressively). `restoring` = from last session. */
  async loadSource(src: SourceInfo, restoring = false) {
    if (!this.auth.signedIn) return;
    this.loadSignal.aborted = true;
    const signal = { aborted: false };
    this.loadSignal = signal;
    // Re-check the snapshot when restoring so the cache stays honest.
    if (src.kind === 'playlist' && restoring) {
      try {
        const meta = await this.library.playlistMeta(src.id);
        if (meta) src = { ...src, name: meta.name, snapshotId: meta.snapshotId, contextUri: meta.uri };
      } catch (e) {
        if (e instanceof SpotifyApiError && (e.kind === 'not_found' || e.kind === 'forbidden')) {
          this.forgetSource();
          this.proxy.notify({ level: 'warn', text: 'LAST PLAYLIST IS NO LONGER AVAILABLE', code: 'restore_failed' });
          return;
        }
      }
    }
    if (signal.aborted) return;
    this.loadStatus = { sourceId: src.id, state: 'loading', loaded: 0, total: 0 };
    this.list = { source: src, tracks: [], positions: [], loading: true };
    this.syncList(true);
    this.emit();
    let attempt = 0;
    try {
      const res = await this.library.load(src, (p) => {
        if (signal.aborted) return;
        // A fallback that started over replaces the rows instead of appending to them.
        const restarted = p.attempt !== attempt;
        attempt = p.attempt;
        this.list = { source: src, tracks: p.tracks, positions: p.positions, loading: !p.done };
        this.syncList(restarted);
        this.loadStatus = { sourceId: src.id, state: p.done ? 'done' : 'loading', loaded: p.tracks.length, total: p.total };
        this.emit();
      }, signal);
      if (signal.aborted) return;
      this.saveSource(src);
      this.list = { ...this.list, loading: false };
      this.syncList(false);
      diag.info('app', `loaded ${src.kind} (${res.tracks.length} playable of ${res.total})`);
    } catch (e) {
      if (signal.aborted) return;
      this.list = { ...this.list, loading: false };
      this.syncList(false);
      let text = e instanceof SpotifyApiError ? e.message : 'COULD NOT LOAD';
      if (e instanceof SpotifyApiError && e.kind === 'forbidden') text = 'SPOTIFY ONLY SHARES PLAYLISTS YOU OWN OR COLLABORATE ON';
      this.loadStatus = { sourceId: src.id, state: 'error', loaded: this.list.tracks.length, total: 0, error: text };
      if (restoring) this.forgetSource();
      this.handleApiError(e, 'load', text);
      this.emit();
    }
  }

  private handleApiError(e: unknown, what: string, text?: string) {
    if (e instanceof SpotifyApiError) {
      if (e.kind === 'auth' && !this.auth.signedIn) return; // sign-out path handles it
      this.proxy.notify({ level: 'error', text: text ?? e.message, code: e.kind });
    } else if (e instanceof Error) {
      diag.error('app', `${what}: ${e.message}`);
    }
  }

  private saveSource(src: SourceInfo) {
    try {
      localStorage.setItem(LAST_SOURCE_KEY, JSON.stringify(src));
    } catch {
      /* ignore */
    }
  }

  private forgetSource() {
    try {
      localStorage.removeItem(LAST_SOURCE_KEY);
    } catch {
      /* ignore */
    }
  }

  lastSource(): SourceInfo | null {
    try {
      const s = localStorage.getItem(LAST_SOURCE_KEY);
      const v = s ? (JSON.parse(s) as SourceInfo) : null;
      return v && typeof v.id === 'string' && (v.kind === 'playlist' || v.kind === 'liked') ? v : null;
    } catch {
      return null;
    }
  }

  /** Lines for the diagnostics view. Never contains token values. */
  describe(): Record<string, string> {
    const info = this.auth.info();
    const out: Record<string, string> = {
      auth: this.signedIn ? `SIGNED IN${this.profile ? ' AS ' + this.profile.displayName : ''}` : 'SIGNED OUT',
      clientId: this.clientId ? `${this.clientId.slice(0, 6)}... (${this.clientIdBuiltIn ? 'BUILT IN' : 'ENTERED'})` : 'NOT SET',
      redirectUri: this.redirectUri,
      modePref: this.modePref.toUpperCase(),
    };
    if (info) {
      out.tokenExpires = `${new Date(info.expiresAt).toISOString()} (${Math.round((info.expiresAt - Date.now()) / 60000)} MIN)`;
      out.firstAuthorized = new Date(info.firstAuthorizedAt).toISOString();
      out.signInExpires = `~${new Date(info.refreshExpiresAt).toISOString().slice(0, 10)}`;
      out.scopes = info.scope || '-';
      out.refreshes = String(this.auth.refreshCount);
    }
    if (this.sdkFallbackReason) out.sdkFallback = this.sdkFallbackReason;
    if (this.engine) Object.assign(out, this.engine.describe());
    const src = this.engine?.getSource();
    out.source = src ? `${src.kind.toUpperCase()} "${src.name}" ${this.loadStatus.state} ${this.loadStatus.loaded}/${this.loadStatus.total}` : '-';
    out.apiRequests = String(this.api.requestCount);
    return out;
  }
}
