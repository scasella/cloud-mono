import type { Track } from '../engine/types';

/**
 * Tolerant parsers. Spotify's Feb 2026 changes renamed playlist `tracks` to
 * `items` (and each entry's `track` to `item`); both shapes are accepted.
 * Anything that cannot be played here (null entries, local files, episodes,
 * items without a track URI) is skipped.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface Image {
  url: string;
  width?: number;
  height?: number;
}

/** Smallest image at least `min` px wide, else the largest. */
export function pickImage(images: unknown, min = 300): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const list: Image[] = images.filter((i) => isObj(i) && typeof i.url === 'string') as unknown as Image[];
  if (!list.length) return undefined;
  const sized = list.filter((i) => typeof i.width === 'number');
  if (!sized.length) return list[0].url;
  const big = sized.filter((i) => i.width! >= min).sort((a, b) => a.width! - b.width!);
  return (big[0] ?? sized.sort((a, b) => b.width! - a.width!)[0]).url;
}

/** Parse a Web API track object (or a Web Playback SDK track). */
export function parseTrack(o: unknown): Track | null {
  if (!isObj(o)) return null;
  if (o.is_local === true) return null;
  const type = str(o.type);
  if (type && type !== 'track') return null;
  const uri = str(o.uri);
  if (!uri || !uri.startsWith('spotify:track:')) return null;
  const artists = Array.isArray(o.artists) ? o.artists.map((a) => (isObj(a) ? str(a.name) : undefined)).filter(Boolean) : [];
  const album = isObj(o.album) ? o.album : undefined;
  const ext = isObj(o.external_urls) ? str(o.external_urls.spotify) : undefined;
  const id = str(o.id) ?? uri.slice('spotify:track:'.length);
  const ms = num(o.duration_ms) ?? num(o.duration) ?? 0;
  return {
    id: uri,
    uri,
    artist: artists.join(', ') || 'UNKNOWN ARTIST',
    title: str(o.name) ?? 'UNTITLED',
    album: album ? str(album.name) : undefined,
    duration: ms / 1000,
    // The art view is ~360 CSS px wide on 3x screens: prefer the 640 px image.
    artUrl: album ? pickImage(album.images, 600) : undefined,
    externalUrl: ext ?? (id ? `https://open.spotify.com/track/${id}` : undefined),
  };
}

/** One entry of /playlists/{id}/items (new: `item`) or /tracks (old: `track`), or of /me/tracks. */
export function parseEntry(e: unknown): Track | null {
  if (!isObj(e)) return null;
  if (e.is_local === true) return null;
  const inner = e.item !== undefined && e.item !== null ? e.item : e.track;
  return parseTrack(inner);
}

/** True when a page of entries carried neither `item` nor `track` objects (wrong `fields` for this API shape). */
export function pageLacksTracks(items: unknown[]): boolean {
  // Local-file entries still carry an object under item/track, so they count as present.
  return items.length > 0 && !items.some((e) => isObj(e) && (isObj(e.item) || isObj(e.track)));
}

export interface PlaylistInfo {
  id: string;
  uri: string;
  name: string;
  ownerId?: string;
  ownerName?: string;
  collaborative: boolean;
  snapshotId?: string;
  /** null when Spotify did not report a count. */
  total: number | null;
  imageUrl?: string;
  externalUrl?: string;
}

export function parsePlaylist(o: unknown): PlaylistInfo | null {
  if (!isObj(o)) return null;
  const id = str(o.id);
  if (!id) return null;
  const owner = isObj(o.owner) ? o.owner : undefined;
  const items = isObj(o.items) ? o.items : undefined;
  const tracks = isObj(o.tracks) ? o.tracks : undefined;
  const total = num(items?.total) ?? num(tracks?.total) ?? null;
  return {
    id,
    uri: str(o.uri) ?? `spotify:playlist:${id}`,
    name: str(o.name) ?? 'UNTITLED PLAYLIST',
    ownerId: owner ? str(owner.id) : undefined,
    ownerName: owner ? str(owner.display_name) ?? str(owner.id) : undefined,
    collaborative: o.collaborative === true,
    snapshotId: str(o.snapshot_id),
    total,
    imageUrl: pickImage(o.images, 64),
    externalUrl: isObj(o.external_urls) ? str(o.external_urls.spotify) : undefined,
  };
}

export interface Device {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  supportsVolume: boolean;
  volume: number | null;
}

