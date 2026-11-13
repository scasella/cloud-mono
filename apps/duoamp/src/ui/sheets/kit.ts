import { TOUCH } from '../../config';
import { h } from '../dom';
import { pressable } from '../controls';
import { DUOPIXEL_ADVANCE, DUOPIXEL_PX_PER_EM } from '../../fonts/duopixel-charset';
import { pixelText } from '../pixelText';

/** What a sheet builder returns to the overlay host. */
export interface SheetSpec {
  title: string;
  wide?: boolean;
  actions: HTMLElement[];
  dispose?: () => void;
}

export type SheetBuilder = (body: HTMLElement, close: () => void) => SheetSpec;

/** A skinned push button for use inside sheets (same artwork as the deck's toggles). */
export function sheetButton(label: string, onPress: () => void, extra = ''): HTMLButtonElement {
  const b = h('button', `btn btn-toggle sheet-btn ${extra}`.trim(), [h('span', 'btn-label', label)], { type: 'button' });
  pressable(b, onPress);
  return b;
}

/**
 * Tap handling for rows inside a touch-scrolled list: a press that moves more
 * than the tap slop is a scroll, not a tap.
 */
export function onRowTap(list: HTMLElement, rowSel: string, fn: (row: HTMLElement) => void) {
  let down: { x: number; y: number; row: HTMLElement } | null = null;
  list.addEventListener('pointerdown', (e) => {
    const row = (e.target as HTMLElement).closest(rowSel) as HTMLElement | null;
    down = row ? { x: e.clientX, y: e.clientY, row } : null;
    row?.classList.add('is-pressed');
  });
  const clear = () => {
    down?.row.classList.remove('is-pressed');
    down = null;
  };
  list.addEventListener('pointermove', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > TOUCH.tapSlopPx) clear();
  });
  list.addEventListener('pointercancel', clear);
  list.addEventListener('pointerup', (e) => {
    if (!down) return;
    const row = (e.target as HTMLElement).closest(rowSel);
    const hit = row === down.row ? down.row : null;
    clear();
    if (hit) fn(hit);
  });
  list.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest(rowSel) as HTMLElement | null;
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      fn(row);
    }
  });
}

/** Copy to the clipboard; falls back to a hidden textarea where the async API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Truncate with ".." to what fits in `el` (DuoPixel is monospaced). Full text goes in the title attribute. */
export function fitText(el: HTMLElement, text: string) {
  const full = pixelText(text);
  el.title = text;
  const cs = getComputedStyle(el);
  const fs = parseFloat(cs.fontSize) || 12;
  const ls = parseFloat(cs.letterSpacing) || 0;
  const w = el.getBoundingClientRect().width;
  if (w <= 0) {
    el.textContent = full;
    return;
  }
  const chars = Math.max(4, Math.floor((w + ls) / ((fs * DUOPIXEL_ADVANCE) / DUOPIXEL_PX_PER_EM + ls)));
  el.textContent = full.length <= chars ? full : full.slice(0, chars - 2) + '..';
}

export function para(text: string, cls = ''): HTMLElement {
  return h('p', cls, pixelText(text));
}
