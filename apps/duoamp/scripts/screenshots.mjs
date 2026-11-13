#!/usr/bin/env node
/**
 * Builds the app, serves dist/ with `vite preview`, and captures every
 * posture × skin, in simulator mode and full-bleed at the researched
 * Safari viewport sizes, into ./screenshots (gitignored).
 *
 *   node scripts/screenshots.mjs            # build + capture all
 *   node scripts/screenshots.mjs --no-build # reuse dist/
 *   node scripts/screenshots.mjs --only=bleed-cover
 *
 * Uses the preinstalled Playwright (require('playwright')); it is not a dependency.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'screenshots');
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const PORT = 4179;

export const SKINS = ['light', 'classic'];
/** Full-bleed sizes from the Safari 27.1 viewport research (CSS px). Posture is auto-detected. */
export const BLEED = [
  { name: 'cover', w: 382, h: 600 },
  { name: 'book', w: 951, h: 600 },
  { name: 'book-867', w: 867, h: 600 },
  { name: 'tabletop', w: 669, h: 880 },
];
export const SIM = ['cover', 'book', 'tabletop'];

export async function startServer() {
  const proc = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite preview did not start')), 20000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes(String(PORT))) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on('exit', (c) => reject(new Error(`vite preview exited ${c}`)));
  });
  proc.stdout.resume();
  proc.stderr.resume();
  return { url: `http://127.0.0.1:${PORT}/`, stop: () => proc.kill('SIGTERM') };
}

