import { ACCOUNTS_ORIGIN, SCOPES } from './config';
import { diag, registerSecret } from './diag';

/**
 * Authorization Code + PKCE (S256), no client secret.
 *
 * Storage (localStorage, same origin as the redirect URI):
 *   duoamp.spotify.tokens.v1  access/refresh token, expiry, first-authorised date
 *   duoamp.spotify.pkce.v1    verifier + state while the browser is away at Spotify
 * The PKCE record is written to localStorage and sessionStorage: localStorage
 * survives the redirect in Safari and in a home-screen (standalone) app as long
 * as the round trip stays in the same window, which it does (location.assign).
 */

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** ms epoch */
  expiresAt: number;
  scope: string;
  /** ms epoch of the original consent; refresh tokens die 6 months after this. */
  firstAuthorizedAt: number;
  clientId: string;
}

interface Pending {
  verifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  /** Non-OAuth query string to restore after the round trip (e.g. "?layout=book"). */
  returnSearch: string;
  createdAt: number;
}

export interface AuthCallback {
  code?: string;
  state?: string;
  error?: string;
}

export type AuthErrorCode = 'signed_out' | 'invalid_grant' | 'state_mismatch' | 'no_pending' | 'access_denied' | 'exchange_failed' | 'network' | 'crypto_unavailable';

export class AuthError extends Error {
  constructor(public code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const TOKENS_KEY = 'duoamp.spotify.tokens.v1';
const PKCE_KEY = 'duoamp.spotify.pkce.v1';
/** Refresh this long before expiry. */
const REFRESH_MARGIN_MS = 60_000;
/** A login attempt older than this is ignored. */
const PENDING_MAX_AGE_MS = 30 * 60_000;
export const REFRESH_TOKEN_LIFETIME_MS = 182 * 24 * 3600_000;

function readJson<T>(key: string): T | null {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const s = store.getItem(key);
      if (s) return JSON.parse(s) as T;
    } catch {
      /* unavailable / corrupt */
    }
  }
  return null;
}

function writeJson(key: string, v: unknown, both = false) {
  const s = JSON.stringify(v);
  try {
    localStorage.setItem(key, s);
  } catch {
    /* fall through to session storage */
  }
  if (both) {
    try {
      sessionStorage.setItem(key, s);
    } catch {
      /* ignore */
    }
  }
}

