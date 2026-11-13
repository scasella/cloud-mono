import { redirectUriProblem } from '../../spotify/config';
import type { ModePref, SpotifyService } from '../../spotify/service';
import type { PlaylistInfo } from '../../spotify/parse';
import type { AppContext } from '../context';
import { h } from '../dom';
import { pressable } from '../controls';
import { pixelText } from '../pixelText';
import { copyText, fitText, onRowTap, para, sheetButton, type SheetSpec } from './kit';

/**
 * The music-source sheet (eject / ADD). Signed out: the three dashboard steps,
 * the exact redirect URI with a copy button, the Client ID field and CONNECT.
 * Signed in: account, playback mode, devices (remote mode), playlists + Liked
 * Songs, DISCONNECT.
 */
export function buildLibrarySheet(ctx: AppContext, body: HTMLElement, close: () => void, openDiag: () => void): SheetSpec {
  const sp = ctx.spotify;
  body.classList.add('lib-sheet');
  let mode: 'out' | 'in' | null = null;
  let actions: HTMLElement[] = [];
  const actionsHost = h('div', 'sheet-actions-inner');
  actionsHost.style.display = 'contents';
  let update: () => void = () => undefined;

  const render = () => {
    const want = sp.signedIn ? 'in' : 'out';
    if (want !== mode) {
      mode = want;
      body.textContent = '';
      actionsHost.textContent = '';
      const built = want === 'in' ? signedIn(ctx, sp, body, close, openDiag) : signedOut(sp, body);
      update = built.update;
      actions = built.actions;
      actionsHost.append(...actions);
    }
    update();
  };
  let raf = 0;
  const unsub = sp.subscribe(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  });
  render();
  const ok = sheetButton('OK', close, 'sheet-ok');
  return {
    title: 'MUSIC SOURCE: SPOTIFY',
    actions: [actionsHost, ok],
    dispose: () => {
      unsub();
      cancelAnimationFrame(raf);
    },
  };
}

function signedOut(sp: SpotifyService, body: HTMLElement) {
  const uri = sp.redirectUri;
  const uriEl = h('div', 'sheet-uri', uri, { 'data-test': 'redirect-uri' });
  const copyBtn = sheetButton('COPY URI', async () => {
    const ok = await copyText(uri);
    copyBtn.querySelector('.btn-label')!.textContent = ok ? 'COPIED' : 'SELECT + COPY';
    setTimeout(() => (copyBtn.querySelector('.btn-label')!.textContent = 'COPY URI'), 1500);
  }, 'btn-copy-uri');
  body.append(
    h('div', 'sheet-big', 'SPOTIFY'),
    para('CONNECT YOUR OWN SPOTIFY ACCOUNT. ONE-TIME SETUP AT DEVELOPER.SPOTIFY.COM/DASHBOARD:'),
    para('1. CREATE AN APP. TICK WEB API AND WEB PLAYBACK SDK.'),
    para('2. ADD THIS REDIRECT URI, EXACTLY AS SHOWN:'),
    uriEl,
    h('div', 'sheet-line', [copyBtn]),
  );
  const problem = redirectUriProblem(uri);
  if (problem) {
    const warn = h('div', 'sheet-warn', [h('span', '', pixelText(problem.text))]);
    if (problem.fix) {
      const a = h('a', '', ` OPEN ${pixelText(problem.fix)}`, { href: problem.fix });
      warn.append(a);
    }
    body.append(warn);
  }
  let input: HTMLInputElement | null = null;
  if (sp.clientIdBuiltIn) {
    body.append(para('3. UNDER USER MANAGEMENT, ADD THE SPOTIFY ACCOUNT YOU WILL USE (UP TO 5). THIS COPY OF DUOAMP ALREADY HAS ITS CLIENT ID.'));
  } else {
    body.append(para('3. UNDER USER MANAGEMENT, ADD THE SPOTIFY ACCOUNT YOU WILL USE (UP TO 5). THEN PASTE THE APP\'S CLIENT ID:'));
    input = h('input', 'sheet-input', [], {
      type: 'text', inputmode: 'latin', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      placeholder: '32-CHARACTER CLIENT ID', 'aria-label': 'Spotify Client ID', name: 'client-id',
    });
    input.value = sp.clientId ?? '';
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void sp.connect(input!.value);
    });
    body.append(input);
  }
  body.append(para('PLAYBACK NEEDS SPOTIFY PREMIUM. UNTIL YOU CONNECT, DUOAMP PLAYS ITS SILENT DEMO.', 'dim'));
  const msg = h('div', 'sheet-warn', '');
  msg.style.display = 'none';
  body.append(msg);
  const connect = sheetButton('CONNECT', () => {
    if (sp.busy) return;
    void sp.connect(input ? input.value : sp.clientId ?? '');
  }, 'btn-connect');
  return {
    actions: [connect],
    update: () => {
      msg.textContent = sp.authMessage ? pixelText(sp.authMessage) : '';
      msg.style.display = sp.authMessage ? '' : 'none';
    },
  };
}