export function parseDevice(o: unknown): Device | null {
  if (!isObj(o)) return null;
  const id = str(o.id);
  if (!id) return null;
  const vp = num(o.volume_percent);
  return {
    id,
    name: str(o.name) ?? 'DEVICE',
    type: str(o.type) ?? '',
    isActive: o.is_active === true,
    isRestricted: o.is_restricted === true,
    // Missing field: assume controllable when a volume is reported.
    supportsVolume: typeof o.supports_volume === 'boolean' ? o.supports_volume : vp !== undefined,
    volume: vp ?? null,
  };
}

export type RepeatMode = 'off' | 'context' | 'track';

/** Normalised playback state from either GET /me/player or the SDK. */
export interface RemoteState {
  track: Track | null;
  /** URIs the current track may be known by (relinking): own URI and linked_from. */
  uris: string[];
  paused: boolean;
  positionMs: number;
  durationMs: number;
  shuffle: boolean;
  repeat: RepeatMode;
  contextUri: string | null;
  disallows: Partial<Record<'pause' | 'resume' | 'seek' | 'next' | 'prev' | 'shuffle' | 'repeat', boolean>>;
  /** performance.now() when the position was valid. */
  sampledAt: number;
  device?: Device | null;
}

function uriList(o: Obj): string[] {
  const out: string[] = [];
  const u = str(o.uri);
  if (u) out.push(u);
  const lf = isObj(o.linked_from) ? str(o.linked_from.uri) : undefined;
  if (lf && !out.includes(lf)) out.push(lf);
  return out;
}

/** GET /me/player body (null/204 means nothing is playing anywhere). */
export function parsePlayerState(o: unknown, now = performance.now()): RemoteState | null {
  if (!isObj(o)) return null;
  const item = isObj(o.item) ? o.item : null;
  // `actions.disallows.{...}` per the reference; some responses put the keys directly under `actions`.
  const actions = isObj(o.actions) ? o.actions : {};
  const dis = isObj(actions.disallows) ? { ...actions, ...actions.disallows } : actions;
  const ctx = isObj(o.context) ? str(o.context.uri) ?? null : null;
  const rep = str(o.repeat_state);
  return {
    track: parseTrack(item),
    uris: item ? uriList(item) : [],
    paused: o.is_playing !== true,
    positionMs: num(o.progress_ms) ?? 0,
    durationMs: item ? num(item.duration_ms) ?? 0 : 0,
    shuffle: o.shuffle_state === true,
    repeat: rep === 'context' || rep === 'track' ? rep : 'off',
    contextUri: ctx,
    disallows: {
      pause: dis.pausing === true,
      resume: dis.resuming === true,
      seek: dis.seeking === true,
      next: dis.skipping_next === true,
      prev: dis.skipping_prev === true,
      shuffle: dis.toggling_shuffle === true,
      repeat: dis.toggling_repeat_context === true,
    },
    sampledAt: now,
    device: parseDevice(o.device),
  };
}

/** Web Playback SDK `player_state_changed` / getCurrentState() payload. */
export function parseSdkState(o: unknown, now = performance.now()): RemoteState | null {
  if (!isObj(o)) return null;
  const tw = isObj(o.track_window) ? o.track_window : {};
  const cur = isObj(tw.current_track) ? tw.current_track : null;
  const dis = isObj(o.disallows) ? o.disallows : {};
  const ctx = isObj(o.context) ? str(o.context.uri) ?? null : null;
  const rm = num(o.repeat_mode) ?? 0;
  const dur = num(o.duration) ?? (cur ? num(cur.duration_ms) : undefined) ?? 0;
  const track = cur ? parseTrack({ ...cur, duration_ms: num(cur.duration_ms) ?? dur }) : null;
  // The SDK state can be older than "now" (getCurrentState returns the last known state).
  // When it carries an epoch-ms `timestamp` (observed, undocumented), the position is as
  // of that moment; use it so a resync never snaps the position backwards.
  const ts = num(o.timestamp);
  const ageMs = ts !== undefined ? Date.now() - ts : NaN;
  const sampledAt = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 3600_000 ? now - ageMs : now;
  return {
    track,
    uris: cur ? uriList(cur) : [],
    paused: o.paused !== false,
    positionMs: num(o.position) ?? 0,
    durationMs: dur,
    shuffle: o.shuffle === true,
    repeat: rm === 1 ? 'context' : rm === 2 ? 'track' : 'off',
    contextUri: ctx,
    disallows: {
      pause: dis.pausing === true,
      resume: dis.resuming === true,
      seek: dis.seeking === true,
      next: dis.skipping_next === true,
      prev: dis.skipping_prev === true,
      shuffle: dis.toggling_shuffle === true,
      repeat: dis.toggling_repeat_context === true,
    },
    sampledAt,
  };
}
