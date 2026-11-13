# DuoAmp

A retro "amp"-style music player web app for the iPhone Duo foldable, with
layouts for each fold posture (cover, book, tabletop) and two skins (light,
classic). Signed out, it plays a silent demo library on a mock engine. Signed
in to Spotify, it plays your playlists and Liked Songs, either in the browser
(Web Playback SDK) or by remote-controlling the Spotify app (Spotify Connect).

## Run

```sh
npm install
npm run dev          # http://localhost:5173 (demo only: Spotify rejects "localhost")
npm run dev:spotify  # http://127.0.0.1:5173/  <- use this one with Spotify
npm run build        # tsc --noEmit + vite build -> dist/
npm run preview
```

On a desktop or tablet-sized window the app renders inside a drawn device
(the simulator) with posture and skin buttons underneath. On a phone-sized
viewport it renders full-bleed.

Review tooling (uses the preinstalled Playwright; not a dependency):

```sh
npm run check            # drives the UI (demo engine) and asserts state changes
npm run check:spotify    # the Spotify phase, against a FAKE Spotify (see below)
node scripts/screenshots.mjs   # every posture x skin, plus Spotify sheets -> screenshots/
npm run build:font       # regenerate the DuoPixel font from fonts/duopixel-glyphs.mjs
npm run build:icons      # regenerate the home-screen icons in public/
```

## Spotify

### What you need

- A Spotify account with **Premium** (playback needs it; the app cannot check
  this up front, so you find out from a clear message on first play).
- A Spotify developer app. Development-mode apps allow up to 5 listed users.

### Spotify developer dashboard checklist

1. Go to <https://developer.spotify.com/dashboard>, **Create app**.
2. Tick **Web API** and **Web Playback SDK**.
3. **Redirect URIs**: add the exact URI(s) you will open the app from (rule below):
   - deployed: `https://scasella.github.io/cloud-mono/`
   - local: `http://127.0.0.1:5173/` (and `http://127.0.0.1:4173/` if you use `npm run preview`)
