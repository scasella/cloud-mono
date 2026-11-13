/** Spotify endpoints, scopes, Client ID and the redirect URI rule. */

export const ACCOUNTS_ORIGIN = 'https://accounts.spotify.com';
export const API_ORIGIN = 'https://api.spotify.com';
export const API_BASE = `${API_ORIGIN}/v1`;
export const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

export const SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-read-private',
] as const;

/** Name this browser shows up under in Spotify Connect device lists. */
export const DEVICE_NAME = 'DuoAmp';

const CLIENT_ID_KEY = 'duoamp.spotify.clientId';

/** Spotify Client IDs are 32 hex characters. */
export function isValidClientId(id: string): boolean {
  return /^[0-9a-f]{32}$/i.test(id.trim());
}

/** Client ID baked in at build time (VITE_SPOTIFY_CLIENT_ID), if any. Not a secret. */
export function builtInClientId(): string | null {
  const v = (import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined)?.trim();
  return v && isValidClientId(v) ? v : null;
}

/** Build-time Client ID if set, otherwise the one typed into the connect sheet. */
export function getClientId(): string | null {
  const b = builtInClientId();
  if (b) return b;
  try {
    const v = localStorage.getItem(CLIENT_ID_KEY);
    return v && isValidClientId(v) ? v.trim() : null;
  } catch {
    return null;
  }
}

export function setStoredClientId(id: string | null) {
  try {
    if (id) localStorage.setItem(CLIENT_ID_KEY, id.trim());
    else localStorage.removeItem(CLIENT_ID_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * The redirect URI is the app's own base URL:
 *   scheme + host + port (as URL normalises them: lower-case host, default port dropped)
 *   + the directory of the page, always ending in "/".
 * A trailing file name ("index.html") is dropped; query and hash are never part of it.
 * A last path segment without a dot is treated as a directory, so
 * "/cloud-mono" and "/cloud-mono/" both give ".../cloud-mono/".
 *
 *   https://scasella.github.io/cloud-mono/index.html?x=1  -> https://scasella.github.io/cloud-mono/
 *   http://127.0.0.1:5173/?layout=book                    -> http://127.0.0.1:5173/
 *
 * Path case is kept exactly as served (Spotify compares it case-sensitively).
 */
export function computeRedirectUri(loc: { protocol: string; host: string; pathname: string } = location): string {
  const u = new URL(`${loc.protocol}//${loc.host}`);
  let path = loc.pathname || '/';
  // Collapse duplicate slashes so "//app//" and "/app/" agree.
  path = path.replace(/\/{2,}/g, '/');
  const segs = path.split('/');
  const last = segs[segs.length - 1];
  if (last && last.includes('.')) segs.pop();
  path = segs.join('/');
  if (!path.endsWith('/')) path += '/';
  if (!path.startsWith('/')) path = '/' + path;
  return `${u.protocol}//${u.host}${path}`;
}

let cachedRedirect: string | null = null;
/** Computed once per page load, from the location at startup. */
export function redirectUri(): string {
  if (!cachedRedirect) cachedRedirect = computeRedirectUri();
  return cachedRedirect;
}

/** Problems Spotify will reject the redirect URI for, as short upper-case hints. */
export function redirectUriProblem(uri: string): { text: string; fix?: string } | null {
  const u = new URL(uri);
  if (u.hostname === 'localhost') {
    const alt = uri.replace('//localhost', '//127.0.0.1');
    return { text: 'SPOTIFY REJECTS "LOCALHOST". OPEN THE 127.0.0.1 ADDRESS INSTEAD.', fix: alt };
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !loopback) return { text: 'SPOTIFY NEEDS HTTPS FOR THIS ADDRESS (PLAIN HTTP ONLY WORKS ON 127.0.0.1).' };
  return null;
}
