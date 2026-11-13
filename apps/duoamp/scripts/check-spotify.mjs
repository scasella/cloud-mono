#!/usr/bin/env node
/**
 * Spotify phase checks, run against a FAKE Spotify (scripts/fake-spotify.mjs):
 * Playwright route interception for accounts.spotify.com / api.spotify.com /
 * sdk.scdn.co / i.scdn.co, plus a stub spotify-player.js. Nothing here talks
 * to real Spotify.
 *
 *   node scripts/check-spotify.mjs [--no-build] [--only=<substring of a section name>]
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './screenshots.mjs';
import { FakeSpotify, CLIENT_ID } from './fake-spotify.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
if (!args.includes('--no-build')) execSync('npx vite build', { cwd: root, stdio: 'inherit' });

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('unhandledRejection', (e) => {
  console.log(`FAIL  unhandled rejection: ${e?.stack ?? e}`);
  failures++;
});

const server = await startServer();
const browser = await chromium.launch();
const BASE = server.url; // http://127.0.0.1:4179/
const consoleLines = [];
const sessions = [];

async function session(opts = {}, { viewport = { width: 382, height: 600 }, url = `${BASE}?test=1&sim=0`, skin } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 3, hasTouch: true });
  const fake = new FakeSpotify(opts);
  await fake.install(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    consoleLines.push(m.text());
    // Chromium logs every non-2xx fetch as an error; those are expected here (401/403/404/429 are the tests).
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(skin ? `${url}&skin=${skin}` : url);
  await page.evaluate(() => document.fonts.ready);
  const s = { ctx, page, fake, errors };
  sessions.push(s);
  return s;
}

async function close(s) {
  s.fake.stop();
  await s.ctx.close();
}

const st = (page) => page.evaluate(() => {
  const s = window.duoamp.engine.getState();
  return { ...s, tracks: undefined, n: s.tracks.length, uris: s.tracks.slice(0, 200).map((t) => t.uri) };
});
const svc = (page) => page.evaluate(() => {
  const sp = window.duoamp.spotify;
  return { signedIn: sp.signedIn, mode: sp.engine?.mode ?? null, busy: sp.busy, authMessage: sp.authMessage, load: sp.loadStatus, playlists: sp.playlists?.length ?? null, fallback: sp.sdkFallbackReason };
});
/** Poll a node-side condition (fake Spotify state) instead of sleeping a fixed time. */
const waitFor = async (fn, timeout = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(40);
  }
  return !!(await fn());
};
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 50 }).then(() => true, () => false);
const marquee = (page) => page.textContent('.marquee-text');
/** The marquee's track text (not a transient message that may be showing). */
const marqueeTrack = (page) => page.evaluate(() => window.duoamp.app.main.marqueeStr);

async function signIn(page, clientId = CLIENT_ID) {
  await page.tap('.t-eject');
  await page.fill('.sheet-input', clientId);
  await page.tap('.btn-connect');
  await page.waitForURL((u) => !u.searchParams.has('code') && u.host === new URL(page.url()).host && !u.href.includes('accounts.spotify'), { timeout: 8000 }).catch(() => undefined);
  return until(page, () => window.duoamp?.spotify?.signedIn && window.duoamp.spotify.engine && !window.duoamp.spotify.busy, null, 25000);
}

async function openLibrary(page) {
  await page.tap('.t-eject');
  await page.waitForSelector('.sheet-library');
}

async function pickPlaylist(page, id) {
  await openLibrary(page);
  await until(page, (i) => !!document.querySelector(`.lib-row[data-id="${i}"]`), id);
  await page.locator(`.lib-row[data-id="${id}"]`).tap();
}

async function doubleTapRow(page, i) {
  const row = page.locator(`.pl-row[data-i="${i}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.tap();
  await row.tap();
}

const section = async (name, fn) => {
  if (only && !name.includes(only)) return;
  console.log(`\n== ${name}`);
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: threw ${e.stack ?? e}`);
  }
};

const SCOPES = 'streaming user-read-email user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-library-read user-read-private'.split(' ');

