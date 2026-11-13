import { SpotifyApiError, type SpotifyApi } from './api';
import { diag } from './diag';
import { SpotifyEngineBase, type PlayRequest } from './engineBase';
import { parseDevice, parsePlayerState, type Device, type RepeatMode } from './parse';

const POLL_PLAYING_MS = 4000;
const POLL_IDLE_MS = 6000;
const POLL_HIDDEN_MS = 30000;
const POLL_MAX_BACKOFF_MS = 60000;
/** Re-read state this long after a command so the UI reconciles quickly. */
const AFTER_COMMAND_MS = 700;
const PREFERRED_DEVICE_KEY = 'duoamp.spotify.device.v1';

/**
 * Remote control of another Spotify Connect device (typically the Spotify app
 * on the same phone) through /me/player. State comes from polling.
 */
export class ConnectEngine extends SpotifyEngineBase {
  readonly mode = 'connect' as const;
  devices: Device[] = [];
  /** Device chosen in the picker; used when no device is active. */
  preferredDeviceId: string | null = null;
  private timer: number | undefined;
  private failures = 0;
  private lastPoll = 0;
  private onVis = () => {
    if (!document.hidden) this.schedule(0);
  };
  pollCount = 0;

  constructor(api: SpotifyApi, opts: { volume: number }, private onDevices: () => void = () => undefined) {
    super(api, {
      volume: opts.volume,
      caps: { volume: true, balance: false, seek: true, inBrowserAudio: false, needsGesture: false, streamInfo: false },
    });
    try {
      this.preferredDeviceId = localStorage.getItem(PREFERRED_DEVICE_KEY);
    } catch {
      /* ignore */
    }
  }

  async start() {
    document.addEventListener('visibilitychange', this.onVis);
    await this.refreshDevices().catch(() => undefined);
    await this.poll();
  }

  private schedule(ms: number) {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.poll(), ms);
  }

  private nextDelay(): number {
    if (this.failures > 0) return Math.min(POLL_MAX_BACKOFF_MS, POLL_IDLE_MS * 2 ** this.failures);
    if (document.hidden) return POLL_HIDDEN_MS;
    if (this.status === 'playing') {
      // Poll right after the expected track end so the next track shows up promptly.
      const left = (this.durationS - this.getPosition()) * 1000;
      if (left > 0 && left + 600 < POLL_PLAYING_MS) return left + 600;
      return POLL_PLAYING_MS;
    }
    return POLL_IDLE_MS;
  }

  private async poll() {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      await this.refreshState();
      this.failures = 0;
    } catch (e) {
      this.failures++;
      if (e instanceof SpotifyApiError && e.kind === 'auth') return; // the service signs out
    }
    this.schedule(this.nextDelay());
  }

  async refreshState() {
    this.pollCount++;
    this.lastPoll = Date.now();
    const body = await this.api.get('/me/player', { query: { additional_types: 'track' } });
    const st = parsePlayerState(body);
    if (st?.device) {
      this.setCaps({ volume: st.device.supportsVolume });
      if (st.device.volume !== null && Math.abs(st.device.volume / 100 - this.volume) > 0.015) {
        this.volume = st.device.volume / 100;
        this.emit('settings');
      }
      const known = this.devices.find((d) => d.id === st.device!.id);
      if (!known || !known.isActive) {
        this.devices = [st.device, ...this.devices.filter((d) => d.id !== st.device!.id).map((d) => ({ ...d, isActive: false }))];
        this.onDevices();
      }
    }
    this.applyRemote(st);
  }

  async refreshDevices(): Promise<Device[]> {
    const body = await this.api.get<{ devices?: unknown[] }>('/me/player/devices');
    this.devices = (body?.devices ?? []).map(parseDevice).filter((d): d is Device => d !== null);
    diag.info('engine', `devices: ${this.devices.map((d) => `${d.name}${d.isActive ? '*' : ''}`).join(', ') || 'none'}`);
    this.onDevices();
    return this.devices;
  }

  activeDevice(): Device | null {
    return this.remote?.device ?? this.devices.find((d) => d.isActive) ?? null;
  }

  /** Move playback to a device (device picker). */
  transferTo(id: string) {
    this.preferredDeviceId = id;
    try {
      localStorage.setItem(PREFERRED_DEVICE_KEY, id);
    } catch {
      /* ignore */
    }
    return this.run('transfer', async () => {
      await this.api.put('/me/player', { body: { device_ids: [id], play: this.status === 'playing' } });
      this.devices = this.devices.map((d) => ({ ...d, isActive: d.id === id }));
      this.onDevices();
      this.schedule(AFTER_COMMAND_MS);
    });
  }

  protected hasActivePlayback() {
    return this.remote !== null;
  }

  /** device_id only when nothing is active: otherwise commands go to the active device. */
  private target(): string | undefined {
    if (this.activeDevice()) return undefined;
    const pref = this.devices.find((d) => d.id === this.preferredDeviceId) ?? this.devices[0];
    return pref?.id;
  }

  private async cmd(fn: () => Promise<unknown>) {
    try {
      await fn();
    } finally {
      this.schedule(AFTER_COMMAND_MS);
    }
  }

  protected tPlay(req: PlayRequest | null) {
    return this.cmd(() => this.api.put('/me/player/play', { query: { device_id: this.target() }, body: req ?? undefined }));
  }
  protected tPause() {
    return this.cmd(() => this.api.put('/me/player/pause'));
  }
  protected tNext() {
    return this.cmd(() => this.api.post('/me/player/next'));
  }
  protected tPrev() {
    return this.cmd(() => this.api.post('/me/player/previous'));
  }
  protected tSeek(ms: number) {
    return this.cmd(() => this.api.put('/me/player/seek', { query: { position_ms: ms } }));
  }
  protected tVolume(v: number) {
    return this.cmd(() => this.api.put('/me/player/volume', { query: { volume_percent: Math.round(v * 100) } }));
  }
  protected tShuffle(on: boolean) {
    return this.cmd(() => this.api.put('/me/player/shuffle', { query: { state: on } }));
  }
  protected tRepeat(mode: RepeatMode) {
    return this.cmd(() => this.api.put('/me/player/repeat', { query: { state: mode } }));
  }

  describe() {
    const d = this.activeDevice();
    return {
      mode: 'REMOTE CONTROL (SPOTIFY CONNECT)',
      device: d ? `${d.name} (${d.type || '?'})${d.isActive ? ' ACTIVE' : ''}` : 'NONE ACTIVE',
      devices: this.devices.map((x) => x.name).join(', ') || '-',
      volume: this.caps.volume ? 'CONTROLLABLE' : 'NOT SUPPORTED BY DEVICE',
      polls: `${this.pollCount}${this.lastPoll ? `, last ${Math.round((Date.now() - this.lastPoll) / 1000)}S AGO` : ''}`,
      pollFailures: String(this.failures),
    };
  }

  override dispose() {
    super.dispose();
    if (this.timer !== undefined) clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVis);
  }
}