function remove(key: string) {
  for (const store of [localStorage, sessionStorage]) {
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
function randomString(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += UNRESERVED[b % UNRESERVED.length];
  return out;
}

export async function codeChallenge(verifier: string): Promise<string> {
  if (!crypto?.subtle) throw new AuthError('crypto_unavailable', 'This page is not a secure context (needs HTTPS or 127.0.0.1).');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

const OAUTH_PARAMS = ['code', 'state', 'error', 'error_description'];

/**
 * If the page was loaded as the OAuth return (?code=&state= or ?error=), take
 * the parameters and clean the URL immediately (history.replaceState), restoring
 * the query string the app had before it left. Call before anything reads the URL.
 */
export function takeAuthCallback(): AuthCallback | null {
  const q = new URLSearchParams(location.search);
  const code = q.get('code') ?? undefined;
  const error = q.get('error') ?? undefined;
  const state = q.get('state') ?? undefined;
  if (!(code && state) && !error) return null;
  const pending = readJson<Pending>(PKCE_KEY);
  let search = pending?.returnSearch ?? '';
  if (!pending) {
    for (const k of OAUTH_PARAMS) q.delete(k);
    const rest = q.toString();
    search = rest ? `?${rest}` : '';
  }
  history.replaceState(null, '', `${location.pathname}${search}${location.hash}`);
  return { code, state, error };
}

type Fetch = typeof fetch;

export class SpotifyAuth {
  private tokens: TokenSet | null;
  private refreshing: Promise<TokenSet> | null = null;
  private listeners = new Set<() => void>();
  /** Why the user was last signed out, for the connect sheet. */
  lastSignOutReason: string | null = null;
  refreshCount = 0;

  constructor(private fetchImpl: Fetch = (...a) => fetch(...a)) {
    this.tokens = this.load();
    window.addEventListener('storage', (e) => {
      // Another tab refreshed or signed out.
      if (e.key === TOKENS_KEY) {
        this.tokens = this.load();
        this.emit();
      }
    });
  }

  private load(): TokenSet | null {
    const t = readJson<TokenSet>(TOKENS_KEY);
    if (!t || typeof t.accessToken !== 'string' || typeof t.refreshToken !== 'string') return null;
    registerSecret(t.accessToken);
    registerSecret(t.refreshToken);
    return t;
  }

  private save(t: TokenSet | null) {
    this.tokens = t;
    if (t) {
      registerSecret(t.accessToken);
      registerSecret(t.refreshToken);
      writeJson(TOKENS_KEY, t);
    } else remove(TOKENS_KEY);
    this.emit();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  get signedIn(): boolean {
    return this.tokens !== null;
  }

  /** Safe-to-show token facts (no token values). */
  info() {
    const t = this.tokens;
    if (!t) return null;
    return {
      expiresAt: t.expiresAt,
      firstAuthorizedAt: t.firstAuthorizedAt,
      refreshExpiresAt: t.firstAuthorizedAt + REFRESH_TOKEN_LIFETIME_MS,
      scope: t.scope,
      clientId: t.clientId,
    };
  }

  /** Start sign-in: store verifier/state, then navigate to Spotify in this window. */
  async beginLogin(clientId: string, redirectUri: string, navigate: (url: string) => void = (u) => location.assign(u)) {
    const verifier = randomString(64);
    const state = randomString(24);
    registerSecret(verifier);
    const challenge = await codeChallenge(verifier);
    const q = new URLSearchParams(location.search);
    for (const k of OAUTH_PARAMS) q.delete(k);
    const rest = q.toString();
    const pending: Pending = { verifier, state, clientId, redirectUri, returnSearch: rest ? `?${rest}` : '', createdAt: Date.now() };
    writeJson(PKCE_KEY, pending, true);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES.join(' '),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      redirect_uri: redirectUri,
      state,
    });
    diag.info('auth', `redirecting to Spotify sign-in (redirect_uri ${redirectUri})`);
    navigate(`${ACCOUNTS_ORIGIN}/authorize?${params}`);
  }

  /** Finish sign-in from the callback parameters. Throws AuthError. */
  async completeLogin(cb: AuthCallback): Promise<void> {
    const pending = readJson<Pending>(PKCE_KEY);
    remove(PKCE_KEY);
    if (cb.code) registerSecret(cb.code);
    if (cb.error) {
      const code: AuthErrorCode = cb.error === 'access_denied' ? 'access_denied' : 'exchange_failed';
      diag.warn('auth', `sign-in returned error "${cb.error}"`);
      throw new AuthError(code, cb.error === 'access_denied' ? 'SIGN-IN CANCELLED' : `SIGN-IN FAILED (${cb.error.toUpperCase()})`);
    }
    if (!pending || Date.now() - pending.createdAt > PENDING_MAX_AGE_MS) {
      diag.warn('auth', 'callback without a pending sign-in in this browser storage');
      throw new AuthError('no_pending', 'SIGN-IN WAS STARTED IN ANOTHER WINDOW OR EXPIRED. TAP CONNECT AGAIN HERE.');
    }
    registerSecret(pending.verifier);
    if (cb.state !== pending.state) {
      diag.error('auth', 'state mismatch on callback; ignoring the code');
      throw new AuthError('state_mismatch', 'SIGN-IN REJECTED (STATE MISMATCH). TRY AGAIN.');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: cb.code!,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    });
    const t = await this.tokenRequest(body, pending.clientId, null);
    this.lastSignOutReason = null;
    this.save(t);
    diag.info('auth', `signed in; access token valid until ${new Date(t.expiresAt).toISOString()}`);
  }

  private async tokenRequest(body: URLSearchParams, clientId: string, prev: TokenSet | null): Promise<TokenSet> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${ACCOUNTS_ORIGIN}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      diag.warn('auth', 'token request failed: network error');
      throw new AuthError('network', 'NETWORK ERROR TALKING TO SPOTIFY');
    }
    let json: Record<string, unknown> = {};
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = String(json.error ?? res.status);
      diag.warn('auth', `token endpoint ${res.status} ${err}`);
      if (res.status === 400 && err === 'invalid_grant') throw new AuthError('invalid_grant', 'SPOTIFY SIGN-IN EXPIRED. PLEASE CONNECT AGAIN.');
      throw new AuthError('exchange_failed', `SPOTIFY SIGN-IN FAILED (${err.toUpperCase()})`);
    }
    const access = String(json.access_token ?? '');
    const refresh = typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : prev?.refreshToken;
    if (!access || !refresh) throw new AuthError('exchange_failed', 'SPOTIFY SIGN-IN FAILED (NO TOKEN)');
    const expiresIn = Number(json.expires_in) || 3600;
    return {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Date.now() + expiresIn * 1000,
      scope: String(json.scope ?? prev?.scope ?? ''),
      firstAuthorizedAt: prev?.firstAuthorizedAt ?? Date.now(),
      clientId,
    };
  }

  /** A valid access token, refreshed first if it expires within a minute. Throws AuthError. */
  async getAccessToken(): Promise<string> {
    const t = this.tokens;
    if (!t) throw new AuthError('signed_out', 'NOT SIGNED IN');
    if (t.expiresAt - Date.now() > REFRESH_MARGIN_MS) return t.accessToken;
    return (await this.refresh()).accessToken;
  }

  /**
   * Refresh the access token. Concurrent callers share one request. On
   * invalid_grant (refresh token expired or revoked) the user is signed out.
   * `staleToken`: the token that just got a 401; if another request has already
   * replaced it, no new refresh is made.
   */
  refresh(staleToken?: string): Promise<TokenSet> {
    if (this.refreshing) return this.refreshing;
    const t = this.tokens;
    if (!t) return Promise.reject(new AuthError('signed_out', 'NOT SIGNED IN'));
    if (staleToken && t.accessToken !== staleToken && t.expiresAt - Date.now() > REFRESH_MARGIN_MS) return Promise.resolve(t);
    this.refreshing = (async () => {
      try {
        this.refreshCount++;
        const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId });
        const next = await this.tokenRequest(body, t.clientId, t);
        // Signed out while the request was in flight: drop the result.
        if (!this.tokens) throw new AuthError('signed_out', 'NOT SIGNED IN');
        this.save(next);
        diag.info('auth', `token refreshed; valid until ${new Date(next.expiresAt).toISOString()}`);
        return next;
      } catch (e) {
        if (e instanceof AuthError && e.code === 'invalid_grant') {
          this.signOut('SPOTIFY SIGN-IN EXPIRED. PLEASE CONNECT AGAIN.');
        }
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  signOut(reason: string | null = null) {
    this.lastSignOutReason = reason;
    remove(PKCE_KEY);
    if (this.tokens) diag.info('auth', reason ? `signed out: ${reason}` : 'signed out');
    this.save(null);
  }
}
