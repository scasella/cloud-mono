import type { Track } from '../engine/types';
import { SpotifyApiError, type SpotifyApi } from './api';
import { diag } from './diag';
import { TRACK_CACHE_KEY } from './storageKeys';
import type { SourceInfo } from './engineBase';
import { pageLacksTracks, parseEntry, parsePlaylist, type PlaylistInfo } from './parse';

const TRACK_FIELDS = 'type,uri,id,name,duration_ms,is_local,is_playable,external_urls(spotify),artists(name),album(name,images(url,width,height))';
/** New shape: entries carry `item`. */
const FIELDS_NEW = `next,total,offset,items(is_local,item(${TRACK_FIELDS}))`;
/** Old shape: entries carry `track`. */
const FIELDS_OLD = `next,total,offset,items(is_local,track(${TRACK_FIELDS}))`;

const CACHE_KEY = TRACK_CACHE_KEY;
const CACHE_MAX_ENTRIES = 4;
/** ~1.2 MB as UTF-16, far below Safari's ~5 MB localStorage quota, leaving room for tokens and prefs. */
const CACHE_MAX_CHARS = 600_000;

export interface Profile {
  id: string;
  displayName: string;
}

export interface LoadProgress {
  /** Increments when a fallback restarts the list from the top; consumers must replace, not append. */
  attempt: number;
  tracks: Track[];
  positions: number[];
  /** Total entries Spotify reports (including ones we skip). */
  total: number;
  done: boolean;
}

/** Compact cached row: [uri, artist, title, album, durationMs, artUrl, position] */
type Row = [string, string, string, string, number, string, number];
interface CacheEntry {
  id: string;
  snapshot: string;
  rows: Row[];
  at: number;
}

