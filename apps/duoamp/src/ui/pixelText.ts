import { DUOPIXEL_CHARSET } from '../fonts/duopixel-charset';

const SUPPORTED = new Set(Array.from(DUOPIXEL_CHARSET));
const cache = new Map<string, string>();

/**
 * Map arbitrary text onto what DuoPixel can draw: the font itself folds
 * lowercase and accented Latin onto capitals; anything else (CJK, emoji,
 * symbols) becomes '?', as on the classic decks.
 */
export function pixelText(s: string): string {
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  let out = '';
  for (const ch of s) {
    if (SUPPORTED.has(ch)) {
      out += ch;
      continue;
    }
    if (ch === '…') {
      out += '...';
      continue;
    }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += base && Array.from(base).every((c) => SUPPORTED.has(c)) ? base : '?';
  }
  if (cache.size > 2000) cache.clear();
  cache.set(s, out);
  return out;
}
