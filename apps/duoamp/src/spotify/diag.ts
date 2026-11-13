/**
 * Ring buffer of recent engine / API / auth events for the diagnostics view.
 * Only messages built by this app go in here, and everything passes through
 * redact() on the way in and again when a report is produced: tokens, the
 * PKCE verifier and the auth code must never appear in a report or the console.
 */

export type DiagKind = 'auth' | 'api' | 'sdk' | 'engine' | 'app';
export interface DiagEvent {
  t: number;
  kind: DiagKind;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const MAX = 60;
const secrets = new Set<string>();

/** Register a secret value so it is scrubbed wherever it might appear. */
export function registerSecret(v: string | null | undefined) {
  if (v && v.length >= 8) secrets.add(v);
}

export function redact(s: string): string {
  let out = s;
  for (const v of secrets) if (out.includes(v)) out = out.split(v).join('[redacted]');
  return out
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:access_token|refresh_token|code_verifier|code|token)["']?\s*[=:]\s*["']?)[^\s&"',}]+/gi, '$1[redacted]')
    // Long opaque strings (tokens are ~200 chars, verifiers 64+).
    .replace(/[A-Za-z0-9_\-.~]{48,}/g, '[redacted]');
}

class DiagLog {
  private events: DiagEvent[] = [];
  private listeners = new Set<() => void>();

  add(kind: DiagKind, level: DiagEvent['level'], msg: string) {
    const e = { t: Date.now(), kind, level, msg: redact(msg) };
    this.events.push(e);
    if (this.events.length > MAX) this.events.shift();
    if (level !== 'info') console.warn(`[duoamp ${kind}] ${e.msg}`);
    for (const l of this.listeners) l();
  }
  info(kind: DiagKind, msg: string) {
    this.add(kind, 'info', msg);
  }
  warn(kind: DiagKind, msg: string) {
    this.add(kind, 'warn', msg);
  }
  error(kind: DiagKind, msg: string) {
    this.add(kind, 'error', msg);
  }
  list(filter?: (e: DiagEvent) => boolean): DiagEvent[] {
    return filter ? this.events.filter(filter) : this.events.slice();
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  clear() {
    this.events = [];
  }
}

export const diag = new DiagLog();

export function fmtClock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
