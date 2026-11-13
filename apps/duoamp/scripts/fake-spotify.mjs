/**
 * A fake Spotify for Playwright: route interception for accounts.spotify.com,
 * api.spotify.com, sdk.scdn.co (a stub spotify-player.js emulating
 * Spotify.Player) and i.scdn.co (cover images). One in-process model backs the
 * Web API player endpoints and the SDK stub, so Web API commands and SDK
 * events stay consistent, like the real service.
 *
 * Shapes follow developer.spotify.com (Feb 2026 migration guide, Web API and
 * Web Playback SDK references). It cannot reproduce Spotify's real timing,
 * DRM audio, iOS behaviour or undocumented quirks.
 */
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rnd = (n = 24) => b64url(randomBytes(n));

// ---- tiny PNG for cover art (original: a two-colour gradient with a square) --
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngImage(w, h, seed) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  const a = [(seed * 53) % 255, (seed * 97) % 255, (seed * 31 + 80) % 255];
  const b = [255 - a[1], (a[0] + 90) % 255, 200];
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      const inSq = x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7;
      const i = y * (w * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[i + c] = inSq ? 245 : Math.round(a[c] * (1 - t) + b[c] * t);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- catalogue ---------------------------------------------------------------
const ARTISTS = ['Fake Harbor', 'The Test Signals', 'Mock Orchestra', 'Null Pointer', 'Stub & Spy', 'Async Duo', 'Kåre Nørd'];
const WORDS = ['Night', 'Drive', 'Blue', 'Echo', 'Paper', 'Signal', 'Orbit', 'Glass', 'River', 'Static', 'Summer', 'Neon'];

function makeTrack(n, prefix = 't') {
  const id = `${prefix}${String(n).padStart(4, '0')}fake${'x'.repeat(8)}`.slice(0, 22);
  return {
    type: 'track',
    id,
    uri: `spotify:track:${id}`,
    name: `${WORDS[n % WORDS.length]} ${WORDS[(n * 7 + 3) % WORDS.length]} ${n}`,
    duration_ms: 150000 + ((n * 7919) % 120000),
    is_local: false,
    is_playable: true,
    explicit: false,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    artists: [{ name: ARTISTS[n % ARTISTS.length], uri: `spotify:artist:a${n % ARTISTS.length}` }],
    album: {
      name: `Album ${n % 9}`,
      uri: `spotify:album:al${n % 9}`,
      images: [
        { url: `https://i.scdn.co/image/fake-${n % 9}-640`, width: 640, height: 640 },
        { url: `https://i.scdn.co/image/fake-${n % 9}-300`, width: 300, height: 300 },
        { url: `https://i.scdn.co/image/fake-${n % 9}-64`, width: 64, height: 64 },
      ],
    },
  };
}

/** 120 playable tracks plus a null entry, two local files and two episodes, interleaved. */
function bigPlaylistEntries() {
  const entries = [];
  let n = 1;
  for (let pos = 0; pos < 125; pos++) {
    if (pos === 7) entries.push({ added_at: null, is_local: false, item: null });
    else if (pos === 15 || pos === 60) entries.push({ is_local: true, item: { type: 'track', uri: `spotify:local:Artist:Album:Local+${pos}:200`, name: `Local ${pos}`, is_local: true, duration_ms: 200000, artists: [{ name: 'Local' }], album: { name: 'Local', images: [] } } });
    else if (pos === 30 || pos === 90) entries.push({ is_local: false, item: { type: 'episode', uri: `spotify:episode:ep${pos}`, name: `Episode ${pos}`, duration_ms: 1800000 } });
    else entries.push({ is_local: false, item: makeTrack(n++) });
  }
  return entries;
}

export const CLIENT_ID = 'abcdef0123456789abcdef0123456789';
export const ME = { id: 'fakeuser', display_name: 'Fake Listener' };

export class FakeSpotify {
  constructor(opts = {}) {
    this.cfg = {
      shape: 'new', // 'new' | 'old' (/items 404, `track` key, tracks.total) | 'alias' (/items with deprecated `track` key)
      expiresIn: 3600,
      refreshInvalidGrant: false,
      rotateRefresh: false,
      denyConsent: false,
      tamperState: false,
      sdk: 'ok', // 'ok' | 'init_error' | 'account_error' | 'no_script' | 'autoplay_strict'
      iosVolume: false,
      exposeRetryAfter: true,
      rateLimit: null, // { match: RegExp, times: n, retryAfter: s, reason? }
      phone: { present: true, active: false, supportsVolume: false },
      // Scopes the user's consent does NOT grant (Spotify returns the granted ones in `scope`).
      denyScopes: [],
      // /items with a `fields` parameter answers 400 (filter not supported).
      fields400: false,
      // One-shot failures: [{ match: RegExp (path), offset?: number, status }]
      failOnce: [],
      // Flat `actions` (keys directly under actions) instead of actions.disallows.
      actionsFlat: false,
      // Next N token requests fail at the network level.
      tokenNetworkFailures: 0,
      // SDK commands that never settle (e.g. ['pause']).
      sdkHang: [],
      // After the first connect, every reconnect reports authentication_error.
      sdkAuthFailOnReconnect: false,
      // getCurrentState() returns a snapshot this old (ms), with a matching timestamp.
      sdkStaleMs: 0,
      // A restricted device listed first.
      restrictedDevice: false,
      ...opts,
    };
    this.scopeOf = new Map(); // access or refresh token -> granted scope string
    this.log = [];
    this.codes = new Map();
    this.access = new Map(); // token -> expiresAt (ms)
    this.refreshTokens = new Set();
    this.issued = { access: [], refresh: [], codes: [], verifiers: [] };
    this.tokenRequests = [];
    this.playlists = [
      { id: 'pl120', name: 'Road Trip 120', owner: ME, collaborative: false, snapshot: 'snap-1', entries: bigPlaylistEntries() },
      { id: 'plcollab', name: 'Shared Mix', owner: { id: 'friend', display_name: 'Friend' }, collaborative: true, snapshot: 's-c', entries: Array.from({ length: 12 }, (_, i) => ({ is_local: false, item: makeTrack(500 + i) })) },
      { id: 'plother', name: "Someone Else's Hits", owner: { id: 'stranger', display_name: 'Stranger' }, collaborative: false, snapshot: 's-o', entries: Array.from({ length: 30 }, (_, i) => ({ is_local: false, item: makeTrack(700 + i) })) },
    ];
    for (let i = 0; i < (this.cfg.extraPlaylists ?? 0); i++) {
      this.playlists.push({ id: `plx${i}`, name: `Extra Playlist Number ${i + 1} With A Rather Long Name`, owner: ME, collaborative: false, snapshot: `sx${i}`, entries: Array.from({ length: 3 + i }, (_, k) => ({ is_local: false, item: makeTrack(1000 + i * 50 + k) })) });
    }
    this.liked = Array.from({ length: 60 }, (_, i) => ({ added_at: '2026-01-01T00:00:00Z', track: makeTrack(300 + i, 'l') }));
    this.devices = [];
    if (this.cfg.restrictedDevice) this.devices.push({ id: 'tv-1', is_active: false, is_private_session: false, is_restricted: true, name: 'Restricted TV', type: 'TV', volume_percent: 50, supports_volume: false });
    if (this.cfg.phone.present) this.addPhone(this.cfg.phone.active);
    this.player = null; // { deviceId, contextUri, queue:[track], idx, posMs, at, paused, shuffle, repeat }
    this.sdk = { page: null, deviceId: null, activated: false, events: [] };
    this.images = new Map();
    // Track 6 of the big playlist plays as a relinked copy (different URI), as Spotify does for market variants.
    this.relinked = new Set([makeTrack(6).uri]);
  }

  relink(it) {
    if (!this.relinked.has(it.uri)) return it;
    const id = 'relinked0006fakexxxxxx'.slice(0, 22);
    return { ...it, id, uri: `spotify:track:${id}`, linked_from: { uri: it.uri, id: it.id } };
  }

  addPhone(active = false) {
    if (this.devices.some((d) => d.id === 'phone-1')) return;
    this.devices.push({ id: 'phone-1', is_active: active, is_private_session: false, is_restricted: false, name: 'Fake iPhone', type: 'Smartphone', volume_percent: 60, supports_volume: this.cfg.phone.supportsVolume });
  }

  removePhone() {
    this.devices = this.devices.filter((d) => d.id !== 'phone-1');
    if (this.player?.deviceId === 'phone-1') this.player = null;
  }

  /** Simulate the user playing something in the Spotify app (outside DuoAmp). */
  playOnPhone(track = makeTrack(9001, 'z')) {
    this.addPhone(true);
    for (const d of this.devices) d.is_active = d.id === 'phone-1';
    this.player = { deviceId: 'phone-1', contextUri: null, queue: [track], idx: 0, posMs: 12000, at: Date.now(), paused: false, shuffle: false, repeat: 'off' };
  }

  /** The SDK player drops offline (network blip): emits not_ready; a later connect() brings it back. */
  sdkGoOffline() {
    this.sdkEmit('not_ready', { device_id: this.sdk.deviceId });
  }

  revokeAccessTokens() {
    this.access.clear();
  }

  requests(filter) {
    return this.log.filter((r) => (typeof filter === 'string' ? r.path.includes(filter) : filter ? filter(r) : true));
  }

  // ---- install -----------------------------------------------------------------

  async install(context) {
    this.context = context;
    await context.exposeBinding('__fakeSpotify', (src, cmd, arg) => this.binding(src.page, cmd, arg));
    await context.route('https://accounts.spotify.com/**', (route) => this.accounts(route));
    await context.route('https://api.spotify.com/**', (route) => this.apiRoute(route));
    await context.route('https://sdk.scdn.co/**', (route) => this.sdkScript(route));
    await context.route('https://i.scdn.co/**', (route) => {
      const key = route.request().url();
      if (!this.images.has(key)) this.images.set(key, pngImage(96, 96, this.images.size + 3));
      route.fulfill({ status: 200, contentType: 'image/png', body: this.images.get(key), headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    this.timer = setInterval(() => this.tick(), 200);
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  cors(extra = {}) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      ...(this.cfg.exposeRetryAfter ? { 'Access-Control-Expose-Headers': 'Retry-After' } : {}),
      ...extra,
    };
  }

  // ---- accounts.spotify.com ---------------------------------------------------------

  async accounts(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: this.cors() });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      this.log.push({ method: 'GET', path: '/authorize', query: Object.fromEntries(q) });
      const redirect = q.get('redirect_uri');
      const problems = [];
      if (q.get('client_id') !== CLIENT_ID) problems.push('client_id');
      if (q.get('response_type') !== 'code') problems.push('response_type');
      if (q.get('code_challenge_method') !== 'S256') problems.push('code_challenge_method');
      if (!/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') ?? '')) problems.push('code_challenge');
      if (!q.get('state')) problems.push('state');
      if (this.cfg.expectRedirect && redirect !== this.cfg.expectRedirect) problems.push('redirect_uri');
      if (problems.length) return route.fulfill({ status: 400, contentType: 'text/html', body: `<h1>INVALID_CLIENT: ${problems.join(',')}</h1>` });
      const state = this.cfg.tamperState ? 'tampered-state' : q.get('state');
      let target;
      if (this.cfg.denyConsent) target = `${redirect}?error=access_denied&state=${encodeURIComponent(state)}`;
      else {
        const code = `code-${rnd(40)}`;
        this.issued.codes.push(code);
        this.codes.set(code, { challenge: q.get('code_challenge'), redirect, clientId: q.get('client_id'), scope: q.get('scope') });
        target = `${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      }
      return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Fake Spotify consent</title><script>location.replace(${JSON.stringify(target)})</script>` });
    }
    if (url.pathname === '/api/token' && req.method() === 'POST') {
      if (this.cfg.tokenNetworkFailures > 0) {
        this.cfg.tokenNetworkFailures--;
        this.tokenRequests.push({ grant: 'network-failure', at: Date.now() });
        return route.abort('internetdisconnected');
      }
      const form = new URLSearchParams(req.postData() ?? '');
      const grant = form.get('grant_type');
      this.tokenRequests.push({ grant, at: Date.now(), contentType: req.headers()['content-type'] });
      const err = (error, description) => route.fulfill({ status: 400, contentType: 'application/json', headers: this.cors(), body: JSON.stringify({ error, error_description: description }) });
      if (form.get('client_id') !== CLIENT_ID) return err('invalid_client', 'Invalid client');
      if (form.has('client_secret')) return err('invalid_request', 'PKCE clients must not send a secret');
      if (grant === 'authorization_code') {
        const code = form.get('code');
        const rec = this.codes.get(code);
        if (!rec) return err('invalid_grant', 'Invalid authorization code');
        this.codes.delete(code);
        if (rec.redirect !== form.get('redirect_uri')) return err('invalid_grant', 'Invalid redirect URI');
        const verifier = form.get('code_verifier') ?? '';
        this.issued.verifiers.push(verifier);
        const challenge = b64url(createHash('sha256').update(verifier).digest());
        if (challenge !== rec.challenge) return err('invalid_grant', 'code_verifier was incorrect');
        const granted = (rec.scope ?? '').split(' ').filter((x) => x && !this.cfg.denyScopes.includes(x)).join(' ');
        return this.issueTokens(route, granted, true);
      }
      if (grant === 'refresh_token') {
        const rt = form.get('refresh_token');
        if (this.cfg.refreshInvalidGrant || !this.refreshTokens.has(rt)) return err('invalid_grant', 'Refresh token revoked');
        if (this.cfg.rotateRefresh) this.refreshTokens.delete(rt);
        return this.issueTokens(route, this.scopeOf.get(rt) ?? '', this.cfg.rotateRefresh);
      }
      return err('unsupported_grant_type', 'unsupported');
    }
    return route.fulfill({ status: 404, body: 'not found' });
  }

  /** Issue a token set directly (e.g. "another tab refreshed"). */
  mint(scope) {
    const access = `fakeaccess${rnd(60)}`;
    const refresh = `fakerefresh${rnd(60)}`;
    this.access.set(access, Date.now() + this.cfg.expiresIn * 1000);
    this.refreshTokens.add(refresh);
    this.scopeOf.set(access, scope);
    this.scopeOf.set(refresh, scope);
    this.issued.access.push(access);
    this.issued.refresh.push(refresh);
    return { access, refresh };
  }

  issueTokens(route, scope, withRefresh, prevRefresh) {
    const access = `fakeaccess${rnd(60)}`;
    this.access.set(access, Date.now() + this.cfg.expiresIn * 1000);
    this.scopeOf.set(access, scope);
    this.issued.access.push(access);
    const body = { access_token: access, token_type: 'Bearer', expires_in: this.cfg.expiresIn, scope };
    if (withRefresh) {
      const refresh = `fakerefresh${rnd(60)}`;
      this.refreshTokens.add(refresh);
      this.scopeOf.set(refresh, scope);
      this.issued.refresh.push(refresh);
      body.refresh_token = refresh;
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: this.cors(), body: JSON.stringify(body) });
  }

  // ---- api.spotify.com ------------------------------------------------------------

  json(route, status, body, headers = {}) {
    return route.fulfill({ status, contentType: 'application/json', headers: this.cors(headers), body: body === undefined ? '' : JSON.stringify(body) });
  }

  apiError(route, status, message, reason, headers) {
    return this.json(route, status, { error: { status, message, ...(reason ? { reason } : {}) } }, headers);
  }

  async apiRoute(route) {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: this.cors() });
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/v1/, '');
    const q = Object.fromEntries(url.searchParams);
    let body = null;
    try {
      body = req.postData() ? JSON.parse(req.postData()) : null;
    } catch {
      body = null;
    }
    const auth = req.headers().authorization ?? '';
    const token = auth.replace(/^Bearer /, '');
    const entry = { method: req.method(), path, query: q, body, at: Date.now() };
    this.log.push(entry);
    const exp = this.access.get(token);
    if (!exp || exp < Date.now()) {
      entry.status = 401;
      return this.apiError(route, 401, 'The access token expired');
    }
    const rl = this.cfg.rateLimit;
    if (rl && rl.times > 0 && rl.match.test(path)) {
      rl.times--;
      entry.status = 429;
      return this.apiError(route, 429, 'API rate limit exceeded', rl.reason, { 'Retry-After': String(rl.retryAfter) });
    }
    const fo = this.cfg.failOnce.findIndex((f) => f.match.test(path) && (f.offset === undefined || Number(q.offset ?? 0) === f.offset));
    if (fo >= 0) {
      const f = this.cfg.failOnce.splice(fo, 1)[0];
      entry.status = f.status;
      return this.apiError(route, f.status, `Injected ${f.status}`);
    }
    try {
      const res = this.handle(req.method(), path, q, body);
      entry.status = res.status;
      if (res.status === 204) return route.fulfill({ status: 204, headers: this.cors() });
      if (res.error) return this.apiError(route, res.status, res.error, res.reason);
      return this.json(route, res.status, res.body);
    } catch (e) {
      entry.status = 500;
      return this.apiError(route, 500, String(e));
    }
  }

  page(items, q, basePath, extra = {}) {
    const limit = q.limit === undefined ? 20 : Number(q.limit);
    const offset = Number(q.offset ?? 0);
    if (!(limit >= 1 && limit <= 50)) return { status: 400, error: 'Invalid limit' };
    const slice = items.slice(offset, offset + limit);
    const nextOff = offset + limit;
    const keep = new URLSearchParams(q);
    keep.set('offset', String(nextOff));
    keep.set('limit', String(limit));
    return {
      status: 200,
      body: {
        href: `https://api.spotify.com/v1${basePath}?${new URLSearchParams(q)}`,
        items: slice,
        limit,
        offset,
        total: items.length,
        next: nextOff < items.length ? `https://api.spotify.com/v1${basePath}?${keep}` : null,
        previous: offset > 0 ? `https://api.spotify.com/v1${basePath}?offset=${Math.max(0, offset - limit)}&limit=${limit}` : null,
        ...extra,
      },
    };
  }

  playlistObj(p) {
    const count = { href: `https://api.spotify.com/v1/playlists/${p.id}/items`, total: p.entries.length };
    return {
      id: p.id,
      name: p.name,
      uri: `spotify:playlist:${p.id}`,
      collaborative: p.collaborative,
      snapshot_id: p.snapshot,
      owner: { id: p.owner.id, display_name: p.owner.display_name, type: 'user' },
      images: [{ url: `https://i.scdn.co/image/pl-${p.id}`, width: 300, height: 300 }],
      external_urls: { spotify: `https://open.spotify.com/playlist/${p.id}` },
      ...(this.cfg.shape === 'old' ? { tracks: count } : { items: count }),
    };
  }

  /**
   * New shape: `item`, plus the deprecated `track` alias (the reference lists both).
   * 'alias': only `track` (an /items endpoint still answering in the old shape). 'old': only `track`.
   */
  entryShape(e) {
    const { item, ...rest } = e;
    if (this.cfg.shape === 'new') return { ...rest, item, track: item };
    return { ...rest, track: item };
  }

  /** Honour the `fields` filter for which entry keys come back (enough to tell item( from track( ). */
  applyFields(entry, fields) {
    if (!fields) return entry;
    const inner = /items\((.*)\)\s*$/.exec(fields)?.[1] ?? '';
    const out = {};
    if (/(^|,)is_local/.test(inner) && 'is_local' in entry) out.is_local = entry.is_local;
    if (/(^|,)item\(/.test(inner) && 'item' in entry) out.item = entry.item;
    if (/(^|,)track\(/.test(inner) && 'track' in entry) out.track = entry.track;
    return out;
  }

  handle(method, path, q, body) {
    let m;
    if (method === 'GET' && path === '/me') return { status: 200, body: { ...ME, type: 'user', uri: `spotify:user:${ME.id}` } };
    if (method === 'GET' && path === '/me/playlists') return this.page(this.playlists.map((p) => this.playlistObj(p)), q, '/me/playlists');
    if (method === 'GET' && path === '/me/tracks') {
      const shaped = this.liked.map((e) => (this.cfg.shape === 'new' ? { added_at: e.added_at, item: e.track } : e));
      return this.page(shaped, q, '/me/tracks');
    }
    if (method === 'GET' && (m = path.match(/^\/playlists\/([^/]+)$/))) {
      const p = this.playlists.find((x) => x.id === m[1]);
      return p ? { status: 200, body: this.playlistObj(p) } : { status: 404, error: 'Not found' };
    }
    if (method === 'GET' && (m = path.match(/^\/playlists\/([^/]+)\/(items|tracks)$/))) {
      const p = this.playlists.find((x) => x.id === m[1]);
      if (!p) return { status: 404, error: 'Not found' };
      const wantItems = m[2] === 'items';
      if (this.cfg.shape === 'old' && wantItems) return { status: 404, error: 'Service not found' };
      if (this.cfg.shape === 'new' && !wantItems) return { status: 404, error: 'Service not found' };
      if (p.owner.id !== ME.id && !p.collaborative) return { status: 403, error: 'Forbidden' };
      if (this.cfg.fields400 && wantItems && q.fields) return { status: 400, error: 'Invalid fields' };
      return this.page(p.entries.map((e) => this.applyFields(this.entryShape(e), q.fields)), q, `/playlists/${p.id}/${m[2]}`);
    }
    if (path.startsWith('/me/player')) return this.playerApi(method, path, q, body);
    return { status: 404, error: `No fake for ${method} ${path}` };
  }

  // ---- player model ------------------------------------------------------------

  pos(p = this.player) {
    if (!p) return 0;
    return p.paused ? p.posMs : p.posMs + (Date.now() - p.at);
  }

  cur(p = this.player) {
    return p?.queue[p.idx] ?? null;
  }

  setPos(ms) {
    this.player.posMs = Math.max(0, ms);
    this.player.at = Date.now();
  }

  activeDevice() {
    return this.devices.find((d) => d.is_active) ?? null;
  }

  tick() {
    const p = this.player;
    if (!p || p.paused) return;
    const t = this.cur();
    if (t && this.pos() >= t.duration_ms) {
      if (p.repeat === 'track') this.setPos(0);
      else if (p.idx + 1 < p.queue.length) {
        p.idx++;
        this.setPos(0);
      } else if (p.repeat === 'context') {
        p.idx = 0;
        this.setPos(0);
      } else {
        p.paused = true;
        p.posMs = 0;
      }
      this.pushSdk();
    }
  }

  queueFor(body) {
    if (body?.context_uri) {
      const id = body.context_uri.split(':').pop();
      const pl = this.playlists.find((x) => x.id === id);
      if (!pl) return { error: 'Context not found' };
      const entries = pl.entries;
      // Spotify's offset.position counts playlist positions; build a queue of playable items with their positions.
      const queue = [];
      let start = 0;
      entries.forEach((e, pos) => {
        const it = e.item;
        if (!it || e.is_local || it.type !== 'track') return;
        if (body.offset?.position === pos) start = queue.length;
        if (body.offset?.uri && body.offset.uri === it.uri && start === 0 && !queue.some((q) => q.uri === it.uri)) start = queue.length;
        queue.push(this.relink(it));
      });
      return { queue, idx: start, contextUri: body.context_uri };
    }
    if (body?.uris) {
      const all = [...this.liked.map((e) => e.track), ...this.playlists.flatMap((p) => p.entries.map((e) => e.item).filter(Boolean))];
      const queue = body.uris.map((u) => all.find((t) => t.uri === u)).filter(Boolean).map((t) => this.relink(t));
      return { queue, idx: 0, contextUri: null };
    }
    return null;
  }

  playerApi(method, path, q, body) {
    const noDevice = { status: 404, error: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' };
    if (method === 'GET' && path === '/me/player/devices') return { status: 200, body: { devices: this.devices } };
    if (method === 'GET' && path === '/me/player') {
      if (!this.player || !this.activeDevice()) return { status: 204 };
      return { status: 200, body: this.webState() };
    }
    if (method === 'PUT' && path === '/me/player') {
      const id = body?.device_ids?.[0];
      const dev = this.devices.find((d) => d.id === id);
      if (!dev) return { status: 404, error: 'Device not found' };
      for (const d of this.devices) d.is_active = d.id === id;
      const old = this.player?.deviceId;
      if (this.player) {
        this.player.deviceId = id;
        if (body.play === true) {
          this.setPos(this.pos());
          this.player.paused = false;
        }
      }
      if (old === this.sdk.deviceId && id !== old) this.pushSdk(true);
      else {
        // SDK docs: on iOS "the playback does not start automatically after transferring playback".
        if (id === this.sdk.deviceId) this.startOnSdkMaybe();
        this.pushSdk();
      }
      return { status: 204 };
    }
    if (method === 'PUT' && path === '/me/player/play') {
      let devId = q.device_id;
      if (devId && !this.devices.some((d) => d.id === devId)) return { status: 404, error: 'Device not found' };
      if (!devId) devId = this.activeDevice()?.id;
      if (!devId) return noDevice;
      const prevDevice = this.player?.deviceId;
      for (const d of this.devices) d.is_active = d.id === devId;
      const qd = this.queueFor(body);
      if (qd?.error) return { status: 404, error: qd.error };
      if (qd) this.player = { deviceId: devId, contextUri: qd.contextUri, queue: qd.queue, idx: qd.idx, posMs: body?.position_ms ?? 0, at: Date.now(), paused: false, shuffle: this.player?.shuffle ?? false, repeat: this.player?.repeat ?? 'off' };
      else if (this.player) {
        this.player.deviceId = devId;
        this.setPos(this.pos());
        this.player.paused = false;
      } else return noDevice;
      if (prevDevice === this.sdk.deviceId && devId !== prevDevice) this.pushSdk(true);
      this.startOnSdkMaybe();
      this.pushSdk();
      return { status: 204 };
    }
    const dev = this.activeDevice();
    const target = q.device_id ? this.devices.find((d) => d.id === q.device_id) : dev;
    if (!target || !this.player) return noDevice;
    const p = this.player;
    if (method === 'PUT' && path === '/me/player/pause') {
      p.posMs = this.pos();
      p.paused = true;
    } else if (method === 'POST' && path === '/me/player/next') this.skip(1);
    else if (method === 'POST' && path === '/me/player/previous') this.skip(-1);
    else if (method === 'PUT' && path === '/me/player/seek') this.setPos(Number(q.position_ms));
    else if (method === 'PUT' && path === '/me/player/shuffle') p.shuffle = q.state === 'true';
    else if (method === 'PUT' && path === '/me/player/repeat') p.repeat = q.state;
    else if (method === 'PUT' && path === '/me/player/volume') {
      if (!target.supports_volume) return { status: 403, error: 'Cannot control device volume', reason: 'VOLUME_CONTROL_DISALLOW' };
      target.volume_percent = Number(q.volume_percent);
    } else return { status: 404, error: `No fake for ${method} ${path}` };
    this.pushSdk();
    return { status: 204 };
  }

  skip(d) {
    const p = this.player;
    if (d < 0 && this.pos() > 3000) return this.setPos(0);
    p.idx = Math.max(0, Math.min(p.queue.length - 1, p.idx + d));
    this.setPos(0);
  }

  disallows() {
    const p = this.player;
    return { skipping_prev: !!p && p.idx === 0 && this.pos() <= 3000, ...(this.cfg.extraDisallows ?? {}) };
  }

  webState() {
    const p = this.player;
    const t = this.cur();
    const dev = this.devices.find((d) => d.id === p.deviceId);
    // New-app shape: no linked_from on the track object.
    return {
      device: dev,
      shuffle_state: p.shuffle,
      repeat_state: p.repeat,
      timestamp: Date.now(),
      context: p.contextUri ? { uri: p.contextUri, type: 'playlist' } : null,
      progress_ms: this.pos(),
      is_playing: !p.paused,
      item: t && (({ linked_from, ...rest }) => rest)(t),
      currently_playing_type: 'track',
      actions: this.cfg.actionsFlat ? { ...this.disallows() } : { disallows: this.disallows() },
    };
  }

  sdkState() {
    const p = this.player;
    if (!p || p.deviceId !== this.sdk.deviceId) return null;
    const t = this.cur();
    const track = (x) => x && ({
      uri: x.uri, id: x.id, type: 'track', media_type: 'audio', name: x.name, is_playable: true, duration_ms: x.duration_ms,
      album: { uri: x.album.uri, name: x.album.name, images: x.album.images.map((i) => ({ url: i.url, width: i.width, height: i.height })) },
      artists: x.artists.map((a) => ({ name: a.name, uri: a.uri })),
      ...(x.linked_from ? { linked_from: x.linked_from } : {}),
    });
    return {
      timestamp: Date.now(),
      context: { uri: p.contextUri, metadata: {} },
      disallows: this.disallows(),
      paused: p.paused,
      position: this.pos(),
      duration: t?.duration_ms ?? 0,
      repeat_mode: p.repeat === 'context' ? 1 : p.repeat === 'track' ? 2 : 0,
      shuffle: p.shuffle,
      track_window: { current_track: track(t), previous_tracks: p.queue.slice(Math.max(0, p.idx - 2), p.idx).map(track), next_tracks: p.queue.slice(p.idx + 1, p.idx + 3).map(track) },
    };
  }

  /** Playback started on the SDK device: without an activated element it arrives paused (autoplay_failed). */
  startOnSdkMaybe() {
    const p = this.player;
    if (!p || p.deviceId !== this.sdk.deviceId) return;
    const blocked = this.cfg.sdk === 'autoplay_strict' || !this.sdk.activated;
    if (blocked && !p.paused) {
      p.posMs = this.pos();
      p.paused = true;
      this.sdkEmit('autoplay_failed', null);
    }
  }

  pushSdk(inactive = false) {
    if (!this.sdk.page || !this.sdk.deviceId) return;
    const st = inactive ? null : this.sdkState();
    if (!inactive && !st) return;
    this.sdkEmit('player_state_changed', st);
  }

  sdkEmit(ev, payload) {
    this.sdk.events.push(ev);
    const page = this.sdk.page;
    if (!page || page.isClosed()) return;
    setTimeout(() => page.evaluate(([e, p]) => window.__fakeSdkPush?.(e, p), [ev, payload]).catch(() => undefined), 30);
  }

  // ---- SDK stub ------------------------------------------------------------------

  async binding(page, cmd, arg) {
    if (cmd === 'register') {
      const exp = this.access.get(arg.token);
      if (!exp || exp < Date.now()) return { error: 'authentication_error' };
      // The SDK guide: streaming, user-read-email and user-read-private are required.
      const scopes = (this.scopeOf.get(arg.token) ?? '').split(' ');
      if (!['streaming', 'user-read-email', 'user-read-private'].every((x) => scopes.includes(x))) return { error: 'authentication_error' };
      this.sdk.connects = (this.sdk.connects ?? 0) + 1;
      if (this.cfg.sdkAuthFailOnReconnect && this.sdk.connects > 1) return { error: 'authentication_error' };
      this.sdk.page = page;
      if (this.sdk.deviceId && this.devices.some((d) => d.id === this.sdk.deviceId)) return { device_id: this.sdk.deviceId };
      this.sdk.deviceId = this.sdk.deviceId ?? `sdkdevice${rnd(10)}`;
      this.sdk.events.push('register');
      this.devices = this.devices.filter((d) => d.type !== 'Computer');
      this.devices.push({ id: this.sdk.deviceId, is_active: false, is_private_session: false, is_restricted: false, name: arg.name, type: 'Computer', volume_percent: 100, supports_volume: true });
      return { device_id: this.sdk.deviceId };
    }
    if (cmd === 'disconnected') {
      // Real SDK: disconnect() drops the device; a later connect() brings it back (same id here).
      this.sdk.events.push('disconnect');
      this.devices = this.devices.filter((d) => d.id !== this.sdk.deviceId);
      if (this.player?.deviceId === this.sdk.deviceId) this.player = null;
      return null;
    }
    if (cmd === 'unregister') {
      this.devices = this.devices.filter((d) => d.id !== this.sdk.deviceId);
      this.sdk.deviceId = null;
      return null;
    }
    if (cmd === 'activate') {
      this.sdk.events.push(`activate:${arg.active}`);
      if (arg.active) this.sdk.activated = true;
      return null;
    }
    if (cmd === 'state') {
      const st = this.sdkState();
      if (st && this.cfg.sdkStaleMs) {
        // A snapshot from sdkStaleMs ago: position and timestamp both as of then.
        st.timestamp = Date.now() - this.cfg.sdkStaleMs;
        if (!st.paused) st.position = Math.max(0, st.position - this.cfg.sdkStaleMs);
      }
      return st;
    }
    if (cmd === 'cmd') {
      const p = this.player;
      if (!p || p.deviceId !== this.sdk.deviceId) return null;
      this.sdk.events.push(`cmd:${arg.cmd}`);
      if (this.cfg.sdkHang.includes(arg.cmd)) return new Promise(() => undefined);
      if (arg.cmd === 'pause') {
        p.posMs = this.pos();
        p.paused = true;
      } else if (arg.cmd === 'resume') {
        this.setPos(this.pos());
        p.paused = false;
        this.startOnSdkMaybe();
      } else if (arg.cmd === 'seek') this.setPos(arg.ms);
      else if (arg.cmd === 'next') this.skip(1);
      else if (arg.cmd === 'prev') this.skip(-1);
      this.pushSdk();
      return null;
    }
    return null;
  }

  sdkScript(route) {
    this.log.push({ method: 'GET', path: 'sdk.scdn.co' + new URL(route.request().url()).pathname });
    if (this.cfg.sdk === 'no_script') return route.abort('failed');
    const cfg = { mode: this.cfg.sdk, iosVolume: this.cfg.iosVolume, readyDelay: this.cfg.sdkReadyDelayMs ?? 60 };
    const src = `(() => {
  const CFG = ${JSON.stringify(cfg)};
  const call = (cmd, arg) => window.__fakeSpotify(cmd, arg);
  const instances = [];
  class Player {
    constructor(o) { this._o = o; this._l = {}; this._vol = o.volume ?? 1; instances.push(this); }
    addListener(e, cb) { (this._l[e] ||= []).push(cb); return true; }
    on(e, cb) { return this.addListener(e, cb); }
    removeListener(e, cb) { if (!cb) delete this._l[e]; else this._l[e] = (this._l[e] || []).filter((x) => x !== cb); return true; }
    _emit(e, a) { for (const cb of this._l[e] || []) { try { cb(a); } catch (err) { console.error(err); } } }
    async connect() {
      const token = await new Promise((r) => this._o.getOAuthToken(r));
      if (CFG.mode === 'init_error') { setTimeout(() => this._emit('initialization_error', { message: 'Failed to initialize player' }), 50); return true; }
      if (CFG.mode === 'account_error') { setTimeout(() => this._emit('account_error', { message: 'This functionality is restricted to premium users only' }), 50); return true; }
      const r = await call('register', { token, name: this._o.name });
      if (r && r.error) { setTimeout(() => this._emit('authentication_error', { message: 'Invalid token scopes.' }), 30); return true; }
      setTimeout(() => this._emit('ready', { device_id: r.device_id }), CFG.readyDelay);
      return true;
    }
    disconnect() { call('disconnected'); }
    getCurrentState() { return call('state'); }
    setName() { return Promise.resolve(); }
    getVolume() { return Promise.resolve(CFG.iosVolume ? 1 : this._vol); }
    setVolume(v) { if (!CFG.iosVolume) this._vol = v; return Promise.resolve(); }
    pause() { return call('cmd', { cmd: 'pause' }); }
    resume() { return call('cmd', { cmd: 'resume' }); }
    togglePlay() { return call('cmd', { cmd: 'toggle' }); }
    seek(ms) { return call('cmd', { cmd: 'seek', ms }); }
    previousTrack() { return call('cmd', { cmd: 'prev' }); }
    nextTrack() { return call('cmd', { cmd: 'next' }); }
    activateElement() { const active = !!(navigator.userActivation && navigator.userActivation.isActive); call('activate', { active }); return Promise.resolve(); }
  }
  window.__fakeSdkPush = (e, p) => { for (const i of instances) i._emit(e, p); };
  window.Spotify = { Player };
  setTimeout(() => window.onSpotifyWebPlaybackSDKReady && window.onSpotifyWebPlaybackSDKReady(), 10);
})();`;
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: src });
  }
}