try {
  // ------------------------------------------------------------------------
  await section('redirect URI rule', async () => {
    const s = await session();
    const { page } = s;
    const cases = [
      [{ protocol: 'https:', host: 'scasella.github.io', pathname: '/cloud-mono/' }, 'https://scasella.github.io/cloud-mono/'],
      [{ protocol: 'https:', host: 'scasella.github.io', pathname: '/cloud-mono/index.html' }, 'https://scasella.github.io/cloud-mono/'],
      [{ protocol: 'https:', host: 'scasella.github.io', pathname: '/cloud-mono' }, 'https://scasella.github.io/cloud-mono/'],
      [{ protocol: 'https:', host: 'SCASELLA.github.io', pathname: '//cloud-mono//' }, 'https://scasella.github.io/cloud-mono/'],
      [{ protocol: 'http:', host: '127.0.0.1:5173', pathname: '/' }, 'http://127.0.0.1:5173/'],
      [{ protocol: 'http:', host: '127.0.0.1:5173', pathname: '/index.html' }, 'http://127.0.0.1:5173/'],
      [{ protocol: 'http:', host: '127.0.0.1:4173', pathname: '/' }, 'http://127.0.0.1:4173/'],
    ];
    for (const [loc, want] of cases) {
      const got = await page.evaluate((l) => window.duoamp.computeRedirectUri(l), loc);
      ok(got === want, `redirect ${loc.protocol}//${loc.host}${loc.pathname} -> ${got}`);
    }
    await page.tap('.t-eject');
    const shown = await page.textContent('[data-test="redirect-uri"]');
    ok(shown === `${BASE}`, `connect sheet shows the redirect URI for this server: "${shown}"`);
    ok(shown === 'http://127.0.0.1:4179/', 'local preview resolves to http://127.0.0.1:4179/');
    await close(s);
  });

  // ------------------------------------------------------------------------
  await section('deployed path https://scasella.github.io/cloud-mono/ (dist served by interception)', async () => {
    const ctx = await browser.newContext({ viewport: { width: 382, height: 600 }, deviceScaleFactor: 2, hasTouch: true });
    const fake = new FakeSpotify({ expectRedirect: 'https://scasella.github.io/cloud-mono/' });
    await fake.install(ctx);
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.otf': 'font/otf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json' };
    await ctx.route('https://scasella.github.io/**', (route) => {
      const u = new URL(route.request().url());
      if (!u.pathname.startsWith('/cloud-mono/')) return route.fulfill({ status: 404, body: 'GitHub Pages 404' });
      let rel = u.pathname.slice('/cloud-mono/'.length) || 'index.html';
      const file = join(root, 'dist', rel);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: 'GitHub Pages 404' });
      route.fulfill({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    });
    const page = await ctx.newPage();
    await page.goto('https://scasella.github.io/cloud-mono/?test=1&sim=0');
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(() => window.duoamp.spotify.redirectUri);
    ok(r === 'https://scasella.github.io/cloud-mono/', `deployed redirect URI is exactly "${r}"`);
    const ok2 = await signIn(page);
    const auth = fake.requests('/authorize')[0]?.query ?? {};
    ok(ok2 && auth.redirect_uri === 'https://scasella.github.io/cloud-mono/', `full sign-in on the deployed path with redirect_uri=${auth.redirect_uri}`);
    ok(new URL(page.url()).pathname === '/cloud-mono/' && !page.url().includes('code='), `returns to the root document and cleans the URL (${page.url()})`);
    const p2 = await ctx.newPage();
    await p2.goto('https://scasella.github.io/cloud-mono/index.html?test=1&sim=0&x=1');
    ok((await p2.evaluate(() => window.duoamp.spotify.redirectUri)) === 'https://scasella.github.io/cloud-mono/', 'index.html?x=1 resolves to the same redirect URI');
    const man = await p2.evaluate(async () => {
      const l = document.querySelector('link[rel=manifest]');
      const r = await fetch(l.href);
      return { href: l.href, ok: r.ok, json: await r.json(), touch: document.querySelector('link[rel=apple-touch-icon]').href };
    });
    ok(man.ok && man.href === 'https://scasella.github.io/cloud-mono/manifest.webmanifest' && man.json.start_url === './' && man.json.display === 'standalone', `manifest served under the base path (${man.href})`);
    const icon = await p2.evaluate(async (u) => (await fetch(u)).ok, man.touch);
    ok(icon && man.touch.endsWith('/cloud-mono/apple-touch-icon.png'), 'apple-touch-icon resolves under the base path');
    fake.stop();
    await ctx.close();
  });

  // ------------------------------------------------------------------------
  await section('PKCE round trip', async () => {
    const s = await session();
    const { page, fake } = s;
    await page.tap('.t-eject');
    await page.fill('.sheet-input', 'not-a-client-id');
    await page.tap('.btn-connect');
    await sleep(200);
    ok((await svc(page)).authMessage?.includes('32'), 'invalid Client ID rejected locally');
    await page.tap('.sheet-ok');
    const signed = await signIn(page);
    ok(signed, 'signed in after consent');
    const q = fake.requests('/authorize')[0]?.query ?? {};
    ok(q.response_type === 'code' && q.code_challenge_method === 'S256' && q.client_id === CLIENT_ID, 'authorize: code + S256 + client_id');
    ok(SCOPES.every((x) => q.scope.split(' ').includes(x)) && q.scope.split(' ').length === SCOPES.length, `authorize: exactly the required scopes (${q.scope})`);
    ok(q.redirect_uri === 'http://127.0.0.1:4179/', `authorize: redirect_uri ${q.redirect_uri}`);
    ok(/^[A-Za-z0-9._~-]{16,}$/.test(q.state), 'authorize: random state');
    const tr = fake.tokenRequests.filter((t) => t.grant === 'authorization_code');
    ok(tr.length === 1 && /x-www-form-urlencoded/.test(tr[0].contentType), 'one form-encoded code exchange (verifier checked against challenge by the fake)');
    ok(new URL(page.url()).search === '?test=1&sim=0', `URL cleaned, original query restored (${new URL(page.url()).search})`);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('duoamp.spotify.tokens.v1')));
    ok(stored && stored.expiresAt > Date.now() + 3500e3 && stored.firstAuthorizedAt <= Date.now() && stored.refreshToken, 'tokens stored with expiry and first-authorised date');
    ok((await page.evaluate(() => localStorage.getItem('duoamp.spotify.pkce.v1'))) === null, 'PKCE verifier/state removed after use');
    ok((await page.evaluate(() => sessionStorage.getItem('duoamp.spotify.pkce.v1'))) === null, 'PKCE record removed from sessionStorage too');
    ok((await svc(page)).mode === 'sdk', 'SDK engine selected');
    await until(page, () => window.duoamp.spotify.playlists?.length === 3);
    await openLibrary(page);
    ok((await page.textContent('.sheet-library')).toUpperCase().includes('FAKE LISTENER'), 'library sheet shows the account name');
    ok(s.errors.length === 0, `no console errors${s.errors.length ? ': ' + s.errors.join(' | ') : ''}`);
    await close(s);
  });

  await section('state mismatch', async () => {
    const s = await session({ tamperState: true });
    const { page, fake } = s;
    await signIn(page);
    await until(page, () => window.duoamp.spotify.authMessage);
    const v = await svc(page);
    ok(!v.signedIn && /STATE MISMATCH/.test(v.authMessage ?? ''), `not signed in; message "${v.authMessage}"`);
    ok(fake.tokenRequests.length === 0, 'code was not exchanged');
    ok(!page.url().includes('code='), 'URL cleaned');
    ok((await st(page)).serviceLabel === '', 'stays in demo mode');
    await close(s);
  });

  await section('denied consent', async () => {
    const s = await session({ denyConsent: true });
    const { page, fake } = s;
    await signIn(page);
    await until(page, () => window.duoamp.spotify.authMessage);
    const v = await svc(page);
    ok(!v.signedIn && v.authMessage === 'SIGN-IN CANCELLED', `denied -> "${v.authMessage}"`);
    ok(fake.tokenRequests.length === 0 && !page.url().includes('error='), 'no exchange, URL cleaned');
    await page.tap('.t-eject');
    ok((await page.textContent('.sheet-library')).includes('SIGN-IN CANCELLED'), 'connect sheet shows the reason');
    await close(s);
  });

  // ------------------------------------------------------------------------
  await section('token refresh', async () => {
    const s = await session();
    const { page, fake } = s;
    await signIn(page);
    await until(page, () => window.duoamp.spotify.playlists?.length === 3);
    fake.revokeAccessTokens();
    const before = fake.tokenRequests.filter((t) => t.grant === 'refresh_token').length;
    const n401 = fake.requests((r) => r.status === 401).length;
    const res = await page.evaluate(async () => {
      const api = window.duoamp.spotify.api;
      const out = await Promise.all([api.get('/me'), api.get('/me/playlists'), api.get('/me/player/devices')]);
      return out.map((x) => !!x);
    });
    const refreshes = fake.tokenRequests.filter((t) => t.grant === 'refresh_token').length - before;
    ok(res.every(Boolean), 'three concurrent requests succeed after 401');
    ok(fake.requests((r) => r.status === 401).length > n401, 'requests did get 401 first');
    ok(refreshes === 1, `single-flight: one refresh for three 401s (${refreshes})`);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('duoamp.spotify.tokens.v1')));
    ok(stored.refreshToken === fake.issued.refresh[0], 'no new refresh token returned -> old one kept');
    await close(s);

    // Proactive refresh: token about to expire is refreshed before the request is sent.
    const s2 = await session({ expiresIn: 62 });
    await signIn(s2.page);
    await sleep(2500);
    const b2 = s2.fake.tokenRequests.filter((t) => t.grant === 'refresh_token').length;
    const l401 = s2.fake.requests((r) => r.status === 401).length;
    await s2.page.evaluate(() => window.duoamp.spotify.api.get('/me'));
    ok(s2.fake.tokenRequests.filter((t) => t.grant === 'refresh_token').length > b2, 'proactive refresh within 60 s of expiry');
    ok(s2.fake.requests((r) => r.status === 401).length === l401, 'no 401 needed for the proactive case');
    await close(s2);

    // Rotation: a returned refresh token replaces the old one.
    const s3 = await session({ rotateRefresh: true });
    await signIn(s3.page);
    s3.fake.revokeAccessTokens();
    await s3.page.evaluate(() => window.duoamp.spotify.api.get('/me'));
    const t3 = await s3.page.evaluate(() => JSON.parse(localStorage.getItem('duoamp.spotify.tokens.v1')));
    ok(t3.refreshToken === s3.fake.issued.refresh[1], 'rotated refresh token stored');
    ok(t3.firstAuthorizedAt <= Date.now() && t3.firstAuthorizedAt === (await s3.page.evaluate(() => window.duoamp.spotify.auth.info().firstAuthorizedAt)), 'first-authorised date kept across refresh');
    await close(s3);
  });

  await section('invalid_grant -> signed out', async () => {
    const s = await session();
    const { page, fake } = s;
    await signIn(page);
    await until(page, () => window.duoamp.spotify.playlists?.length === 3);
    fake.cfg.refreshInvalidGrant = true;
    fake.revokeAccessTokens();
    const r = await page.evaluate(() => window.duoamp.spotify.api.get('/me').then(() => 'ok', (e) => e.kind));
    ok(r === 'auth', `request fails with auth error (${r})`);
    await until(page, () => !window.duoamp.spotify.signedIn);
    const v = await svc(page);
    ok(!v.signedIn && /EXPIRED/.test(v.authMessage ?? ''), `signed out with "${v.authMessage}"`);
    ok((await page.evaluate(() => localStorage.getItem('duoamp.spotify.tokens.v1'))) === null, 'tokens removed');
    ok((await st(page)).serviceLabel === '' && (await st(page)).n === 139, 'back to the demo engine');
    const refreshes = fake.tokenRequests.filter((t) => t.grant === 'refresh_token').length;
    await sleep(600);
    ok(fake.tokenRequests.filter((t) => t.grant === 'refresh_token').length === refreshes, 'invalid_grant is not retried');
    await close(s);
  });

  // ------------------------------------------------------------------------
  const PAGING = {
    new: { opts: { shape: 'new' }, trace: 'items:200 items:200 items:200', fieldsHas: 'item(' },
    old: { opts: { shape: 'old' }, trace: 'items:404 items:404 items:404 tracks:200 tracks:200 tracks:200', fieldsHas: 'track(' },
    // /items still answering in the old shape, with `fields` honoured: item(...) yields nothing, track(...) works.
    alias: { opts: { shape: 'alias' }, trace: 'items:200 items:200 items:200 items:200', fieldsHas: 'track(' },
    // `fields` rejected on /items: falls back to /items without a filter (never to /tracks first).
    fields400: { opts: { shape: 'new', fields400: true }, trace: 'items:400 items:400 items:200 items:200 items:200', fieldsHas: null },
    // A page fails mid-list: the next attempt starts over, no duplicated rows.
    midfail: { opts: { shape: 'new', failOnce: [{ match: /\/playlists\/pl120\/items$/, offset: 50, status: 404 }] }, trace: 'items:200 items:404 items:200 items:200 items:200', fieldsHas: 'track(' },
  };
  for (const [shape, P] of Object.entries(PAGING)) {
    await section(`paging 120-track playlist (${shape} shape)`, async () => {
      const s = await session(P.opts);
      const { page, fake } = s;
      await signIn(page);
      await until(page, () => window.duoamp.spotify.playlists?.length === 3);
      const counts = await page.evaluate(() => window.duoamp.spotify.playlists.map((p) => p.total));
      ok(counts[0] === 125, `playlist count read from ${P.opts.shape === 'old' ? 'tracks.total' : 'items.total'} (${counts.join(',')})`);
      await page.evaluate(() => {
        window.__seen = [];
        window.duoamp.engine.subscribe((st, k) => k.has('tracks') && window.__seen.push([st.tracks.length, st.loading]));
      });
      await pickPlaylist(page, 'pl120');
      const done = await until(page, () => window.duoamp.spotify.loadStatus.state === 'done', null, 10000);
      const v = await st(page);
      ok(done && v.n === 120, `120 playable tracks loaded (${v.n})`);
      const seen = await page.evaluate(() => window.__seen);
      ok(seen.some(([n, l]) => n > 0 && n < 120 && l), `loaded progressively (${seen.map((x) => x[0]).join(' ')})`);
      const reqs = fake.requests((r) => /\/playlists\/pl120\/(items|tracks)$/.test(r.path));
      const trace = reqs.map((r) => `${r.path.split('/').pop()}:${r.status}`).join(' ');
      ok(trace === P.trace && reqs.every((r) => r.query.limit === '50'), `request sequence ${trace}`);
      if (trace !== P.trace) console.log(reqs.map((r) => `${r.query.offset ?? 0}:${(r.query.fields ?? '').slice(0, 40)}`).join('\n'));
      const last3 = reqs.slice(-3);
      ok(P.fieldsHas ? last3.every((r) => r.query.fields?.includes(P.fieldsHas)) : last3.every((r) => !r.query.fields), `working attempt ${P.fieldsHas ? 'uses fields with ' + P.fieldsHas : 'has no fields filter'}`);
      ok(new Set(v.uris).size === 120, 'no duplicated rows');
      const allPos = await page.evaluate(() => [...window.duoamp.spotify.engine.getPositions()]);
      ok(allPos.every((p, i) => i === 0 || p > allPos[i - 1]), 'playlist positions strictly increasing (no rows from a failed attempt)');
      const pos = allPos.slice(0, 9);
      ok(pos.join() === '0,1,2,3,4,5,6,8,9', `null/local/episode entries skipped, playlist positions kept (${pos.join()})`);
      ok(!v.uris.some((u) => !u.startsWith('spotify:track:')), 'no local or episode URIs in the list');
      const info = await page.evaluate(() => [...document.querySelectorAll('.pl-info-line')].map((e) => e.textContent));
      ok(info[0].toUpperCase() === 'SPOTIFY: ROAD TRIP 120' && /^120 TRACKS/.test(info[1]) && !info[1].includes('...'), `footer LCD: ${info.join(' / ')}`);
      ok((await page.locator('.pl-row').count()) === 120, 'playlist window has 120 rows');
      if (shape === 'new') {
        await pickPlaylist(page, 'liked');
        await until(page, () => window.duoamp.spotify.loadStatus.state === 'done' && window.duoamp.engine.getState().tracks.length === 60);
        const lv = await st(page);
        ok(lv.n === 60 && lv.sourceLabel === 'LIKED SONGS', `Liked Songs: ${lv.n} tracks`);
        ok(fake.requests('/me/tracks').filter((r) => r.query.limit === '50').length === 2, 'Liked Songs paged with limit 50');
      }
      ok(s.errors.length === 0, `no console errors${s.errors.length ? ': ' + s.errors.join(' | ') : ''}`);
      await close(s);
    });
  }

  // ------------------------------------------------------------------------
  await section('429 Retry-After', async () => {
    for (const expose of [true, false]) {
      const s = await session({ rateLimit: { match: /^\/me\/playlists$/, times: 1, retryAfter: 2 }, exposeRetryAfter: expose });
      const { page, fake } = s;
      await signIn(page);
      await until(page, () => window.duoamp.spotify.playlists?.length === 3, null, 12000);
      const reqs = fake.requests((r) => r.path === '/me/playlists');
      const gap = reqs.length >= 2 ? reqs[1].at - reqs[0].at : 0;
      ok(reqs[0]?.status === 429 && reqs[1]?.status === 200, `429 then success (${reqs.map((r) => r.status).join(',')})`);
      ok(gap >= 1900 && gap < 4500, `waited ${gap} ms (${expose ? 'Retry-After: 2 honoured' : 'header not readable: 2 s backoff'})`);
      const errs = await page.evaluate(() => window.duoamp.spotify.api.lastErrors.map((e) => e.status));
      ok(errs.includes(429), 'recorded for diagnostics');
      await close(s);
    }
    // QUOTA_EXCEEDED with a long Retry-After is surfaced, not waited out.
    const s = await session({ rateLimit: { match: /^\/me$/, times: 5, retryAfter: 120, reason: 'QUOTA_EXCEEDED' } });
    await signIn(s.page);
    s.fake.cfg.rateLimit.times = 5;
    const r = await s.page.evaluate(() => window.duoamp.spotify.api.get('/me').then(() => 'ok', (e) => `${e.kind}:${e.reason}:${e.message}`));
    ok(/^rate_limited:QUOTA_EXCEEDED:SPOTIFY QUOTA EXCEEDED/.test(r), `long Retry-After surfaced as an error, keeping Spotify's reason (${r})`);
    await close(s);
  });

  await section('403 on a playlist', async () => {
    const s = await session();
    const { page } = s;
    await signIn(page);
    await openLibrary(page);
    await until(page, () => !!document.querySelector('.lib-row[data-id="plother"]'));
    ok(await page.locator('.lib-row[data-id="plother"].is-dim').count() === 1, 'playlist owned by someone else is dimmed');
    ok(await page.locator('.lib-row[data-id="plcollab"]:not(.is-dim)').count() === 1, 'collaborative playlist is not dimmed');
    await page.tap('.sheet-ok');
    const msgs = [];
    await page.exposeFunction('__msg', (t) => msgs.push(t));
    await page.evaluate(() => window.duoamp.engine.subscribeNotices((n) => window.__msg(n.text)));
    await pickPlaylist(page, 'plother');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'error');
    const v = await svc(page);
    ok(/OWN OR COLLABORATE/.test(v.load.error ?? ''), `graceful message: "${v.load.error}"`);
    await sleep(100);
    ok(msgs.some((m) => /OWN OR COLLABORATE/.test(m)), 'message shown in the marquee');
    await openLibrary(page);
    ok((await page.textContent('.sheet-library')).includes('OWN OR COLLABORATE'), 'library sheet explains it');
    await page.tap('.sheet-ok');
    await pickPlaylist(page, 'plcollab');
    ok(await until(page, () => window.duoamp.spotify.loadStatus.state === 'done' && window.duoamp.engine.getState().tracks.length === 12), 'collaborative playlist loads');
    ok(s.errors.length === 0, `no console errors${s.errors.length ? ': ' + s.errors.join(' | ') : ''}`);
    await close(s);
  });

  // ------------------------------------------------------------------------
  await section('SDK happy path', async () => {
    const s = await session();
    const { page, fake } = s;
    await signIn(page);
    ok((await svc(page)).mode === 'sdk' && !!fake.sdk.deviceId, 'SDK ready, device registered');
    await pickPlaylist(page, 'pl120');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    ok((await st(page)).status === 'stopped' && fake.player === null, 'loading a playlist does not start or steal playback');

    await doubleTapRow(page, 2);
    await until(page, () => window.duoamp.engine.getState().status === 'playing');
    const play = fake.requests((r) => r.path === '/me/player/play').at(-1);
    const t3 = (await st(page)).uris[2];
    ok(play?.query.device_id === fake.sdk.deviceId, 'PUT /me/player/play targets the SDK device');
    ok(play?.body?.context_uri === 'spotify:playlist:pl120' && play.body.offset?.uri === t3, `context + offset (${JSON.stringify(play?.body)})`);
    ok(fake.sdk.events.includes('activate:true') && fake.sdk.events.indexOf('activate:true') < fake.sdk.events.indexOf('player_state_changed'), 'activateElement() ran inside the gesture, before playback');
    ok(!fake.sdk.events.includes('autoplay_failed'), 'no autoplay failure');
    await waitFor(() => fake.player && !fake.player.paused);
    await until(page, (u) => window.duoamp.engine.getState().index === 2 && window.duoamp.engine.getState().current?.uri === u, t3);
    let v = await st(page);
    ok(v.index === 2 && v.current.uri === t3 && fake.player.paused === false, 'row 3 current, Spotify playing it');
    ok(await page.locator('.pl-row[data-i="2"].is-current').count() === 1, 'row 3 highlighted');
    ok((await marqueeTrack(page)).startsWith('3. '), `marquee: "${(await marqueeTrack(page)).slice(0, 40)}"`);
    const kb = await page.textContent('.readout-kbps');
    const khz = await page.textContent('.readout-khz');
    const lit = await page.locator('.lbl.ind.is-lit').count();
    ok(kb === '---' && khz === '--' && lit === 0, `no fake stream info (kbps "${kb}", khz "${khz}", mono/stereo lit: ${lit})`);

    await page.tap('.t-pause');
    await until(page, () => window.duoamp.engine.getState().status === 'paused');
    await waitFor(() => fake.player.paused && fake.sdk.events.includes('cmd:pause'));
    ok(fake.player.paused === true && fake.sdk.events.includes('cmd:pause'), 'pause via SDK');
    await page.tap('.t-play');
    await waitFor(() => !fake.player.paused && fake.sdk.events.includes('cmd:resume'));
    await until(page, () => window.duoamp.engine.getState().status === 'playing');
    ok(fake.player.paused === false && fake.sdk.events.includes('cmd:resume') && (await st(page)).status === 'playing', 'play resumes via SDK');

    const seeksBefore = fake.sdk.events.filter((e) => e === 'cmd:seek').length;
    const k = await page.locator('.sl-seek .slider-knob').boundingBox();
    await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(k.x + k.width / 2 + i * 15, k.y + k.height / 2);
    await page.mouse.up();
    await waitFor(() => fake.sdk.events.filter((e) => e === 'cmd:seek').length > seeksBefore);
    await sleep(300); // and no second seek after that
    const seeks = fake.sdk.events.filter((e) => e === 'cmd:seek').length - seeksBefore;
    ok(seeks === 1, `seek sent once on release (${seeks})`);
    ok(Math.abs(fake.pos() / 1000 - (await page.evaluate(() => window.duoamp.engine.getPosition()))) < 1.5 && fake.pos() > 20000, `seek applied (${Math.round(fake.pos() / 1000)} s)`);

    await page.tap('.t-next');
    await until(page, () => window.duoamp.engine.getState().index === 3);
    await waitFor(() => fake.player.idx === 3);
    ok(fake.player.idx === 3 && (await st(page)).index === 3, 'next -> row 4');
    await page.tap('.btn-shuffle');
    await waitFor(() => fake.player.shuffle);
    const sh = fake.requests('/me/player/shuffle').at(-1);
    ok(sh?.query.state === 'true' && sh.query.device_id === fake.sdk.deviceId && fake.player.shuffle, 'shuffle on via Web API');
    await page.tap('.btn-rep');
    await waitFor(() => fake.player.repeat === 'context');
    ok(fake.requests('/me/player/repeat').at(-1)?.query.state === 'context' && fake.player.repeat === 'context', 'REP -> repeat context');
    await page.tap('.btn-rep');
    await waitFor(() => fake.player.repeat === 'off');
    ok(fake.requests('/me/player/repeat').at(-1)?.query.state === 'off', 'REP again -> repeat off');
    await page.tap('.btn-shuffle');
    await waitFor(() => !fake.player.shuffle);
    await sleep(3600); // let the optimistic holds lapse so remote state wins below

    // Reconciliation from real state: Spotify moves on by itself (e.g. track end, or controlled from the lock screen).
    fake.player.idx = 80;
    fake.setPos(1000);
    fake.pushSdk();
    await until(page, () => window.duoamp.engine.getState().index === 80);
    await sleep(700);
    const vis = await page.evaluate(() => {
      const sc = document.querySelector('.pl-scroll');
      const r = document.querySelector('.pl-row.is-current');
      return r && r.dataset.i === '80' && r.offsetTop >= sc.scrollTop - 1 && r.offsetTop + r.offsetHeight <= sc.scrollTop + sc.clientHeight + 1;
    });
    ok(vis, 'external track change highlights row 81 and scrolls it into view');

    // Relinked track (SDK reports another URI with linked_from).
    fake.player.idx = 5;
    fake.setPos(0);
    fake.pushSdk();
    await until(page, () => window.duoamp.engine.getState().index === 5);
    v = await st(page);
    ok(v.index === 5 && v.current.uri !== v.uris[5], 'relinked track matched to its row');

    // Something outside the loaded list.
    fake.player.queue = [{ ...fake.player.queue[0], id: 'outsidexxxxxxxxxxxxxxx', uri: 'spotify:track:outsidexxxxxxxxxxxxxxx', name: 'Elsewhere Song', duration_ms: 200000 }];
    fake.player.idx = 0;
    fake.player.contextUri = null;
    fake.pushSdk();
    await until(page, () => window.duoamp.engine.getState().index === -1);
    await sleep(100);
    ok((await page.locator('.pl-row.is-current').count()) === 0, 'outside the list: no row highlighted');
    ok(/^Elsewhere Song|^[^0-9].* - Elsewhere Song/i.test(await marqueeTrack(page)), `marquee shows it without a row number: "${(await marqueeTrack(page)).slice(0, 40)}"`);
    ok((await page.evaluate(() => window.duoamp.engine.getState().duration)) === 200, 'time/seek use its real duration');

    // Disallows from state: prev disabled at the first track.
    await doubleTapRow(page, 0);
    await until(page, () => window.duoamp.engine.getState().index === 0 && window.duoamp.engine.getState().disallows.prev, null, 4000);
    ok((await page.getAttribute('.t-prev', 'aria-disabled')) === 'true', 'disallowed PREV is marked disabled');

    // Cover art mode.
    await page.tap('.btn-eq');
    await page.waitForSelector('.vis-screen');
    for (let i = 0; i < 4 && (await page.evaluate(() => window.duoamp.prefs.visMode)) !== 'art'; i++) await page.tap('.vis-screen');
    await sleep(400);
    const art = await page.evaluate(() => {
      const img = document.querySelector('.vis-art');
      const cs = getComputedStyle(img);
      return { src: img.src, fit: cs.objectFit, display: cs.display, loaded: img.complete && img.naturalWidth > 0 };
    });
    ok(art.display === 'block' && art.fit === 'contain' && art.src.includes('-640') && art.loaded, `cover art shown unmodified (contain, ${art.src.split('/').pop()})`);

    // Open in Spotify link in the menu.
    await page.tap('.menu-btn');
    const href = await page.getAttribute('.menu a.menu-item', 'href');
    ok(/^https:\/\/open\.spotify\.com\/track\//.test(href ?? ''), `menu links the current track to Spotify (${href})`);
    await page.keyboard.press('Escape');

    // Reload restores the last source from the snapshot cache.
    const itemReqs = fake.requests('/playlists/pl120/items').length;
    await page.reload();
    await until(page, () => window.duoamp?.spotify?.loadStatus?.state === 'done' && window.duoamp.engine.getState().tracks.length === 120, null, 15000);
    v = await st(page);
    ok(v.sourceLabel === 'Road Trip 120' && v.n === 120, 'last source restored on reload');
    ok(fake.requests('/playlists/pl120/items').length === itemReqs && fake.requests((r) => r.path === '/playlists/pl120').length >= 1, 'served from the snapshot cache after a snapshot check');
    fake.playlists[0].snapshot = 'snap-2';
    await page.reload();
    await until(page, () => window.duoamp?.spotify?.loadStatus?.state === 'done' && window.duoamp.engine.getState().tracks.length === 120, null, 15000);
    ok(fake.requests('/playlists/pl120/items').length > itemReqs, 'changed snapshot -> refetched');
    ok(s.errors.length === 0, `no console errors${s.errors.length ? ': ' + s.errors.join(' | ') : ''}`);
    await close(s);
  });

  await section('Liked Songs play a URI window', async () => {
    const s = await session();
    const { page, fake } = s;
    await signIn(page);
    await pickPlaylist(page, 'liked');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    await doubleTapRow(page, 10);
    await until(page, () => window.duoamp.engine.getState().status === 'playing');
    const play = fake.requests((r) => r.path === '/me/player/play').at(-1);
    const uris = (await st(page)).uris;
    ok(!play.body.context_uri && play.body.uris.length === 50 && play.body.uris[0] === uris[10], `uris window from the tapped row (${play.body.uris.length} URIs)`);
    await sleep(300);
    ok((await st(page)).index === 10, 'row 11 current');
    await close(s);
  });

  await section('volume unsupported (iOS-like SDK)', async () => {
    const s = await session({ iosVolume: true });
    const { page } = s;
    await signIn(page);
    await until(page, () => window.duoamp.engine.getState().capabilities.volume === false);
    ok((await st(page)).capabilities.volume === false, 'volume probe: setVolume has no effect -> capability off');
    const vol0 = (await st(page)).volume;
    const k = await page.locator('.sl-volume .slider-knob').boundingBox();
    await page.mouse.move(k.x + 5, k.y + 5);
    await page.mouse.down();
    await page.mouse.move(k.x - 40, k.y + 5, { steps: 5 });
    const msg = await marquee(page);
    await page.mouse.up();
    await sleep(100);
    ok(/VOLUME: USE THE PHONE VOLUME BUTTONS/.test(msg), `transient message instead of silence: "${msg}"`);
    ok((await st(page)).volume === vol0, 'volume value unchanged');
    ok((await page.getAttribute('.sl-volume', 'aria-disabled')) === 'true', 'volume slider marked disabled');
    await close(s);
  });

  // ------------------------------------------------------------------------
  await section('SDK init failure -> Connect fallback', async () => {
    const s = await session({ sdk: 'init_error', restrictedDevice: true });
    const { page, fake } = s;
    await signIn(page);
    await until(page, () => window.duoamp.spotify.engine?.mode === 'connect');
    const v = await svc(page);
    ok(v.mode === 'connect' && v.fallback === 'BROWSER NOT SUPPORTED', `fell back to Connect (${v.fallback})`);
    await openLibrary(page);
    // The devices fetch may still be in flight when the sheet opens: the open sheet must update itself.
    const sheetOk = await until(page, () => {
      const t = document.querySelector('.sheet-library')?.textContent.toUpperCase() ?? '';
      return t.includes('REMOTE CONTROL') && t.includes('FAKE IPHONE');
    });
    ok(sheetOk, 'open sheet shows remote mode and updates with the device list');
    ok(await page.locator('.lib-devices .lib-row[data-id="tv-1"].is-dim').count() === 1, 'restricted device listed dimmed');
    await page.tap('.sheet-ok');
    await pickPlaylist(page, 'pl120');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    await doubleTapRow(page, 4);
    await until(page, () => window.duoamp.engine.getState().status === 'playing');
    await waitFor(() => fake.player?.deviceId === 'phone-1' && !fake.player.paused);
    await until(page, () => window.duoamp.engine.getState().index === 4, null, 6000);
    const play = fake.requests((r) => r.path === '/me/player/play').at(-1);
    ok(play?.query.device_id === 'phone-1', 'idle phone targeted with device_id (restricted TV listed first is skipped)');
    ok(fake.player?.deviceId === 'phone-1' && !fake.player.paused, 'phone playing');
    ok((await st(page)).index === 4, 'row 5 current from polled state');
    const p0 = fake.requests((r) => r.path === '/me/player' && r.method === 'GET').length;
    await sleep(9000);
    const polls = fake.requests((r) => r.path === '/me/player' && r.method === 'GET').length - p0;
    ok(polls >= 2 && polls <= 4, `polls /me/player every ~4 s while playing (${polls} in 9 s)`);
    const pos = await page.evaluate(() => window.duoamp.engine.getPosition());
    ok(Math.abs(pos - fake.pos() / 1000) < 1.2, `interpolated position tracks Spotify (${pos.toFixed(1)} vs ${(fake.pos() / 1000).toFixed(1)})`);
    // Volume on a device that cannot do it.
    ok((await st(page)).capabilities.volume === false, 'device without volume support -> volume capability off');

    // The phone goes idle and drops out of the device list.
    fake.removePhone();
    const msgs = [];
    await page.exposeFunction('__msg', (t) => msgs.push(t));
    await page.evaluate(() => window.duoamp.engine.subscribeNotices((n) => window.__msg(`${n.code}|${n.text}`)));
    await page.tap('.t-pause');
    await waitFor(() => msgs.some((m) => m.startsWith('no_active_device|')));
    ok(msgs.some((m) => m.startsWith('no_active_device|NO ACTIVE SPOTIFY DEVICE')), `NO_ACTIVE_DEVICE explained (${msgs.join(' / ')})`);
    // User opens Spotify on the phone and plays something else.
    fake.playOnPhone();
    await page.evaluate(() => window.duoamp.spotify.engine.refreshState());
    await until(page, () => window.duoamp.engine.getState().status === 'playing' && window.duoamp.engine.getState().index === -1, null, 3000);
    const v2 = await st(page);
    ok(v2.status === 'playing' && v2.index === -1 && /ELSEWHERE|DRIVE|NIGHT|SIGNAL|\d/.test(v2.current?.title ?? ''), `picks up playback started on the phone (${v2.current?.title}), no row`);
    await page.tap('.t-pause');
    await waitFor(() => fake.player.paused === true);
    ok(fake.player.paused === true, 'retry works once a device is active');
    // Hidden page backs off.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const h0 = fake.requests((r) => r.path === '/me/player' && r.method === 'GET').length;
    await sleep(8000);
    const h1 = fake.requests((r) => r.path === '/me/player' && r.method === 'GET').length - h0;
    ok(h1 <= 1, `hidden: polling backs off (${h1} in 8 s)`);
    ok(s.errors.length === 0, `no console errors${s.errors.length ? ': ' + s.errors.join(' | ') : ''}`);
    await close(s);
  });

  await section('other SDK failures', async () => {
    const s = await session({ sdk: 'no_script' });
    await signIn(s.page);
    await until(s.page, () => window.duoamp.spotify.engine?.mode === 'connect');
    ok((await svc(s.page)).fallback === 'PLAYER SCRIPT DID NOT LOAD', 'script load failure -> Connect');
    await s.page.evaluate(() => window.duoamp.spotify.setModePref('sdk'));
    await until(s.page, () => !window.duoamp.spotify.busy, null, 10000);
    ok((await s.page.evaluate(() => document.querySelectorAll('script[src*="sdk.scdn.co"]').length)) === 1 && s.fake.requests('sdk.scdn.co').length === 2, 'retry after a failed script load replaces the tag and refetches');
    await close(s);

    const s2 = await session({ sdk: 'account_error' });
    const msgs = [];
    await s2.page.exposeFunction('__msg', (t) => msgs.push(t));
    await s2.page.evaluate(() => window.duoamp.engine.subscribeNotices((n) => window.__msg(n.text)));
    await signIn(s2.page);
    await until(s2.page, () => window.duoamp.spotify.engine?.mode === 'connect');
    ok((await svc(s2.page)).fallback === 'SPOTIFY PREMIUM REQUIRED', 'account_error -> Connect with Premium message');
    await close(s2);

    const s3 = await session({ sdk: 'autoplay_strict' });
    const { page, fake } = s3;
    await signIn(page);
    await pickPlaylist(page, 'pl120');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    await doubleTapRow(page, 1);
    await until(page, () => window.duoamp.engine.getState().status === 'paused', null, 4000);
    ok(fake.sdk.events.includes('autoplay_failed') && (await svc(page)).mode === 'sdk', 'first autoplay_failed: stays in SDK, asks for a tap');
    await page.tap('.t-play');
    await until(page, () => window.duoamp.spotify.engine?.mode === 'connect', null, 8000);
    const fb = await svc(page);
    ok(fb.fallback === 'AUDIO BLOCKED BY BROWSER', `repeated autoplay_failed -> Connect (${fb.mode}, ${fb.fallback})`);
    ok((await st(page)).n === 120, 'loaded playlist carried over to the Connect engine');
    await close(s3);

    // Manual switch back and forth.
    const s4 = await session();
    await signIn(s4.page);
    await openLibrary(s4.page);
    await s4.page.tap('.chip[data-mode="connect"]');
    ok(await until(s4.page, () => window.duoamp.spotify.engine?.mode === 'connect' && !window.duoamp.spotify.busy), 'manual switch to REMOTE');
    await s4.page.tap('.chip[data-mode="sdk"]');
    ok(await until(s4.page, () => window.duoamp.spotify.engine?.mode === 'sdk' && !window.duoamp.spotify.busy, null, 10000), 'manual switch to IN BROWSER');
    ok((await s4.page.evaluate(() => document.querySelectorAll('script[src*="sdk.scdn.co"]').length)) === 1, 'SDK script tag reused, not duplicated');
    await s4.page.reload();
    ok(await until(s4.page, () => window.duoamp?.spotify?.modePref === 'sdk' && window.duoamp.spotify.engine?.mode === 'sdk'), 'mode choice persisted');
    await close(s4);
  });

  // ------------------------------------------------------------------------
  // ---- review round ----------------------------------------------------------
  await section('review: SDK needs user-read-email; missing scopes ask to reconnect', async () => {
    const s = await session({ denyScopes: ['user-read-email'] });
    const { page, fake } = s;
    await signIn(page);
    await until(page, () => window.duoamp.spotify.engine?.mode === 'connect', null, 15000);
    const v = await svc(page);
    ok(v.fallback === 'SIGN-IN REJECTED' && fake.sdk.events.filter((e) => e === 'register').length === 0, `fake SDK rejects a token without user-read-email -> Connect (${v.fallback})`);
    ok((await page.evaluate(() => window.duoamp.spotify.missingScopes.join())) === 'user-read-email', 'missing scope detected from the granted scope list');
    await openLibrary(page);
    ok(await page.isVisible('.btn-reconnect'), 'library sheet offers RECONNECT');
    fake.cfg.denyScopes = [];
    await page.tap('.btn-reconnect');
    ok(await until(page, () => window.duoamp?.spotify?.signedIn && window.duoamp.spotify.engine?.mode === 'sdk' && !window.duoamp.spotify.busy && window.duoamp.spotify.missingScopes.length === 0, null, 25000), 'after RECONNECT: all scopes granted, SDK mode');
    await close(s);
  });

  await section('review: gesture unlock on every gesture event; transfers do not count as autoplay failures', async () => {
    const s = await session();
    const { page } = s;
    await signIn(page);
    await pickPlaylist(page, 'pl120');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    await page.locator('.pl-row[data-i="2"]').tap();
    const kinds = await page.evaluate(() => window.duoamp.diag.list().filter((e) => /activateElement\(\) in/.test(e.msg)).map((e) => e.msg.split(' in ')[1]));
    ok(['pointerup', 'touchend', 'click'].every((k) => kinds.includes(k)), `activateElement() ran in pointerup, touchend and click of one tap (${[...new Set(kinds)].join(', ')})`);
    await close(s);

    const s2 = await session();
    const { page: p2, fake: f2 } = s2;
    await signIn(p2);
    f2.playOnPhone();
    const msgs = [];
    await p2.exposeFunction('__msg', (t) => msgs.push(t));
    await p2.evaluate(() => window.duoamp.engine.subscribeNotices((n) => window.__msg(n.code)));
    for (let i = 0; i < 3; i++) {
      // Someone moves playback to "DuoAmp" from the phone's device picker; iOS will not auto-start it.
      f2.playerApi('PUT', '/me/player', {}, { device_ids: [f2.sdk.deviceId], play: true });
      await sleep(600);
      f2.playerApi('PUT', '/me/player', {}, { device_ids: ['phone-1'], play: true });
      await sleep(300);
    }
    const d = await p2.evaluate(() => window.duoamp.spotify.engine.describe());
    ok(f2.sdk.events.filter((e) => e === 'autoplay_failed').length >= 3, 'fake: transfers to the SDK device arrive paused (iOS behaviour)');
    ok((await svc(p2)).mode === 'sdk' && d.autoplayFailures === '0', `three paused transfers do not abandon SDK mode (failures counted: ${d.autoplayFailures})`);
    ok(msgs.includes('autoplay_transfer'), 'user is told to tap PLAY');
    await close(s2);
  });

  await section('review: SDK reconnects after not_ready; stale SDK state does not snap back', async () => {
    const s = await session();
    const { page, fake } = s;
    await signIn(page);
    fake.sdkGoOffline();
    ok(await until(page, () => !window.duoamp.spotify.engine.ready, null, 2000), 'not_ready -> not ready');
    ok(await until(page, () => window.duoamp.spotify.engine.ready, null, 6000), 'reconnected by itself (backoff)');
    fake.sdkGoOffline();
    await until(page, () => !window.duoamp.spotify.engine.ready, null, 2000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    ok(await until(page, () => window.duoamp.spotify.engine.ready, null, 1200), 'page becoming visible reconnects at once');
    ok(Number((await page.evaluate(() => window.duoamp.spotify.engine.describe())).reconnects) >= 2, 'reconnect count in diagnostics');
    await close(s);

    const s2 = await session({ sdkStaleMs: 3000 });
    await signIn(s2.page);
    await pickPlaylist(s2.page, 'pl120');
    await until(s2.page, () => window.duoamp.spotify.loadStatus.state === 'done');
    await doubleTapRow(s2.page, 2);
    await until(s2.page, () => window.duoamp.engine.getState().status === 'playing');
    await sleep(4200); // past the optimistic holds
    await s2.page.evaluate(() => window.duoamp.spotify.engine.refreshState());
    const pos = await s2.page.evaluate(() => window.duoamp.engine.getPosition());
    const real = s2.fake.pos() / 1000;
    ok(Math.abs(pos - real) < 0.6, `3 s-old SDK snapshot placed by its timestamp: ${pos.toFixed(2)} vs real ${real.toFixed(2)}`);
    await close(s2);
  });

  await section('review: rate-limit block fails fast; stale queued commands are dropped; hung command times out', async () => {
    const s = await session();
    const { page, fake } = s;
    await signIn(page);
    await pickPlaylist(page, 'pl120');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    await doubleTapRow(page, 2);
    await until(page, () => window.duoamp.engine.getState().status === 'playing');
    const msgs = [];
    await page.exposeFunction('__msg', (t) => msgs.push(t));
    await page.evaluate(() => window.duoamp.engine.subscribeNotices((n) => window.__msg(n.code)));
    fake.cfg.rateLimit = { match: /^\/me\/player\/shuffle$/, times: 1, retryAfter: 120 };
    await page.tap('.btn-shuffle');
    await sleep(400);
    ok(msgs.includes('rate_limited'), 'long Retry-After on a command -> rate-limited notice');
    const n0 = fake.log.length;
    const t0 = Date.now();
    const r = await page.evaluate(() => window.duoamp.spotify.api.get('/me').then(() => 'ok', (e) => `${e.kind}:${e.retryAfter}`));
    ok(/^rate_limited:1[012]\d$/.test(r) && Date.now() - t0 < 500 && fake.log.length === n0, `while blocked: fails fast without a request (${r}, ${Date.now() - t0} ms)`);
    await page.tap('.btn-shuffle');
    await sleep(300);
    ok(fake.requests('/me/player/shuffle').length === 1, 'no command sent while blocked');
    await page.evaluate(() => (window.duoamp.spotify.api.blockedUntil = 0));

    fake.cfg.sdkHang = ['pause'];
    await page.tap('.t-pause');
    await sleep(100);
    await page.tap('.t-next');
    await page.tap('.btn-rep');
    await sleep(11000);
    ok(msgs.includes('timeout'), 'a command that never settles times out (10 s)');
    ok(msgs.includes('command_dropped'), 'commands queued behind it for > 5 s are dropped');
    ok(!fake.sdk.events.includes('cmd:next') && fake.requests('/me/player/repeat').length === 0, 'dropped commands were not replayed');
    fake.cfg.sdkHang = [];
    await page.tap('.t-next');
    ok(await waitFor(() => fake.sdk.events.includes('cmd:next')), 'fresh commands work again');
    await close(s);
  });

  await section('review: network failure during refresh is not a sign-out; Connect keeps polling', async () => {
    const s = await session({ sdk: 'init_error' });
    const { page, fake } = s;
    await signIn(page);
    await until(page, () => window.duoamp.spotify.engine?.mode === 'connect');
    fake.revokeAccessTokens();
    fake.cfg.tokenNetworkFailures = 2;
    const r = await page.evaluate(() => window.duoamp.spotify.engine.refreshState().then(() => 'ok', (e) => e.kind));
    ok(r === 'network', `refresh without network -> network error, not auth (${r})`);
    await page.evaluate(() => window.duoamp.spotify.engine.poll());
    const st1 = await page.evaluate(() => ({ signedIn: window.duoamp.spotify.signedIn, timer: window.duoamp.spotify.engine.timer !== undefined, failures: window.duoamp.spotify.engine.failures }));
    ok(st1.signedIn && st1.timer && st1.failures >= 1, `still signed in, next poll scheduled with backoff (${JSON.stringify(st1)})`);
    await page.evaluate(() => window.duoamp.spotify.engine.poll());
    const st2 = await page.evaluate(() => window.duoamp.spotify.engine.failures);
    ok(st2 === 0, 'recovers once the network is back');
    await close(s);
  });

  await section('review: SDK authentication_error retries reset on ready; exhausted -> Connect', async () => {
    const s = await session();
    const { page, fake } = s;
    await signIn(page);
    for (let i = 0; i < 2; i++) {
      fake.sdkEmit('authentication_error', { message: 'The access token expired' });
      await sleep(300);
      await until(page, () => window.duoamp.spotify.engine.ready, null, 4000);
    }
    ok((await svc(page)).mode === 'sdk' && (await page.evaluate(() => window.duoamp.spotify.engine.ready)), 'two separate auth errors, each recovered (retry count resets on ready)');
    await close(s);

    const s2 = await session({ sdkAuthFailOnReconnect: true });
    await signIn(s2.page);
    s2.fake.sdkEmit('authentication_error', { message: 'Invalid token scopes.' });
    ok(await until(s2.page, () => window.duoamp.spotify.engine?.mode === 'connect', null, 8000), 'auth error that persists after start -> fatal hook -> Connect');
    ok((await svc(s2.page)).fallback === 'SIGN-IN REJECTED', 'reason shown');
    await close(s2);
  });

  await section('review: busy never sticks; sign-out on load is explained; library loads in parallel', async () => {
    const s = await session({ sdkReadyDelayMs: 7000 });
    const { page } = s;
    await page.tap('.t-eject');
    await page.fill('.sheet-input', CLIENT_ID);
    await page.tap('.btn-connect');
    ok(await until(page, () => window.duoamp?.spotify?.playlists?.length === 3 && window.duoamp.spotify.busy, null, 6000), 'playlists loaded while the SDK is still starting');
    await page.evaluate(() => window.duoamp.spotify.disconnect());
    ok(!(await svc(page)).busy, 'DISCONNECT during engine start clears busy');
    ok(await signIn(page), 'CONNECT works again afterwards');
    await close(s);

    const s2 = await session();
    await signIn(s2.page);
    await s2.page.evaluate(() => {
      const sp = window.duoamp.spotify;
      sp.setModePref('connect');
      sp.setModePref('sdk');
    });
    ok(await until(s2.page, () => !window.duoamp.spotify.busy && window.duoamp.spotify.engine?.mode === 'sdk', null, 10000), 'superseded engine start leaves busy cleared');

    // The 6-month refresh limit surfaces as invalid_grant on load.
    s2.fake.cfg.refreshInvalidGrant = true;
    await s2.page.evaluate(() => {
      const k = 'duoamp.spotify.tokens.v1';
      const t = JSON.parse(localStorage.getItem(k));
      t.expiresAt = Date.now() - 1000;
      localStorage.setItem(k, JSON.stringify(t));
    });
    await s2.page.reload();
    ok(await until(s2.page, () => window.duoamp && !window.duoamp.spotify.signedIn, null, 8000), 'expired sign-in on load -> signed out');
    ok(await until(s2.page, () => /EXPIRED/.test(window.duoamp.app.main.msg ?? ''), null, 3000), 'marquee says why');
    ok(/EXPIRED/.test((await svc(s2.page)).authMessage ?? ''), 'connect sheet message set');
    await s2.page.tap('.t-eject');
    ok((await s2.page.textContent('.sheet-library')).includes('EXPIRED'), 'connect sheet shows it');
    await close(s2);
  });

  await section('review: storage quota, other-tab refresh, stray callback, restricted prev', async () => {
    const s = await session();
    const { page, fake } = s;
    await signIn(page);
    await pickPlaylist(page, 'pl120');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    ok(!!(await page.evaluate(() => localStorage.getItem('duoamp.spotify.cache.v1'))), 'track cache written');
    await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'duoamp.spotify.tokens.v1' && this.getItem('duoamp.spotify.cache.v1')) throw new DOMException('full', 'QuotaExceededError');
        return orig.call(this, k, v);
      };
    });
    fake.revokeAccessTokens();
    await page.evaluate(() => window.duoamp.spotify.api.get('/me'));
    const st = await page.evaluate(() => ({ t: JSON.parse(localStorage.getItem('duoamp.spotify.tokens.v1')).accessToken, c: localStorage.getItem('duoamp.spotify.cache.v1'), d: window.duoamp.diag.list().some((e) => /storage full/.test(e.msg)) }));
    ok(st.t === fake.issued.access.at(-1) && st.c === null && st.d, 'token write hit the quota -> cache cleared, write retried, logged');
    await close(s);

    const s2 = await session();
    await signIn(s2.page);
    const old = await s2.page.evaluate(() => JSON.parse(localStorage.getItem('duoamp.spotify.tokens.v1')));
    const minted = s2.fake.mint(old.scope);
    s2.fake.refreshTokens.delete(old.refreshToken); // another tab rotated it
    s2.fake.access.delete(old.accessToken);
    await s2.page.evaluate((m) => {
      const k = 'duoamp.spotify.tokens.v1';
      const t = JSON.parse(localStorage.getItem(k));
      localStorage.setItem(k, JSON.stringify({ ...t, accessToken: m.access, refreshToken: m.refresh, expiresAt: Date.now() + 3600e3 }));
    }, minted);
    const r = await s2.page.evaluate(() => window.duoamp.spotify.api.get('/me').then((x) => x.id, (e) => e.kind));
    ok(r === 'fakeuser' && (await svc(s2.page)).signedIn, `invalid_grant after another tab refreshed -> adopts its tokens (${r})`);

    const n = s2.fake.tokenRequests.length;
    await s2.page.goto(`${BASE}?test=1&sim=0&code=stalecode&state=stalestate`);
    await until(s2.page, () => window.duoamp?.spotify?.engine && !window.duoamp.spotify.busy, null, 15000);
    const v = await svc(s2.page);
    ok(v.signedIn && !v.authMessage && s2.fake.tokenRequests.length === n && !s2.page.url().includes('code='), 'stale ?code= while signed in (browser Back) is ignored quietly');
    await close(s2);

    const s3 = await session({ extraDisallows: { skipping_prev: true } });
    await signIn(s3.page);
    await pickPlaylist(s3.page, 'pl120');
    await until(s3.page, () => window.duoamp.spotify.loadStatus.state === 'done');
    await doubleTapRow(s3.page, 5);
    await until(s3.page, () => window.duoamp.engine.getState().status === 'playing' && window.duoamp.engine.getState().disallows.prev);
    await s3.page.evaluate(() => window.duoamp.engine.seek(20));
    await sleep(4000);
    const before = s3.fake.sdk.events.length;
    // aria-disabled only dims it (still pressable by a finger); Playwright needs force for that.
    await s3.page.tap('.t-prev', { force: true });
    await sleep(600);
    const evs = s3.fake.sdk.events.slice(before);
    ok(evs.includes('cmd:seek') && !evs.includes('cmd:prev'), `PREV past 3 s with skipping_prev disallowed restarts via seek, no previous command (${evs.join(',')})`);
    await close(s3);
  });

  await section('review: flat actions shape', async () => {
    const s = await session({ sdk: 'init_error', actionsFlat: true });
    const { page } = s;
    await signIn(page);
    await until(page, () => window.duoamp.spotify.engine?.mode === 'connect');
    await pickPlaylist(page, 'pl120');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    await doubleTapRow(page, 0);
    await sleep(1200);
    await page.evaluate(() => window.duoamp.spotify.engine.refreshState());
    ok(await until(page, () => window.duoamp.engine.getState().disallows.prev, null, 3000), 'disallows read from keys directly under actions');
    await close(s);
  });

  await section('sign-out returns to demo', async () => {
    const s = await session();
    const { page } = s;
    await signIn(page);
    await pickPlaylist(page, 'pl120');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    await page.evaluate(() => localStorage.setItem('duoamp.spotify.device.v1', 'phone-1'));
    await openLibrary(page);
    await page.tap('.btn-disconnect');
    await until(page, () => !window.duoamp.spotify.signedIn);
    const v = await st(page);
    ok(v.serviceLabel === '' && v.n === 139 && v.sourceLabel === 'DEMO LIBRARY', 'demo engine back');
    ok((await page.evaluate(() => ['tokens.v1', 'source.v1', 'cache.v1', 'device.v1'].map((k) => localStorage.getItem('duoamp.spotify.' + k)))).every((x) => x === null), 'tokens, last source, track cache and remembered device cleared');
    ok(!!(await page.evaluate(() => localStorage.getItem('duoamp.spotify.clientId'))), 'Client ID kept');
    ok(await page.isVisible('.sheet-library .btn-connect'), 'sheet switches to the connect view');
    ok((await page.evaluate(() => document.querySelectorAll('.pl-row').length)) === 139, 'demo playlist rows back');
    await page.reload();
    ok(!(await svc(page)).signedIn, 'still signed out after reload');
    await close(s);
  });

  await section('diagnostics contain no secrets', async () => {
    const s = await session();
    const { page, fake } = s;
    await signIn(page);
    await pickPlaylist(page, 'pl120');
    await until(page, () => window.duoamp.spotify.loadStatus.state === 'done');
    fake.revokeAccessTokens();
    await page.evaluate(() => window.duoamp.spotify.api.get('/me'));
    await doubleTapRow(page, 0);
    await sleep(500);
    await page.tap('.menu-btn');
    await page.tap('.menu .menu-item:has-text("DIAGNOSTICS")');
    const report = await page.textContent('[data-test="diag-report"]');
    const secrets = [...fake.issued.access, ...fake.issued.refresh, ...fake.issued.codes, ...fake.issued.verifiers];
    const leaked = secrets.filter((x) => report.includes(x) || report.includes(x.slice(0, 24)));
    ok(secrets.length >= 5 && leaked.length === 0, `report has none of ${secrets.length} secrets`);
    const console_leaks = secrets.filter((x) => consoleLines.some((l) => l.includes(x.slice(0, 24))));
    ok(console_leaks.length === 0, 'console output has none of them');
    for (const want of ['auth: SIGNED IN', 'tokenExpires:', 'mode: IN-BROWSER', 'sdk: READY', 'device:', 'viewport: 382x600', 'safe-area:', 'standalone: NO', 'user agent:', '== RECENT EVENTS', '== API ERRORS', 'posture: cover']) {
      ok(report.includes(want), `report has "${want}"`);
    }
    ok(/\d\d:\d\d:\d\d (INFO|WARN|ERROR)/.test(report) && /401 \/me/.test(report), 'timestamped events and the 401');
    await s.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await page.tap('.btn-copy-report');
    await sleep(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ok(clip.startsWith('DUOAMP') && secrets.every((x) => !clip.includes(x)), 'COPY REPORT copies the redacted report');
    await close(s);
  });

  // ------------------------------------------------------------------------
  await section('sheets fit and scroll', async () => {
    for (const skin of ['light', 'classic']) {
      for (const vp of [{ width: 382, height: 600 }, { width: 951, height: 600 }, { width: 669, height: 880 }]) {
        const s = await session({ extraPlaylists: 40 }, { viewport: vp, skin });
        const { page } = s;
        const check = async (label) => {
          const r = await page.evaluate(() => {
            const sheet = document.querySelector('.sheet');
            const pane = sheet.closest('.pane');
            const a = sheet.getBoundingClientRect();
            const p = pane.getBoundingClientRect();
            const body = sheet.querySelector('.sheet-body');
            const clipped = [...sheet.querySelectorAll('.btn-label, .title-text')].filter((t) => t.scrollWidth > t.clientWidth + 1 && t.clientWidth > 0).map((t) => t.textContent);
            const acts = [...sheet.querySelectorAll('.sheet-actions .btn')].every((b) => {
              const r = b.getBoundingClientRect();
              return r.bottom <= a.bottom + 0.5 && r.right <= a.right + 0.5 && r.left >= a.left - 0.5;
            });
            return { inside: a.top >= p.top - 0.5 && a.bottom <= p.bottom + 0.5 && a.left >= p.left - 0.5 && a.right <= p.right + 0.5, scrolls: body.scrollHeight > body.clientHeight, clipped, acts };
          });
          ok(r.inside && r.acts && r.clipped.length === 0, `${label} ${skin} ${vp.width}x${vp.height}: fits its pane${r.clipped.length ? ' clipped: ' + r.clipped.join(',') : ''}`);
          return r;
        };
        await page.tap('.t-eject');
        await check('connect sheet');
        await page.tap('.sheet-ok');
        if (vp.width === 382) {
          const touchScroll = async (sel, label) => {
            const box = await page.locator(sel).first().boundingBox();
            const cdp = await s.ctx.newCDPSession(page);
            const top0 = await page.evaluate(() => document.querySelector('.sheet-body').scrollTop);
            // Real touch events (synthesizeScrollGesture is a no-op in headless Chromium).
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 16 }] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await sleep(150);
            const top1 = await page.evaluate(() => document.querySelector('.sheet-body').scrollTop);
            ok(top1 > top0 + 40, `${label} ${skin}: touch drag scrolls the sheet body ${top0} -> ${Math.round(top1)}`);
          };
          await signIn(page);
          await until(page, () => window.duoamp.spotify.playlists?.length === 43);
          await openLibrary(page);
          await check('library sheet (43 playlists)');
          await touchScroll('.sheet-body .lib-row[data-id="pl120"]', 'library, drag starting on a playlist row');
          ok(await page.isVisible('.sheet-library') && (await svc(page)).load.state === 'idle', 'the drag did not pick the playlist');
          await touchScroll('.sheet-body .lib-row[data-id="plx10"]', 'library, second drag');
          await page.tap('.sheet-ok');
          await page.tap('.menu-btn');
          await page.tap('.menu .menu-item:has-text("DIAGNOSTICS")');
          await check('diagnostics sheet');
          await touchScroll('.sheet-diag .sheet-body > p.dim', 'diagnostics');
          await page.tap('.sheet-ok');
        }
        ok(s.errors.length === 0, `no console errors${s.errors.length ? ': ' + s.errors.join(' | ') : ''}`);
        await close(s);
      }
    }
  });
} finally {
  for (const s of sessions) s.fake.stop();
  await browser.close();
  server.stop();
}
if (process.env.CHECK_SELFTEST_FAIL) ok(false, 'self-test: forced failure (CHECK_SELFTEST_FAIL)');
console.log(failures ? `\n${failures} failure(s)` : '\nall Spotify checks passed (against the fake Spotify)');
process.exitCode = failures ? 1 : 0;
setTimeout(() => process.exit(failures ? 1 : 0), 100);
