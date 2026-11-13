import type { SkinId } from './prefs';

/**
 * Skins are data: one flat token map per skin, written to CSS custom
 * properties on <html>, plus `data-skin` for the shape differences (radii,
 * round vs square buttons, bevels), which live in styles/skins.css.
 * Canvas painters read the same tokens from here.
 */
export interface SkinTokens {
  /** Page/body colour; Safari paints the system strip with it, so keep it dark. */
  desk: string;
  chassisHi: string;
  chassisLo: string;
  chassisEdge: string;
  chassisLight: string;
  chassisShade: string;
  titleText: string;
  titleTextInactive: string;
  railHi: string;
  railLo: string;
  railInactiveHi: string;
  railInactiveLo: string;
  lcdBg: string;
  lcdEdge: string;
  lcdText: string;
  lcdTextDim: string;
  lcdGlow: string;
  label: string;
  labelLit: string;
  labelDim: string;
  btnHi: string;
  btnLo: string;
  btnEdge: string;
  btnIcon: string;
  btnPressedHi: string;
  btnPressedLo: string;
  bevelLight: string;
  bevelDark: string;
  ledOff: string;
  ledOn: string;
  ledGlow: string;
  trackBg: string;
  trackEdge: string;
  fillA: string;
  fillB: string;
  knobHi: string;
  knobLo: string;
  knobEdge: string;
  knobGrip: string;
  plBg: string;
  plText: string;
  plDur: string;
  plCurrentBg: string;
  plCurrentText: string;
  plSelectBg: string;
  plScrollTrack: string;
  plScrollThumb: string;
  visBg: string;
  visLo: string;
  visMid: string;
  visHi: string;
  visPeak: string;
  visGrid: string;
  graphLine: string;
  graphLine2: string;
  graphZero: string;
  scrim: string;
}

export const SKINS: Record<SkinId, SkinTokens> = {
  light: {
    desk: '#07070c',
    chassisHi: '#f3f1fc',
    chassisLo: '#d2cee9',
    chassisEdge: '#8d89ae',
    chassisLight: '#ffffff',
    chassisShade: '#b4b0d0',
    titleText: '#5d5a78',
    titleTextInactive: '#9592ad',
    railHi: '#fdfcff',
    railLo: '#a29ebf',
    railInactiveHi: '#f6f5fc',
    railInactiveLo: '#c3bfd8',
    lcdBg: '#11188e',
    lcdEdge: '#6f6b9b',
    lcdText: '#eef0ff',
    lcdTextDim: '#2c37a8',
    lcdGlow: 'rgba(170,185,255,0.55)',
    label: '#6e6b8c',
    labelLit: '#2b3192',
    labelDim: '#bdb9d6',
    btnHi: '#fdfcff',
    btnLo: '#d6d2ec',
    btnEdge: '#7c789f',
    btnIcon: '#25234a',
    btnPressedHi: '#c4bfe0',
    btnPressedLo: '#e6e3f5',
    bevelLight: '#ffffff',
    bevelDark: '#9f9bbd',
    ledOff: '#9b97b7',
    ledOn: '#3657ff',
    ledGlow: 'rgba(80,110,255,0.7)',
    trackBg: '#2f2d46',
    trackEdge: '#8783a8',
    fillA: '#b9c3ff',
    fillB: '#7186f5',
    knobHi: '#ffffff',
    knobLo: '#cdc9e4',
    knobEdge: '#6f6b95',
    knobGrip: '#8e8aad',
    plBg: '#121a98',
    plText: '#e8eaff',
    plDur: '#e8eaff',
    plCurrentBg: '#3c5cf2',
    plCurrentText: '#ffffff',
    plSelectBg: '#26309f',
    plScrollTrack: '#0b1070',
    plScrollThumb: '#cfcbe8',
    visBg: '#11188e',
    visLo: '#2a3cd6',
    visMid: '#4d63f0',
    visHi: '#9aa8ff',
    visPeak: '#e8ebff',
    visGrid: '#0d137a',
    graphLine: '#a9b6ff',
    graphLine2: '#6f82f7',
    graphZero: '#2a35a6',
    scrim: 'rgba(10,8,30,0.45)',
  },
  classic: {
    desk: '#08080d',
    chassisHi: '#46466c',
    chassisLo: '#33335a',
    chassisEdge: '#15152a',
    chassisLight: '#6c6c96',
    chassisShade: '#222240',
    titleText: '#e9e9f6',
    titleTextInactive: '#9c9cb8',
    railHi: '#f0aa3c',
    railLo: '#5e3608',
    railInactiveHi: '#8f855c',
    railInactiveLo: '#3a3624',
    lcdBg: '#000000',
    lcdEdge: '#1a1a2e',
    lcdText: '#2cee2c',
    lcdTextDim: '#0b360b',
    lcdGlow: 'rgba(40,240,40,0.25)',
    label: '#c3c3dc',
    labelLit: '#3cf03c',
    labelDim: '#2c3a34',
    btnHi: '#e4e4ee',
    btnLo: '#c2c2d2',
    btnEdge: '#121222',
    btnIcon: '#1e1e2c',
    btnPressedHi: '#a8a8bc',
    btnPressedLo: '#c8c8d6',
    bevelLight: '#ffffff',
    bevelDark: '#6c6c86',
    ledOff: '#4a4a62',
    ledOn: '#3cff3c',
    ledGlow: 'rgba(60,255,60,0.6)',
    trackBg: '#191930',
    trackEdge: '#0c0c1a',
    fillA: '#e6e33c',
    fillB: '#b9d72c',
    knobHi: '#e8e8f0',
    knobLo: '#b8b8ca',
    knobEdge: '#14142a',
    knobGrip: '#6a6a84',
    plBg: '#000000',
    plText: '#22e422',
    plDur: '#1fc81f',
    plCurrentBg: '#1426d8',
    plCurrentText: '#ffffff',
    plSelectBg: '#1a2550',
    plScrollTrack: '#121226',
    plScrollThumb: '#bcbcd0',
    visBg: '#000000',
    visLo: '#18a418',
    visMid: '#5cd42a',
    visHi: '#dfe03a',
    visPeak: '#d4d4e2',
    visGrid: '#0a140a',
    graphLine: '#30f030',
    graphLine2: '#e6c22c',
    graphZero: '#1c3a1c',
    scrim: 'rgba(0,0,0,0.5)',
  },
};

function kebab(s: string) {
  return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

export function applySkin(id: SkinId, root: HTMLElement = document.documentElement) {
  const t = SKINS[id];
  for (const [k, v] of Object.entries(t)) root.style.setProperty(`--${kebab(k)}`, v);
  root.dataset.skin = id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.desk);
}