4. Save, then open **User Management** and add the Spotify account(s) that will
   use the app (name + the account's email). Others get "403" errors.
5. Copy the **Client ID** (not the secret; PKCE apps have no secret). Either
   paste it into DuoAmp's connect sheet, or set it at build time (below).

### Redirect URI rule

The redirect URI is the app's own base URL, computed once from `location` at
startup (`src/spotify/config.ts`, `computeRedirectUri`):

`scheme://host[:port]` + the directory of the page, always ending in `/`.
A trailing file name (`index.html`) is dropped, a last segment without a dot is
treated as a directory, duplicate slashes are collapsed, the host is
lower-cased, and the query and hash are never part of it. Path case is kept.

| Opened at | Redirect URI |
| --- | --- |
| `https://scasella.github.io/cloud-mono/` | `https://scasella.github.io/cloud-mono/` |
| `https://scasella.github.io/cloud-mono/index.html?x=1` | `https://scasella.github.io/cloud-mono/` |
| `http://127.0.0.1:5173/?layout=book` | `http://127.0.0.1:5173/` |
| `http://localhost:5173/` | `http://localhost:5173/` (rejected by Spotify; the sheet links to the 127.0.0.1 address) |

The connect sheet shows the exact value with a COPY button. Spotify compares it
character for character, so register it exactly as shown. Because the redirect
lands on the root document, GitHub Pages needs no SPA fallback.

### Client ID

- Build time: `VITE_SPOTIFY_CLIENT_ID=<id> npm run build` (or in `.env.local`).
  The deploy workflow passes the repository **variable** `SPOTIFY_CLIENT_ID`.
  It is not a secret.
- Otherwise: type it in the connect sheet; it is kept in `localStorage`
  (`duoamp.spotify.clientId`) for that origin.

### Run locally against real Spotify

```sh
npm run dev:spotify                   # serves http://127.0.0.1:5173/
# register http://127.0.0.1:5173/ in the dashboard, then open exactly that address
```

Use `127.0.0.1`, not `localhost`: Spotify rejects `localhost`, and browser
storage is per origin, so the two addresses do not share the Client ID or the
sign-in. A phone on your LAN (`http://192.168.x.x:5173`) cannot sign in: Spotify
only allows plain HTTP for loopback. Test on the phone against the deployed
HTTPS site.

### How it works

- **Sign-in**: Authorization Code + PKCE (S256), `src/spotify/auth.ts`. The
  verifier and state are stored in `localStorage` + `sessionStorage` during the
  round trip, which stays in the same window (also in a home-screen app). The
  `?code=&state=` / `?error=` return is handled before anything else reads the
  URL, then the URL is cleaned and its earlier query restored. Tokens are stored
  in `localStorage` with expiry and first-authorised date; refresh is
  single-flight, proactive within 60 s of expiry and on any 401; `invalid_grant`
  (the 6-month refresh-token limit, or revocation) signs out to demo mode.
- **Web API client** (`src/spotify/api.ts`): typed errors, 429 handling with
  `Retry-After` shared across requests (exponential backoff if the header is not
  readable), paging with `limit=50` following `next`.
- **Library** (`src/spotify/library.ts`): playlists from `/me/playlists`,
  tracks from `/playlists/{id}/items`, trying in order: `fields` for the new
  `item` key, `fields` for the deprecated `track` alias, no `fields` filter, and
  only then the old `/tracks` path; each fallback restarts the list from the top, Liked Songs from `/me/tracks`, `fields` to keep responses small, a
  `snapshot_id` cache in `localStorage`, progressive loading. Null entries,
  local files and episodes are skipped. Playlists you neither own nor
  collaborate on are shown dimmed and explain the 403 if picked.
- **Engines**: `SdkEngine` (this browser is the "DuoAmp" device) and
  `ConnectEngine` (remote control via `/me/player`, polling about every 4 s while
  visible, every 30 s when hidden), both on `SpotifyEngineBase` (optimistic UI
  reconciled from real state, one serial command queue, synthesised spectrum).
  AUTO tries the SDK and falls back to Connect on a script load failure,
  `initialization_error`, `account_error` or a second `autoplay_failed`. The
  library sheet can force either mode. `SpotifyService` orchestrates all of it
  and remembers the last source.
- **Playback**: a double-tapped row plays that row in its playlist context
  (`offset.uri`, or `offset.position` when the URI occurs twice); Liked Songs
  play a 100-URI window from the row. REP maps to context repeat on/off. Seek is
  sent once, on release; volume is throttled; where volume cannot be set (iOS
  SDK, or a device without volume support) the marquee says so. Balance is not
  available with Spotify.
- **Readouts**: Spotify does not disclose bitrate, sample rate or channels, so
  KBPS/KHZ show dashes and neither MONO nor STEREO is lit. The visualiser is
  synthesised (seeded per track, driven by the play clock); the equaliser is
  visual only.
- **Attribution and policy**: the footer reads `SPOTIFY: <playlist>`; ART mode
  in the visualiser (BARS -> SCOPE -> ART -> OFF) shows the cover unmodified
  (contain, nothing drawn over it); the menu has OPEN TRACK IN SPOTIFY and the
  library sheet links the loaded playlist. Controls Spotify marks as disallowed
  are dimmed and ignored.
- **Diagnostics** (menu -> DIAGNOSTICS): mode, auth and token expiry, device,
  SDK state, recent engine/API events and errors with timestamps, viewport,
  posture, safe-area insets, standalone mode and user agent, with COPY REPORT.
  Tokens, the PKCE verifier and the auth code are never logged or reported.

### Storage and privacy

- Tokens, the Client ID, the last playlist and a small track cache are kept in
  `localStorage` of the origin the app is served from. On GitHub Pages that
  origin is `https://scasella.github.io`, which is **shared with every other
  Pages site under the same account** (`scasella.github.io/<other-repo>/`): any
  page there can read DuoAmp's tokens. A custom domain gives the app its own
  origin and isolates them.
- Safari (with Intelligent Tracking Prevention) deletes a site's script-writable
  storage, `localStorage` included, after seven days of Safari use without
  interaction with that site; you then sign in again. Home-screen web apps keep
  their own day counter and, per WebKit, are not expected to have their data
  deleted (WebKit blog, "Full Third-Party Cookie Blocking and More", March 2020).
- DISCONNECT removes the tokens, the last playlist, the track cache and the
  remembered device. It keeps the Client ID and the mode choice.

### Known limits

- **Liked Songs** play as a list of up to 100 track URIs starting at the tapped
  row, so NEXT, SHUFFLE and REPEAT stop at the edge of that window. Spotify's
  start-playback reference lists only albums, artists and playlists as
  contexts (`offset` only for albums and playlists); a Liked Songs/collection
  context is not documented, so it is not used.
- **Scopes**: the Web Playback SDK needs `streaming`, `user-read-email` and
  `user-read-private`. Sign-ins made before `user-read-email` was added lack it:
  the app notices on load and offers RECONNECT in the library sheet (until
  then it falls back to remote control).
- **iOS**: playback moved to DuoAmp from another device arrives paused (Spotify:
  "The playback does not start automatically after transferring playback"); the
  marquee asks for a tap on PLAY. Only failures right after a PLAY or row tap
  here count towards giving up on in-browser playback.
- The SDK state's `timestamp` (used to place a stale position correctly) and
  `linked_from` (relinked tracks) are observed fields, not documented ones.
- Player commands that wait more than 5 s in the queue (after a hang or a rate
  limit) are dropped rather than replayed late; one that does not settle in
  10 s is abandoned. While Spotify asks to wait longer than 30 s (3 s for player
  commands), requests fail at once with "try again in N s".
- KBPS/KHZ/MONO/STEREO, the EQ and the visualiser are not real audio data (see above).

### Testing against a fake

No real Spotify account is reachable from CI or this repo's tooling.
`scripts/fake-spotify.mjs` emulates accounts.spotify.com, api.spotify.com
(paging in old and new shapes, 401/403/404/429, the player endpoints, devices)
and a stub `spotify-player.js` that shares one player model with the Web API.
`npm run check:spotify` drives the built app against it, including a run served
at `https://scasella.github.io/cloud-mono/` by interception. Passing tests
mean the app matches the documented API as the fake models it, not that it
works with real Spotify on a real phone.

## Home screen (PWA)

`public/manifest.webmanifest`, icons drawn from the `_D_` logo tile by
`scripts/build-icons.mjs`, and an `apple-touch-icon`. No service worker: iOS does
not need one to install, playback needs the network anyway, and a cache would
risk serving a stale build after deploys.

## Deploy (GitHub Pages)

The workflow `.github/workflows/deploy-duoamp.yml` (repo root) builds
`apps/duoamp` and publishes `dist/` as the whole site. It runs only when started
by hand (Actions -> Deploy DuoAmp to GitHub Pages -> Run workflow).

1. Repository Settings -> Pages -> Build and deployment -> Source: **GitHub Actions**.
2. Optional: Settings -> Secrets and variables -> Actions -> **Variables** ->
   `SPOTIFY_CLIENT_ID` = your Client ID, so the build has it.
3. Run the workflow. The site is served at `https://scasella.github.io/cloud-mono/`
   (unless you set a custom domain; then register that URL as the redirect URI).
4. Register `https://scasella.github.io/cloud-mono/` (with the trailing slash)
   in the Spotify dashboard.

Notes: Pages on a private repository needs a paid GitHub plan, and a Pages site
is public even when the repository is private.

## URL parameters

| Parameter | Values | Effect |
| --- | --- | --- |
| `layout` | `auto`, `cover`, `book`, `tabletop` | Override posture detection (not persisted) |
| `skin` | `light`, `classic` | Override the skin (not persisted) |
| `sim` | `1`, `0` | Force simulator on or off |
| `zoom` | e.g. `0.8` | Simulator scale |
| `autoplay` | `1` | Start playing on load (demo only) |
| `rate` | e.g. `20` | Mock playback speed multiplier |
| `test` | `1` | Expose `window.duoamp` (always exposed on the dev server) |

The same posture and skin choices are in the in-app menu (top-left button) and
are saved to localStorage along with volume, EQ and other preferences. These
parameters survive the Spotify sign-in round trip.

## Device numbers

All device geometry and detection thresholds live in `src/config.ts`
(`DEVICE`, `DETECT`, `GRID`). They come from desk research, not hardware
measurements. `src/posture.ts` uses them, plus the Viewport Segments and Device
Posture APIs when the browser exposes them.

## Fonts and artwork

- **DuoPixel**: the text face, an original 5x6 bitmap design drawn for this project
  (`fonts/duopixel-glyphs.mjs`). `scripts/build-font.mjs` compiles it with opentype.js
  into `src/fonts/DuoPixel.otf`, which is committed. Part of this project.
- **Silkscreen** by Jason Kottke, used for the small printed labels. SIL Open Font
  License 1.1, via `@fontsource/silkscreen`.
- Everything else (LCD digits, icons, skins, the device frame, the home-screen
  icons) is drawn in code. No third-party skin assets are used. Spotify's logo
  is not drawn; attribution is the text "SPOTIFY".
