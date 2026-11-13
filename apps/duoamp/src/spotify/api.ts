import { API_BASE, API_ORIGIN } from './config';
import { AuthError, type SpotifyAuth } from './auth';
import { diag } from './diag';

export type ApiErrorKind =
  | 'auth' // signed out / refresh failed
  | 'forbidden' // 403 (not allow-listed, not owner of playlist, premium required...)
  | 'premium_required'
  | 'not_found'
  | 'no_active_device'
  | 'rate_limited'
  | 'bad_request'
  | 'server'
  | 'network';

export class SpotifyApiError extends Error {
  constructor(
    public kind: ApiErrorKind,
    public status: number,
    message: string,
    public reason?: string,
    public path?: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

export interface RequestOpts {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Max automatic retries after 429 (default 3). */
  max429Retries?: number;
  /**
   * Player command: wait at most a few seconds for a rate-limit block (a late
   * pause/next is worse than a failed one), and never longer than the engine's
   * command timeout.
   */
  command?: boolean;
}

type Fetch = typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest Retry-After we wait through automatically; beyond this the error is surfaced. */
const MAX_AUTO_WAIT_S = 30;
const COMMAND_MAX_WAIT_S = 3;

/** Strip ids out of a path for logging: /playlists/abc/items -> /playlists/{id}/items */
function logPath(path: string): string {
  return path.replace(/^https:\/\/api\.spotify\.com\/v1/, '').replace(/\?.*$/, '').replace(/\/(playlists|tracks|albums|artists)\/[^/]+/g, '/$1/{id}');
}

/**
 * Bearer-authenticated Web API client: refresh-and-retry once on 401, honours
 * 429 Retry-After (globally: the quota is shared, so every request waits),
 * retries one 5xx for GETs, maps errors to typed SpotifyApiErrors.
 */
export class SpotifyApi {
  /** ms epoch before which no request is sent (after a 429). */
  private blockedUntil = 0;
  /** Spotify's reason for the current block (e.g. QUOTA_EXCEEDED), reused by fast failures. */
  private blockedReason: string | undefined;
  lastErrors: Array<{ t: number; status: number; path: string; reason?: string }> = [];
  requestCount = 0;

  constructor(private auth: SpotifyAuth, private fetchImpl: Fetch = (...a) => fetch(...a)) {}

  url(path: string, query?: RequestOpts['query']): string {
    const u = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
    if (u.origin !== API_ORIGIN) throw new SpotifyApiError('bad_request', 0, 'refusing non-Spotify URL');
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.toString();
  }

  get<T>(path: string, opts: RequestOpts = {}) {
    return this.request<T>('GET', path, opts);
  }
  put<T>(path: string, opts: RequestOpts = {}) {
    return this.request<T>('PUT', path, opts);
  }
  post<T>(path: string, opts: RequestOpts = {}) {
    return this.request<T>('POST', path, opts);
  }

  async request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T | null> {
    const url = this.url(path, opts.query);
    let retried401 = false;
    let retried5xx = false;
    let n429 = 0;
    for (;;) {
      const wait = this.blockedUntil - Date.now();
      const maxWait = (opts.command ? COMMAND_MAX_WAIT_S : MAX_AUTO_WAIT_S) * 1000;
      if (wait > maxWait) {
        // Blocked for longer than we are willing to hold a request: fail fast instead of piling up.
        const secs = Math.ceil(wait / 1000);
        const quota = this.blockedReason === 'QUOTA_EXCEEDED';
        throw new SpotifyApiError('rate_limited', 429, quota ? `SPOTIFY QUOTA EXCEEDED, TRY AGAIN IN ${secs} S` : `SPOTIFY IS RATE LIMITING, TRY AGAIN IN ${secs} S`, this.blockedReason ?? 'BLOCKED', path, secs);
      }
      if (wait > 0) await sleep(wait);
      let token: string;
      try {
        token = await this.auth.getAccessToken();
      } catch (e) {
        throw this.authError(e, path);
      }
      let res: Response;
      try {
        this.requestCount++;
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch {
        this.record(0, path, 'network');
        throw new SpotifyApiError('network', 0, 'NETWORK ERROR', undefined, path);
      }
      if (res.status === 401 && !retried401) {
        retried401 = true;
        this.record(401, path, 'token refreshed, retried');
        diag.info('api', `401 on ${method} ${logPath(path)}; refreshing token`);
        try {
          await this.auth.refresh(token);
        } catch (e) {
          throw this.authError(e, path);
        }
        continue;
      }
      if (res.status === 429) {
        const body = await this.readBody(res);
        const reason = this.reasonOf(body);
        // Retry-After is only readable cross-origin if Spotify exposes it (CORS);
        // when it is not readable, back off exponentially instead (2, 4, 8 s).
        const raw = res.headers.get('Retry-After');
        const ra = raw === null || raw.trim() === '' ? NaN : Number(raw);
        const secs = Number.isFinite(ra) && ra >= 0 ? ra : Math.min(MAX_AUTO_WAIT_S, 2 ** (n429 + 1));
        if (Date.now() + secs * 1000 >= this.blockedUntil) this.blockedReason = reason;
        this.blockedUntil = Math.max(this.blockedUntil, Date.now() + secs * 1000);
        this.record(429, path, reason ?? `retry-after ${secs}s`);
        diag.warn('api', `429 on ${method} ${logPath(path)}; Retry-After ${secs}s${reason ? ` (${reason})` : ''}`);
        if (n429 < (opts.max429Retries ?? 3) && secs <= (opts.command ? COMMAND_MAX_WAIT_S : MAX_AUTO_WAIT_S)) {
          n429++;
          continue;
        }
        throw new SpotifyApiError('rate_limited', 429, reason === 'QUOTA_EXCEEDED' ? 'SPOTIFY QUOTA EXCEEDED, TRY LATER' : 'SPOTIFY IS BUSY, TRY AGAIN SHORTLY', reason, path, secs);
      }
      if (res.status >= 500 && method === 'GET' && !retried5xx) {
        retried5xx = true;
        this.record(res.status, path);
        await sleep(800);
        continue;
      }
      if (res.status === 204 || res.status === 202) return null;
      const body = await this.readBody(res);
      if (res.ok) return (body ?? null) as T | null;
      throw this.httpError(res.status, body, method, path);
    }
  }

  private async readBody(res: Response): Promise<unknown> {
    const text = await res.text().catch(() => '');
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private reasonOf(body: unknown): string | undefined {
    const e = (body as { error?: { reason?: unknown } } | null)?.error;
    return typeof e?.reason === 'string' ? e.reason : undefined;
  }

  private record(status: number, path: string, reason?: string) {
    this.lastErrors.push({ t: Date.now(), status, path: logPath(path), reason });
    if (this.lastErrors.length > 20) this.lastErrors.shift();
  }

  /** True while there are tokens; false once signed out (refresh token expired/revoked, or DISCONNECT). */
  get signedIn() {
    return this.auth.signedIn;
  }

  private authError(e: unknown, path: string): SpotifyApiError {
    // A refresh that failed for lack of network is a network problem, not a sign-in problem.
    if (e instanceof AuthError && e.code === 'network') {
      this.record(0, path, 'token refresh: network');
      return new SpotifyApiError('network', 0, 'NETWORK ERROR', 'token_refresh', path);
    }
    const msg = e instanceof AuthError ? e.message : 'NOT SIGNED IN';
    return new SpotifyApiError('auth', 401, msg, e instanceof AuthError ? e.code : undefined, path);
  }

  private httpError(status: number, body: unknown, method: string, path: string): SpotifyApiError {
    const reason = this.reasonOf(body);
    const apiMsg = String((body as { error?: { message?: unknown } } | null)?.error?.message ?? '');
    this.record(status, path, reason ?? (apiMsg || undefined));
    diag.warn('api', `${status} on ${method} ${logPath(path)}${reason ? ` ${reason}` : ''}${apiMsg ? ` "${apiMsg.slice(0, 80)}"` : ''}`);
    if (status === 404 && (reason === 'NO_ACTIVE_DEVICE' || /no active device/i.test(apiMsg) || /\/me\/player/.test(path))) {
      return new SpotifyApiError('no_active_device', 404, 'NO ACTIVE SPOTIFY DEVICE. OPEN SPOTIFY, PLAY SOMETHING, THEN RETRY.', reason ?? 'NO_ACTIVE_DEVICE', path);
    }
    if (status === 403 && (reason === 'PREMIUM_REQUIRED' || /premium/i.test(apiMsg))) {
      return new SpotifyApiError('premium_required', 403, 'SPOTIFY PREMIUM IS NEEDED FOR PLAYBACK CONTROL', reason, path);
    }
    if (status === 403) return new SpotifyApiError('forbidden', 403, 'SPOTIFY REFUSED THIS REQUEST', reason, path);
    if (status === 404) return new SpotifyApiError('not_found', 404, 'NOT FOUND ON SPOTIFY', reason, path);
    if (status === 401) return new SpotifyApiError('auth', 401, 'SPOTIFY SIGN-IN NO LONGER VALID', reason, path);
    if (status >= 500) return new SpotifyApiError('server', status, 'SPOTIFY SERVER ERROR', reason, path);
    return new SpotifyApiError('bad_request', status, `SPOTIFY ERROR ${status}`, reason, path);
  }

  /**
   * Fetch a paged collection, following `next` (limit max 50), calling
   * `onPage` with each page's raw items as it arrives.
   */
  async paginate<E>(
    path: string,
    query: RequestOpts['query'],
    onPage: (items: E[], page: { total: number; offset: number }) => void | boolean,
    signal?: { aborted: boolean },
  ): Promise<number> {
    let next: string | null = this.url(path, { limit: 50, ...query });
    let total = 0;
    while (next) {
      if (signal?.aborted) break;
      const page: { items?: E[]; next?: string | null; total?: number; offset?: number } | null = await this.get(next);
      const items = page?.items ?? [];
      total = page?.total ?? total;
      if (onPage(items, { total, offset: page?.offset ?? 0 }) === false) break;
      next = page?.next ?? null;
      if (next && !next.startsWith(API_ORIGIN)) next = null;
    }
    return total;
  }
}
