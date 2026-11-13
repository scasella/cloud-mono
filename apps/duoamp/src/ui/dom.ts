type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  children?: Child[] | string,
  attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (typeof children === 'string') el.textContent = children;
  else if (children) for (const c of children) if (c) el.append(c);
  return el;
}

/** Length in grid units, resolved through the pane's --u custom property. */
export function u(n: number): string {
  return `calc(var(--u) * ${n})`;
}

/** Absolutely position an element on the window grid (units). */
export function place(el: HTMLElement, x: number, y: number, w?: number, hgt?: number): HTMLElement {
  const s = el.style;
  s.position = 'absolute';
  s.left = u(x);
  s.top = u(y);
  if (w !== undefined) s.width = u(w);
  if (hgt !== undefined) s.height = u(hgt);
  return el;
}

export function svg(markup: string, cls = 'icon'): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const el = t.content.firstElementChild as SVGSVGElement;
  el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
