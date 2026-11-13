#!/usr/bin/env node
/**
 * Drives the built app in Playwright and asserts state changes.
 *   node scripts/check.mjs [--no-build]
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './screenshots.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--no-build')) execSync('npx vite build', { cwd: root, stdio: 'inherit' });

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const server = await startServer();
const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 382, height: 600 }, deviceScaleFactor: 3, hasTouch: true });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.url}?test=1&sim=0`);
  await page.evaluate(() => document.fonts.ready);
  const st = () => page.evaluate(() => window.duoamp.engine.getState());
  const prefs = () => page.evaluate(() => JSON.parse(JSON.stringify(window.duoamp.prefs)));
  const marquee = () => page.textContent('.marquee-text');
  const centre = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  const drag = async (sel, dx, dy, during) => {
    const k = await centre(`${sel} .slider-knob`);
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x + dx / 2, k.y + dy / 2, { steps: 4 });
    await page.mouse.move(k.x + dx, k.y + dy, { steps: 4 });
    const seen = during ? await during() : undefined;
    await page.mouse.up();
    return seen;
  };

  ok((await page.getAttribute('html', 'data-posture')) === 'cover', 'auto-detects cover at 382x600');
  ok((await st()).status === 'stopped', 'starts stopped');
  ok((await st()).index === 30, 'track 31 loaded');
  ok(
    (await page.evaluate(() => document.querySelector('.marquee-text').textContent)).startsWith('31. JOHANNES BRECHT - ALL WE GOT (2:36)  ***  31. '),
    'marquee format "31. ARTIST - TITLE (2:36)  ***  " repeated',
  );
  const row100 = await page.evaluate(() => document.querySelector('.pl-row[data-i="99"] .pl-name').textContent);
  ok(row100.includes('???') && !/[぀-ヿ]/.test(row100), `unsupported script falls back to "?": "${row100}"`);
  const density = await page.evaluate(() => {
    const sc = document.querySelector('.pl-scroll');
    const row = document.querySelector('.pl-row');
    const name = document.querySelector('.pl-name');
    const fs = parseFloat(getComputedStyle(name).fontSize);
    return { rows: sc.clientHeight / row.offsetHeight, chars: Math.floor(name.getBoundingClientRect().width / (fs * 0.75)) };
  });
  ok(density.rows >= 18 && density.rows <= 22, `cover playlist shows ~19 rows (${density.rows.toFixed(1)})`);
  ok(density.chars >= 33 && density.chars <= 38, `row fits ~33+ characters before ".." (${density.chars})`);
  ok(await page.evaluate(() => document.fonts.check("12px 'DuoPixel'", 'A')), 'DuoPixel font loaded');
  {
    const p2 = await ctx.newPage();
    await p2.goto(`${server.url}?sim=0`);
    ok((await p2.evaluate(() => typeof window.duoamp)) === 'undefined', 'test hook hidden without ?test=1');
    await p2.close();
  }

  await page.tap('.t-play');
  await page.waitForTimeout(1200);
  let s = await st();
  ok(s.status === 'playing' && s.position > 0.8, `play: playing, position ${s.position.toFixed(2)}s`);

  await page.tap('.t-pause');
  ok((await st()).status === 'paused', 'pause');
  await page.tap('.t-pause');
  ok((await st()).status === 'playing', 'pause again resumes');

  const vol0 = (await st()).volume;
  const volMsg = await drag('.sl-volume', -40, 0, marquee);
  const vol1 = (await st()).volume;
  ok(vol1 < vol0 - 0.1, `volume drag ${vol0.toFixed(2)} -> ${vol1.toFixed(2)}`);
  ok(/^VOLUME: \d+%$/.test(volMsg), `marquee during volume drag: "${volMsg}"`);
  ok(Math.abs((await prefs()).volume - vol1) < 1e-6, 'volume persisted in prefs object');

  await drag('.sl-balance', 30, 0);
  const balOff = (await st()).balance;
  ok(balOff > 0.2, `balance drag right: ${balOff.toFixed(2)}`);
  const bal = await centre('.sl-balance');
  await page.mouse.click(bal.x, bal.y);
  await page.mouse.click(bal.x, bal.y);
  ok((await st()).balance === 0, 'balance double-tap resets to centre');

  const seekMsg = await drag('.sl-seek', 120, 0, marquee);
  ok(/^SEEK TO: \d+:\d\d\/2:36 \(\d+%\)$/.test(seekMsg), `marquee during seek: "${seekMsg}"`);
  s = await st();
  ok(s.position > 30, `seek applied on release: ${s.position.toFixed(1)}s`);

  await page.tap('.time-hit');
  ok((await prefs()).timeMode === 'remaining', 'tap time -> remaining');
  await page.tap('.time-hit');
  ok((await prefs()).timeMode === 'elapsed', 'tap time -> elapsed');

  // EQ band drag updates the store and the graph canvas.
  const graphBefore = await page.evaluate(() => document.querySelector('.eq-graph-canvas').toDataURL());
  const band0 = (await prefs()).eq.bands[0];
  const eqMsg = await drag('.win-eq .sl-eq:not(.sl-preamp)', 0, -30, marquee);
  const band1 = (await prefs()).eq.bands[0];
  ok(band1 > band0 + 2, `EQ 60Hz drag ${band0} -> ${band1}`);
  ok(/^60 HZ: \+\d+\.\d DB$/.test(eqMsg), `marquee during EQ drag: "${eqMsg}"`);
  await page.waitForTimeout(100);
  const graphAfter = await page.evaluate(() => document.querySelector('.eq-graph-canvas').toDataURL());
  ok(graphBefore !== graphAfter, 'EQ graph redraws');

  await page.tap('.btn-presets');
  ok(await page.isVisible('.presets'), 'presets menu opens');
  await page.tap('.presets .menu-item:has-text("ROCK")');
  ok((await prefs()).eq.bands.join() === '7,4,-5,-7,-3,4,8,10,10,10', 'ROCK preset applied');

  await page.tap('.btn-eq');
  ok((await page.locator('.win-eq').count()) === 0 && (await page.isVisible('.win-vis')), 'EQ toggle swaps slot to Visualization');
  await page.tap('.btn-eq');
  ok(await page.isVisible('.win-eq'), 'EQ toggle back');
  await page.tap('.btn-pl');
  ok((await page.locator('.win-pl').count()) === 0, 'PL toggle hides playlist');
  ok(await page.isVisible('.win-vis'), 'Vis fills freed space');
  await page.tap('.btn-pl');
  ok(await page.isVisible('.win-pl'), 'PL toggle back');

  // Playlist: tap selects, double tap plays.
  const row = page.locator('.pl-row[data-i="27"]');
  await row.scrollIntoViewIfNeeded();
  await row.tap();
  ok(await row.evaluate((e) => e.classList.contains('is-selected')), 'row tap selects');
  ok((await st()).index === 30, 'single tap does not play');
  await row.tap();
  await page.waitForTimeout(50);
  ok((await st()).index === 27, 'double tap plays row 28');
  await page.evaluate(() => (document.querySelector('.pl-scroll').scrollTop = 0));
  await page.tap('.btn-pl-now');
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => {
    const sc = document.querySelector('.pl-scroll');
    const r = document.querySelector('.pl-row.is-current');
    return r.offsetTop >= sc.scrollTop && r.offsetTop + r.offsetHeight <= sc.scrollTop + sc.clientHeight;
  }), 'NOW scrolls current row into view');

  await page.tap('.t-next');
  ok((await st()).index === 28, 'next');
  await page.tap('.t-prev');
  ok((await st()).index === 27, 'prev');
  await page.tap('.btn-shuffle');
  ok((await st()).shuffle === true, 'shuffle on');
  await page.tap('.btn-rep');
  ok((await st()).repeat === true, 'repeat on');

  // Auto-advance at end of track.
  await page.evaluate(() => {
    const e = window.duoamp.engine;
    e.setShuffle(false);
    e.seek(e.getState().duration - 0.3);
  });
  await page.waitForTimeout(800);
  ok((await st()).index === 28 && (await st()).status === 'playing', 'auto-advances to next track');

  await page.tap('.t-stop');
  s = await st();
  ok(s.status === 'stopped' && s.position === 0, 'stop');
  await page.keyboard.press('x');
  ok((await st()).status === 'playing', 'keyboard X plays');
  await page.keyboard.press('v');
  ok((await st()).status === 'stopped', 'keyboard V stops');

  await page.tap('.t-eject');
  ok(await page.isVisible('.sheet:has-text("COMING SOON")'), 'eject opens connect sheet');
  await page.tap('.sheet-ok');
  ok((await page.locator('.sheet').count()) === 0, 'sheet closes');

  await page.tap('.menu-btn');
  ok(await page.isVisible('.menu'), 'menu opens');
  await page.tap('.menu .chip:has-text("CLASSIC")');
  ok((await page.getAttribute('html', 'data-skin')) === 'classic', 'menu switches skin to classic');
  await page.tap('.menu-btn');
  await page.tap('.menu .chip:has-text("BOOK")');
  ok((await page.getAttribute('html', 'data-posture')) === 'book' && (await page.locator('.pane').count()) === 2, 'menu layout override -> book (2 panes)');

  // Visualiser tap cycles bars -> scope -> off.
  await page.tap('.vis-screen');
  ok((await prefs()).visMode === 'scope', 'vis tap -> scope');
  await page.tap('.vis-screen');
  ok((await prefs()).visMode === 'off', 'vis tap -> off');
  await page.tap('.vis-screen');
  ok((await prefs()).visMode === 'bars', 'vis tap -> bars');

  await page.waitForTimeout(300);
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  ok((await page.getAttribute('html', 'data-skin')) === 'classic', 'skin persisted across reload');
  ok((await page.getAttribute('html', 'data-posture')) === 'book', 'layout override persisted');
  ok((await page.getAttribute('meta[name="theme-color"]', 'content')) === '#08080d', 'theme-color tracks skin');

  // Nothing overflows its window or pane, in every posture x skin.
  for (const size of [[382, 600], [951, 600], [867, 600], [669, 880]]) {
    for (const skin of ['light', 'classic']) {
      for (const eq of [false, true]) {
        await page.setViewportSize({ width: size[0], height: size[1] });
        await page.goto(`${server.url}?test=1&sim=0&layout=auto&skin=${skin}`);
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.evaluate(() => document.fonts.ready);
        if (eq) await page.tap('.btn-eq');
        await page.waitForTimeout(150);
        const bad = await page.evaluate(() => {
          const out = [];
          for (const pane of document.querySelectorAll('.pane')) {
            const pr = pane.getBoundingClientRect();
            for (const w of pane.querySelectorAll(':scope > .win')) {
              const wr = w.getBoundingClientRect();
              if (wr.left < pr.left - 0.5 || wr.right > pr.right + 0.5 || wr.top < pr.top - 0.5 || wr.bottom > pr.bottom + 0.5) out.push(`${w.className} outside pane`);
              for (const c of w.querySelectorAll('.btn, .slider, .lcd, .lbl')) {
                if (c.closest('.pl-scroll')) continue;
                const cs = getComputedStyle(c);
                if (cs.display === 'none') continue;
                const r = c.getBoundingClientRect();
                if (r.left < wr.left - 0.5 || r.right > wr.right + 0.5 || r.top < wr.top - 0.5 || r.bottom > wr.bottom + 0.5) out.push(`${c.className} outside ${w.className}`);
              }
              for (const t of w.querySelectorAll('.lbl, .btn-label, .title-text')) {
                if (t.scrollWidth > t.clientWidth + 1 && t.clientWidth > 0) out.push(`text clipped: ${t.textContent}`);
              }
            }
          }
          return out;
        });
        ok(bad.length === 0, `no overflow at ${size.join('x')} ${skin} eq=${eq}${bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''}`);
      }
    }
  }
  // prefers-reduced-motion: marquee holds still.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 382, height: 600 });
  await page.goto(`${server.url}?test=1&sim=0`);
  await page.evaluate(() => window.duoamp.engine.play());
  const t1 = await page.evaluate(() => document.querySelector('.marquee-text').style.transform);
  await page.waitForTimeout(700);
  const t2 = await page.evaluate(() => document.querySelector('.marquee-text').style.transform);
  ok(t1 === t2 && !t1, `reduced motion: marquee static ("${t2}")`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await page.evaluate(() => window.duoamp.engine.play());
  await page.waitForTimeout(500);
  const t3 = await page.evaluate(() => document.querySelector('.marquee-text').style.transform);
  ok(/translate3d\(-\d/.test(t3), `marquee scrolls normally ("${t3}")`);

  ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.stop();
}
console.log(failures ? `${failures} failure(s)` : 'all checks passed');
setTimeout(() => process.exit(failures ? 1 : 0), 100);
