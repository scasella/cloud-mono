# DuoAmp

A retro "amp"-style music player web app for the iPhone Duo foldable, with
layouts for each fold posture (cover, book, tabletop) and two skins (light,
classic). This is the visual phase: playback runs on a silent mock engine with a
synthesised spectrum; streaming-service integration comes later behind the
`PlayerEngine` interface (`src/engine/types.ts`).

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit + vite build -> dist/
npm run preview
```

On a desktop or tablet-sized window the app renders inside a drawn device
(the simulator) with posture and skin buttons underneath. On a phone-sized
viewport it renders full-bleed.

Review tooling (uses the preinstalled Playwright; not a dependency):

```sh
node scripts/screenshots.mjs   # every posture x skin, sim + full-bleed -> screenshots/
node scripts/check.mjs         # drives the UI and asserts state changes
npm run build:font             # regenerate the DuoPixel font from fonts/duopixel-glyphs.mjs
```

## URL parameters

| Parameter | Values | Effect |
| --- | --- | --- |
| `layout` | `auto`, `cover`, `book`, `tabletop` | Override posture detection (not persisted) |
| `skin` | `light`, `classic` | Override the skin (not persisted) |
| `sim` | `1`, `0` | Force simulator on or off |
| `zoom` | e.g. `0.8` | Simulator scale |
| `autoplay` | `1` | Start playing on load |
| `rate` | e.g. `20` | Mock playback speed multiplier |
| `test` | `1` | Expose `window.duoamp` (always exposed on the dev server) |

The same posture and skin choices are in the in-app menu (top-left button) and
are saved to localStorage along with volume, EQ and other preferences.

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
- Everything else (LCD digits, icons, skins, the device frame) is drawn in code.
  No third-party skin assets are used.
