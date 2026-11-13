import '@fontsource/silkscreen/latin-400.css';
import '@fontsource/silkscreen/latin-700.css';
import '@fontsource/vt323/latin-400.css';
import './styles/base.css';
import './styles/windows.css';
import './styles/skins.css';
import './styles/sim.css';

import { MockEngine } from './engine/mock';
import { DEMO_SOURCE_LABEL, DEMO_START_INDEX, buildDemoPlaylist } from './engine/demoPlaylist';
import type { PlayerEngine } from './engine/types';
import { loadPrefs, readUrlOverrides } from './prefs';
import { App } from './ui/app';

const prefs = loadPrefs();
const url = readUrlOverrides();

const engine: PlayerEngine = new MockEngine({
  tracks: buildDemoPlaylist(),
  startIndex: DEMO_START_INDEX,
  sourceLabel: DEMO_SOURCE_LABEL,
  volume: prefs.volume,
  balance: prefs.balance,
  shuffle: prefs.shuffle,
  repeat: prefs.repeat,
  rate: url.rate,
});

const app = new App(document.getElementById('app')!, engine, prefs, url);
if (url.autoplay) engine.play();

// Handy for manual poking and for the Playwright checks.
(window as unknown as { duoamp: unknown }).duoamp = { engine, app, prefs };
