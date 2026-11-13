import '@fontsource/silkscreen/latin-400.css';
import '@fontsource/silkscreen/latin-700.css';
import './styles/base.css';
import './styles/windows.css';
import './styles/skins.css';
import './styles/sim.css';

import { MockEngine } from './engine/mock';
import { DEMO_SOURCE_LABEL, DEMO_START_INDEX, buildDemoPlaylist } from './engine/demoPlaylist';
import { SwitchableEngine } from './engine/switchable';
import { loadPrefs, readUrlOverrides } from './prefs';
import { takeAuthCallback } from './spotify/auth';
import { computeRedirectUri, redirectUri } from './spotify/config';
import { SpotifyService } from './spotify/service';
import { App } from './ui/app';

// The OAuth return (?code=&state= or ?error=) is taken and the URL cleaned
// before anything else reads it. The redirect URI is fixed from the location now.
redirectUri();
const authCallback = takeAuthCallback();

const prefs = loadPrefs();
const url = readUrlOverrides();

const makeDemo = () =>
  new MockEngine({
    tracks: buildDemoPlaylist(),
    startIndex: DEMO_START_INDEX,
    sourceLabel: DEMO_SOURCE_LABEL,
    volume: prefs.volume,
    balance: prefs.balance,
    shuffle: prefs.shuffle,
    repeat: prefs.repeat,
    rate: url.rate,
  });

const engine = new SwitchableEngine(makeDemo());
const spotify = new SpotifyService(engine, makeDemo, () => prefs.volume);

const app = new App(document.getElementById('app')!, engine, spotify, prefs, url);
if (url.autoplay && !spotify.signedIn) void engine.play();
void spotify.init(authCallback);

// Test hook for the Playwright scripts and manual poking: dev server, or ?test=1.
if (import.meta.env.DEV || url.test) (window as unknown as { duoamp: unknown }).duoamp = { engine, app, prefs, spotify, computeRedirectUri };