async function main() {
  if (!args.includes('--no-build')) execSync('npx vite build', { cwd: root, stdio: 'inherit' });
  mkdirSync(outDir, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const shots = [];
  try {
    const capture = async (name, viewport, dpr, query, prep) => {
      if (only && !name.includes(only)) return;
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr, hasTouch: true, isMobile: false });
      const page = await ctx.newPage();
      page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      await page.goto(`${server.url}?test=1&${query}`);
      await page.evaluate(() => document.fonts.ready);
      // Start track 31 fresh at 1:10 so the LCD and visualiser have something to show
      // and the marquee is in its initial hold (number prefix at the left edge).
      await page.evaluate(() => {
        const { engine } = window.duoamp;
        engine.playIndex(30);
        engine.seek(70);
      });
      if (prep) await prep(page);
      await page.waitForTimeout(950);
      const file = join(outDir, `${name}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
      await ctx.close();
    };

    for (const skin of SKINS) {
      for (const b of BLEED) {
        await capture(`bleed-${b.name}-${skin}`, { width: b.w, height: b.h }, 3, `sim=0&skin=${skin}`);
      }
      for (const p of SIM) {
        await capture(`sim-${p}-${skin}`, { width: 1280, height: 1000 }, 2, `sim=1&layout=${p}&skin=${skin}`);
      }
    }
    // Low-density rendering stays visible in review.
    await capture('dpr1-sim-book-classic', { width: 1280, height: 1000 }, 1, 'sim=1&layout=book&skin=classic');
    await capture('dpr1-sim-cover-light', { width: 1280, height: 900 }, 1, 'sim=1&layout=cover&skin=light');
    await capture('dpr1-bleed-cover-light', { width: 382, height: 600 }, 1, 'sim=0&skin=light');

    // LCD time readouts: 00:00, 01:11, 10:10 and remaining -03:59, both skins.
    for (const skin of SKINS) {
      if (only && !`digits-${skin}`.includes(only)) continue;
      const ctx = await browser.newContext({ viewport: { width: 382, height: 600 }, deviceScaleFactor: 3 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`digits: ${e.message}`));
      await page.goto(`${server.url}?test=1&sim=0&skin=${skin}`);
      await page.evaluate(() => document.fonts.ready);
      for (const [name, sec, mode] of [['0000', 0, 'elapsed'], ['0111', 71, 'elapsed'], ['1010', 610, 'elapsed'], ['m0359', 239, 'remaining']]) {
        await page.evaluate(([s, m]) => {
          window.duoamp.prefs.timeMode = m;
          window.duoamp.app.main.lcdOverride = s;
        }, [sec, mode]);
        await page.waitForTimeout(120);
        const file = join(outDir, `digits-${skin}-${name}.png`);
        await page.locator('.lcd-main').screenshot({ path: file });
        shots.push(file);
      }
      await ctx.close();
    }

    // A few states worth reviewing.
    await capture('state-cover-noeq-light', { width: 382, height: 600 }, 3, 'sim=0&skin=light', async (p) => {
      await p.click('.btn-eq');
    });
    // EQ visibility is remembered per posture; defaults match the photos (EQ on cover, Vis when open).
    await capture('state-tabletop-eq-classic', { width: 669, height: 880 }, 3, 'sim=0&skin=classic', async (p) => {
      await p.click('.btn-eq');
    });
    await capture('state-book-eq-light', { width: 951, height: 600 }, 3, 'sim=0&skin=light', async (p) => {
      await p.click('.btn-eq');
    });
    await capture('state-book-scope-classic', { width: 951, height: 600 }, 3, 'sim=0&skin=classic', async (p) => {
      await p.click('.vis-screen');
    });
    await capture('state-book-nopl-light', { width: 951, height: 600 }, 3, 'sim=0&skin=light', async (p) => {
      await p.click('.btn-pl');
    });
    await capture('state-menu-light', { width: 382, height: 600 }, 3, 'sim=0&skin=light', async (p) => {
      await p.click('.menu-btn');
    });
    await capture('state-menu-classic', { width: 951, height: 600 }, 3, 'sim=0&skin=classic', async (p) => {
      await p.click('.menu-btn');
    });
    await capture('state-presets-light', { width: 382, height: 600 }, 3, 'sim=0&skin=light', async (p) => {
      await p.click('.btn-presets');
    });
    await capture('state-sheet-classic', { width: 382, height: 600 }, 3, 'sim=0&skin=classic', async (p) => {
      await p.click('.t-eject');
    });

    // Spotify states, against the fake Spotify (scripts/fake-spotify.mjs): no real account involved.
    const { FakeSpotify, CLIENT_ID } = await import('./fake-spotify.mjs');
    const spotifyShot = async (name, viewport, query, fakeOpts, prep) => {
      if (only && !name.includes(only)) return;
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 3, hasTouch: true });
      const fake = new FakeSpotify({ extraPlaylists: 9, ...fakeOpts });
      await fake.install(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
      await page.goto(`${server.url}?test=1&${query}`);
      await page.evaluate(() => document.fonts.ready);
      const signIn = async () => {
        await page.click('.t-eject');
        await page.fill('.sheet-input', CLIENT_ID);
        await page.click('.btn-connect');
        await page.waitForFunction(() => window.duoamp?.spotify?.signedIn && window.duoamp.spotify.engine && !window.duoamp.spotify.busy && window.duoamp.spotify.playlists?.length, null, { timeout: 20000 });
      };
      const playRow = async (i) => {
        // As if the row had been tapped (audio unlocked by a gesture).
        fake.sdk.activated = true;
        await page.evaluate(async () => {
          const sp = window.duoamp.spotify;
          await sp.loadSource(sp.playlistSource(sp.playlists[0]));
        });
        await page.evaluate((r) => window.duoamp.engine.playIndex(r), i);
        await page.waitForFunction(() => window.duoamp.engine.getState().status === 'playing');
        await page.evaluate(() => window.duoamp.engine.seek(70));
      };
      await prep(page, { signIn, playRow, fake });
      await page.waitForTimeout(900);
      const file = join(outDir, `${name}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
      fake.stop();
      await ctx.close();
    };
    const cover = { width: 382, height: 600 };
    for (const skin of SKINS) {
      await spotifyShot(`spotify-connect-sheet-${skin}`, cover, `sim=0&skin=${skin}`, {}, async (p) => {
        await p.click('.t-eject');
      });
      await spotifyShot(`spotify-library-sheet-${skin}`, cover, `sim=0&skin=${skin}`, {}, async (p, { signIn, playRow }) => {
        await signIn();
        await playRow(2);
        await p.click('.t-eject');
      });
      await spotifyShot(`spotify-library-remote-${skin}`, cover, `sim=0&skin=${skin}`, { sdk: 'init_error' }, async (p, { signIn, playRow }) => {
        await signIn();
        await playRow(2);
        await p.waitForTimeout(1500);
        await p.click('.btn-pl-add');
      });
      await spotifyShot(`spotify-diagnostics-${skin}`, cover, `sim=0&skin=${skin}`, {}, async (p, { signIn, playRow }) => {
        await signIn();
        await playRow(2);
        await p.click('.menu-btn');
        await p.click('.menu .menu-item:has-text("DIAGNOSTICS")');
      });
      await spotifyShot(`spotify-playing-${skin}`, cover, `sim=0&skin=${skin}`, {}, async (p, { signIn, playRow }) => {
        await signIn();
        await playRow(30);
      });
      await spotifyShot(`spotify-art-${skin}`, cover, `sim=0&skin=${skin}`, {}, async (p, { signIn, playRow }) => {
        await signIn();
        await playRow(4);
        await p.click('.btn-eq');
        await p.evaluate(() => {
          window.duoamp.prefs.visMode = 'art';
        });
      });
      await spotifyShot(`spotify-menu-${skin}`, cover, `sim=0&skin=${skin}`, {}, async (p, { signIn, playRow }) => {
        await signIn();
        await playRow(4);
        await p.click('.menu-btn');
      });
    }
    await spotifyShot('spotify-library-book-classic', { width: 951, height: 600 }, 'sim=0&skin=classic', {}, async (p, { signIn, playRow }) => {
      await signIn();
      await playRow(8);
      await p.click('.btn-pl-add');
    });
    await spotifyShot('spotify-art-book-light', { width: 951, height: 600 }, 'sim=0&skin=light', {}, async (p, { signIn, playRow }) => {
      await signIn();
      await playRow(8);
      await p.evaluate(() => {
        window.duoamp.prefs.visMode = 'art';
      });
    });
  } finally {
    await browser.close();
    server.stop();
  }
  console.log(shots.map((s) => `  ${s}`).join('\n'));
  if (errors.length) {
    console.error('Console errors:\n' + errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`${shots.length} screenshots, no console errors`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().finally(() => setTimeout(() => process.exit(), 100));