function signedIn(ctx: AppContext, sp: SpotifyService, body: HTMLElement, close: () => void, openDiag: () => void) {
  const account = h('span', '', '');
  const modeText = h('span', '', '');
  const fallback = h('p', 'dim', '');
  const chips = h('div', 'menu-chips');
  const modeBtns = new Map<ModePref, HTMLButtonElement>();
  for (const [m, label] of [['auto', 'AUTO'], ['sdk', 'IN BROWSER'], ['connect', 'REMOTE']] as Array<[ModePref, string]>) {
    const b = h('button', 'btn chip', [h('span', 'led'), h('span', 'btn-label', label)], { type: 'button', role: 'radio', 'data-mode': m });
    pressable(b, () => {
      if (sp.modePref !== m) sp.setModePref(m);
    });
    modeBtns.set(m, b);
    chips.append(b);
  }
  const devHead = h('div', 'sheet-row sheet-head', [h('span', '', 'DEVICES'), h('span', 'dim', '')]);
  const devRefresh = sheetButton('REFRESH DEVICES', () => void sp.refreshDevices(), 'btn-devices');
  const devList = h('div', 'lib-list lib-devices', [], { role: 'listbox', 'aria-label': 'Spotify devices' });
  const devNote = para('NO DEVICE FOUND. OPEN SPOTIFY ON YOUR PHONE, START PLAYING SOMETHING, THEN TAP REFRESH.', 'dim');
  const devSection = h('div', 'lib-devices-section', [devHead, devList, devNote, h('div', 'sheet-line', [devRefresh])]);
  const plHead = h('div', 'sheet-row sheet-head', [h('span', '', 'PLAYLISTS'), h('span', 'dim', '')]);
  const plList = h('div', 'lib-list lib-playlists', [], { role: 'listbox', 'aria-label': 'Playlists' });
  const status = h('p', 'sheet-note', '');
  const openLink = h('a', 'lib-open', '', { target: '_blank', rel: 'noopener' });
  const linkLine = h('p', '', [openLink]);

  body.append(
    h('div', 'sheet-big', 'SPOTIFY'),
    h('div', 'sheet-row', [h('span', '', 'ACCOUNT'), account]),
    h('div', 'sheet-row', [h('span', '', 'MODE'), modeText]),
    h('div', 'sheet-line', [chips]),
    fallback,
    devSection,
    plHead,
    plList,
    status,
    linkLine,
  );

  onRowTap(devList, '.lib-row', (row) => {
    const id = row.dataset.id;
    if (id) sp.transferTo(id);
  });
  onRowTap(plList, '.lib-row', (row) => {
    const id = row.dataset.id!;
    const src = id === 'liked' ? sp.likedSource() : (() => {
      const p = sp.playlists?.find((x) => x.id === id);
      return p ? sp.playlistSource(p) : null;
    })();
    if (!src) return;
    ctx.message(`LOADING: ${src.name}`, 1500);
    void sp.loadSource(src);
    close();
  });

  let builtPlaylists: PlaylistInfo[] | null | undefined;
  let builtLiked: number | null | undefined;
  let devKey = '';
  const row = (id: string, name: string, count: string, dim = false) => {
    const n = h('span', 'pl-name');
    const r = h('div', `pl-row lib-row${dim ? ' is-dim' : ''}`, [n, h('span', 'pl-dur', count)], { role: 'option', tabindex: '0', 'data-id': id });
    (r as HTMLElement & { _name?: string })._name = name;
    return r;
  };
  const fitRows = (list: HTMLElement) => {
    requestAnimationFrame(() => {
      for (const r of list.querySelectorAll<HTMLElement>('.lib-row')) {
        fitText(r.querySelector('.pl-name')!, (r as HTMLElement & { _name?: string })._name ?? '');
      }
    });
  };

  const update = () => {
    account.textContent = pixelText(sp.profile?.displayName ?? '...');
    const e = sp.engine;
    modeText.textContent = sp.busy ? 'STARTING...' : e?.mode === 'sdk' ? 'IN BROWSER' : e?.mode === 'connect' ? 'REMOTE CONTROL' : '-';
    for (const [m, b] of modeBtns) {
      b.classList.toggle('is-on', sp.modePref === m);
      b.setAttribute('aria-checked', String(sp.modePref === m));
    }
    fallback.textContent = sp.sdkFallbackReason ? pixelText(`IN-BROWSER PLAYBACK UNAVAILABLE: ${sp.sdkFallbackReason}. REMOTE MODE CONTROLS THE SPOTIFY APP INSTEAD.`) : '';
    fallback.style.display = sp.sdkFallbackReason ? '' : 'none';

    // Devices (remote mode only)
    const remote = e?.mode === 'connect';
    devSection.style.display = remote ? '' : 'none';
    if (remote) {
      const devs = sp.devices;
      const key = devs.map((d) => `${d.id}${d.isActive}`).join('|');
      if (key !== devKey) {
        devKey = key;
        devList.textContent = '';
        for (const d of devs) devList.append(row(d.id, d.name, d.isActive ? 'ACTIVE' : (d.type || '').toUpperCase(), d.isRestricted));
        fitRows(devList);
      }
      devNote.style.display = devs.length ? 'none' : '';
      (devHead.lastChild as HTMLElement).textContent = devs.length ? `${devs.length}` : '';
    }

    // Playlists
    if (sp.playlists !== builtPlaylists || sp.likedTotal !== builtLiked) {
      builtPlaylists = sp.playlists;
      builtLiked = sp.likedTotal;
      const keepScroll = body.scrollTop;
      plList.textContent = '';
      plList.append(row('liked', 'LIKED SONGS', sp.likedTotal !== null ? String(sp.likedTotal) : ''));
      for (const p of sp.playlists ?? []) {
        plList.append(row(p.id, p.name, p.total !== null ? String(p.total) : '', !sp.readable(p)));
      }
      body.scrollTop = keepScroll;
      fitRows(plList);
      (plHead.lastChild as HTMLElement).textContent = sp.playlists ? String(sp.playlists.length) : 'LOADING...';
    }
    const src = e?.getSource();
    for (const r of plList.querySelectorAll<HTMLElement>('.lib-row')) r.classList.toggle('is-current', !!src && r.dataset.id === src.id);

    const ls = sp.loadStatus;
    status.textContent =
      ls.state === 'loading' ? `LOADING ${ls.loaded}${ls.total ? '/' + ls.total : ''}...`
      : ls.state === 'error' ? pixelText(ls.error ?? 'COULD NOT LOAD')
      : sp.playlists && sp.playlists.some((p) => !sp.readable(p)) ? 'DIMMED: NOT YOURS. SPOTIFY ONLY SHARES TRACKS OF PLAYLISTS YOU OWN OR COLLABORATE ON.'
      : '';
    status.style.display = status.textContent ? '' : 'none';
    if (src?.externalUrl) {
      openLink.href = src.externalUrl;
      openLink.textContent = pixelText(`OPEN "${src.name}" IN SPOTIFY`);
      linkLine.style.display = '';
    } else linkLine.style.display = 'none';
  };

  const disconnect = sheetButton('DISCONNECT', () => {
    sp.disconnect();
    ctx.message('SPOTIFY: DISCONNECTED', 1500);
  }, 'btn-disconnect');
  const diagBtn = sheetButton('DIAGNOSTICS', openDiag, 'btn-diag');
  return { actions: [diagBtn, disconnect], update };
}