function readCache(): CacheEntry[] {
  try {
    const s = localStorage.getItem(CACHE_KEY);
    const v = s ? JSON.parse(s) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeCache(list: CacheEntry[]) {
  try {
    let s = JSON.stringify(list);
    while (s.length > CACHE_MAX_CHARS && list.length > 1) {
      list = list.slice(0, -1);
      s = JSON.stringify(list);
    }
    if (s.length <= CACHE_MAX_CHARS) localStorage.setItem(CACHE_KEY, s);
  } catch {
    /* quota: skip caching */
  }
}

function toRows(tracks: Track[], positions: number[]): Row[] {
  return tracks.map((t, i) => [t.uri ?? t.id, t.artist, t.title, t.album ?? '', Math.round(t.duration * 1000), t.artUrl ?? '', positions[i] ?? i]);
}

function fromRows(rows: Row[]): { tracks: Track[]; positions: number[] } {
  const tracks: Track[] = [];
  const positions: number[] = [];
  for (const r of rows) {
    const id = r[0].split(':').pop() ?? '';
    tracks.push({
      id: r[0],
      uri: r[0],
      artist: r[1],
      title: r[2],
      album: r[3] || undefined,
      duration: r[4] / 1000,
      artUrl: r[5] || undefined,
      externalUrl: `https://open.spotify.com/track/${id}`,
    });
    positions.push(r[6]);
  }
  return { tracks, positions };
}

export class Library {
  /** Which playlist-items attempt works for this app (learned on first use). */
  private itemsAttempt = 0;
  private memo = new Map<string, { snapshot: string; tracks: Track[]; positions: number[] }>();

  constructor(private api: SpotifyApi) {}

  async profile(): Promise<Profile> {
    const me = await this.api.get<{ id?: string; display_name?: string }>('/me');
    return { id: me?.id ?? '', displayName: me?.display_name || me?.id || 'SPOTIFY USER' };
  }

  async playlists(onPage?: (all: PlaylistInfo[]) => void): Promise<PlaylistInfo[]> {
    const out: PlaylistInfo[] = [];
    await this.api.paginate<unknown>('/me/playlists', {}, (items) => {
      for (const i of items) {
        const p = parsePlaylist(i);
        if (p) out.push(p);
      }
      onPage?.(out.slice());
    });
    return out;
  }

  async likedTotal(): Promise<number | null> {
    const page = await this.api.get<{ total?: number }>('/me/tracks', { query: { limit: 1 } });
    return typeof page?.total === 'number' ? page.total : null;
  }

  /** Current snapshot id (and name) of a playlist, cheaply. */
  async playlistMeta(id: string): Promise<PlaylistInfo | null> {
    const body = await this.api.get(`/playlists/${encodeURIComponent(id)}`, { query: { fields: 'id,name,uri,snapshot_id,owner(id,display_name),collaborative,external_urls(spotify)' } });
    return parsePlaylist(body);
  }

  /** Forget cached tracks (DISCONNECT). The localStorage copy is removed by the caller. */
  clearCache() {
    this.memo.clear();
  }

  cached(id: string, snapshot: string | undefined) {
    if (!snapshot) return null;
    const m = this.memo.get(id);
    if (m && m.snapshot === snapshot) return m;
    const hit = readCache().find((c) => c.id === id && c.snapshot === snapshot);
    if (!hit) return null;
    const v = { snapshot, ...fromRows(hit.rows) };
    this.memo.set(id, v);
    return v;
  }

  private store(id: string, snapshot: string | undefined, tracks: Track[], positions: number[]) {
    if (!snapshot) return;
    this.memo.set(id, { snapshot, tracks, positions });
    const list = readCache().filter((c) => c.id !== id);
    list.unshift({ id, snapshot, rows: toRows(tracks, positions), at: Date.now() });
    writeCache(list.slice(0, CACHE_MAX_ENTRIES));
  }

  /**
   * Load a source's tracks page by page, calling onProgress after each page.
   * Uses the snapshot cache for playlists. Throws SpotifyApiError (e.g. 403
   * for playlists the user neither owns nor collaborates on).
   */
  async load(src: SourceInfo, onProgress: (p: LoadProgress) => void, signal: { aborted: boolean }): Promise<LoadProgress> {
    if (src.kind === 'playlist') {
      const hit = this.cached(src.id, src.snapshotId);
      if (hit) {
        diag.info('api', `playlist served from cache (snapshot match, ${hit.tracks.length} tracks)`);
        const p = { attempt: 0, tracks: hit.tracks, positions: hit.positions, total: hit.tracks.length, done: true };
        onProgress(p);
        return p;
      }
    }
    let tracks: Track[] = [];
    let positions: number[] = [];
    let total = 0;
    let skipped = 0;
    let pos = 0;
    let attempt = 0;
    // A fallback starts over: fresh arrays, so rows from a failed attempt are never duplicated.
    const restart = () => {
      tracks = [];
      positions = [];
      total = 0;
      skipped = 0;
      pos = 0;
      attempt++;
    };
    const handle = (items: unknown[], pageTotal: number) => {
      total = pageTotal;
      for (const e of items) {
        const t = parseEntry(e);
        if (t) {
          tracks.push(t);
          positions.push(pos);
        } else skipped++;
        pos++;
      }
      onProgress({ attempt, tracks: tracks.slice(), positions: positions.slice(), total, done: false });
    };

    if (src.kind === 'liked') {
      await this.api.paginate<unknown>('/me/tracks', {}, (items, pg) => {
        if (signal.aborted) return false;
        handle(items, pg.total);
      }, signal);
    } else {
      await this.loadPlaylistItems(src.id, handle, restart, signal);
    }
    if (skipped) diag.info('api', `skipped ${skipped} unplayable entries (local files, episodes, removed)`);
    const done = { attempt, tracks, positions, total, done: true };
    if (!signal.aborted) {
      if (src.kind === 'playlist') this.store(src.id, src.snapshotId, tracks, positions);
      onProgress(done);
    }
    return done;
  }

  /**
   * GET /playlists/{id}/items. Attempts, in order (the last one that worked goes first next time):
   *   1. /items with the new-shape `fields` (entries carry `item`)
   *   2. /items with the old-shape `fields` (entries carry the deprecated `track` alias)
   *   3. /items with no `fields` at all (in case the filter is not honoured or rejected)
   *   4. /tracks with the old-shape `fields` (removed for new apps; last resort for old ones)
   * A page whose entries carry neither `item` nor `track`, a 404 or a 400 moves on to the next
   * attempt, which starts over from offset 0.
   */
  private async loadPlaylistItems(id: string, handle: (items: unknown[], total: number) => void, restart: () => void, signal: { aborted: boolean }) {
    const enc = encodeURIComponent(id);
    const all = ITEM_ATTEMPTS;
    const order = [this.itemsAttempt, ...all.map((_, i) => i).filter((i) => i !== this.itemsAttempt)];
    let lastErr: unknown = null;
    for (let k = 0; k < order.length; k++) {
      const a = all[order[k]];
      if (k > 0) restart();
      try {
        await this.api.paginate<unknown>(`/playlists/${enc}/${a.path}`, a.fields ? { fields: a.fields } : {}, (items, pg) => {
          if (signal.aborted) return false;
          if (pageLacksTracks(items)) throw new ShapeMismatch();
          handle(items, pg.total);
        }, signal);
        if (this.itemsAttempt !== order[k]) diag.info('api', `playlist items: using ${a.label}`);
        this.itemsAttempt = order[k];
        return;
      } catch (e) {
        lastErr = e;
        const retry = e instanceof ShapeMismatch || (e instanceof SpotifyApiError && (e.kind === 'not_found' || e.kind === 'bad_request'));
        if (!retry) throw e;
        diag.info('api', `playlist items: ${a.label} did not work (${e instanceof ShapeMismatch ? 'no track objects' : (e as SpotifyApiError).status})`);
      }
    }
    throw lastErr instanceof ShapeMismatch ? new SpotifyApiError('not_found', 404, 'SPOTIFY RETURNED NO TRACKS FOR THIS PLAYLIST') : lastErr;
  }
}

const ITEM_ATTEMPTS: Array<{ path: 'items' | 'tracks'; fields: string | null; label: string }> = [
  { path: 'items', fields: FIELDS_NEW, label: '/items (item)' },
  { path: 'items', fields: FIELDS_OLD, label: '/items (track alias)' },
  { path: 'items', fields: null, label: '/items (no fields filter)' },
  { path: 'tracks', fields: FIELDS_OLD, label: '/tracks (old API)' },
];

class ShapeMismatch extends Error {}
