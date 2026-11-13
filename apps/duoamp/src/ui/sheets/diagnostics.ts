import { APP_NAME, APP_VERSION } from '../../config';
import { diag, fmtClock, redact } from '../../spotify/diag';
import type { AppContext } from '../context';
import { h } from '../dom';
import { copyText, sheetButton, type SheetSpec } from './kit';

function safeArea(): string {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const v = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((x) => Math.round(parseFloat(x) || 0));
  probe.remove();
  return `T${v[0]} R${v[1]} B${v[2]} L${v[3]}`;
}

function standalone(): string {
  const nav = navigator as Navigator & { standalone?: boolean };
  const dm = ['standalone', 'fullscreen', 'minimal-ui', 'browser'].find((m) => matchMedia(`(display-mode: ${m})`).matches) ?? '?';
  return `${nav.standalone === true || dm === 'standalone' || dm === 'fullscreen' ? 'YES' : 'NO'} (display-mode ${dm}${nav.standalone !== undefined ? `, navigator.standalone ${nav.standalone}` : ''})`;
}

/** Plain-text report for the user to paste back. Never contains tokens, the verifier or the auth code. */
export function buildReport(ctx: AppContext): string {
  const lines: string[] = [];
  const kv = (k: string, v: string) => lines.push(`${k}: ${v}`);
  const sp = ctx.spotify;
  lines.push(`${APP_NAME} ${APP_VERSION} DIAGNOSTICS  ${new Date().toISOString()}`);
  lines.push('');
  lines.push('== PLAYBACK');
  const s = ctx.engine.getState();
  kv('engine', s.serviceLabel ? `SPOTIFY ${sp.engine?.mode ?? '?'}` : 'DEMO (MOCK)');
  kv('status', `${s.status} ${Math.round(ctx.engine.getPosition())}s / ${Math.round(s.duration)}s`);
  kv('current', s.current ? `${s.current.artist} - ${s.current.title} (row ${s.index >= 0 ? s.index + 1 : 'not in list'})` : '-');
  kv('list', `${s.sourceLabel} (${s.tracks.length} tracks${s.loading ? ', loading' : ''})`);
  kv('caps', Object.entries(s.capabilities).map(([k, v]) => `${k}=${v ? 1 : 0}`).join(' '));
  const dis = Object.entries(s.disallows).filter(([, v]) => v).map(([k]) => k);
  kv('disallows', dis.join(' ') || 'none');
  lines.push('');
  lines.push('== SPOTIFY');
  for (const [k, v] of Object.entries(sp.describe())) kv(k, v);
  lines.push('');
  lines.push('== DEVICE');
  kv('viewport', `${innerWidth}x${innerHeight} @${devicePixelRatio}x, visual ${Math.round(visualViewport?.width ?? 0)}x${Math.round(visualViewport?.height ?? 0)}`);
  kv('screen', `${screen.width}x${screen.height}`);
  kv('posture', `${ctx.posture()} (layout ${document.documentElement.dataset.mode ?? '?'}, pref ${ctx.prefs.layout})`);
  kv('safe-area', safeArea());
  kv('standalone', standalone());
  kv('secure context', String(isSecureContext));
  kv('online', String(navigator.onLine));
  kv('visibility', document.visibilityState);
  kv('user agent', navigator.userAgent);
  lines.push('');
  lines.push('== RECENT EVENTS');
  const ev = diag.list().slice(-30);
  for (const e of ev) lines.push(`${fmtClock(e.t)} ${e.level.toUpperCase().padEnd(5)} ${e.kind}: ${e.msg}`);
  if (!ev.length) lines.push('(none)');
  lines.push('');
  lines.push('== API ERRORS');
  const errs = sp.api.lastErrors.slice(-10);
  for (const e of errs) lines.push(`${fmtClock(e.t)} ${e.status || 'NET'} ${e.path}${e.reason ? ' ' + e.reason : ''}`);
  if (!errs.length) lines.push('(none)');
  return redact(lines.join('\n'));
}

export function buildDiagSheet(ctx: AppContext, body: HTMLElement): SheetSpec {
  const pre = h('pre', 'diag-pre', '');
  pre.setAttribute('data-test', 'diag-report');
  body.append(h('p', 'dim', 'FOR TROUBLESHOOTING. CONTAINS NO PASSWORDS OR TOKENS.'), pre);
  const render = () => {
    const keep = body.scrollTop;
    pre.textContent = buildReport(ctx);
    body.scrollTop = keep;
  };
  render();
  const copy = sheetButton('COPY REPORT', async () => {
    const ok = await copyText(buildReport(ctx));
    ctx.message(ok ? 'DIAGNOSTICS COPIED' : 'COPY FAILED: SELECT THE TEXT INSTEAD', 1500);
  }, 'btn-copy-report');
  const refresh = sheetButton('REFRESH', render, 'btn-diag-refresh');
  return { title: 'DIAGNOSTICS', wide: true, actions: [copy, refresh] };
}
