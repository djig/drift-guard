import type { SemVer } from './types.js';

const RE = /(\d+)\.(\d+)\.(\d+)/;

/** Parse the first `x.y.z` in a string (tolerates ranges like `^15.0.0`, `>=14 <16`). */
export function parseSemver(input: string | undefined | null): SemVer | null {
  if (!input) return null;
  const s = input.trim();
  const m = RE.exec(s);
  if (m) {
    return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, raw: s };
  }
  // tolerate "15" or "15.1" or "^15"
  const loose = /(\d+)(?:\.(\d+))?/.exec(s.replace(/^[\^~>=<\s]+/, ''));
  if (loose && /^[\^~>=<\s]*\d/.test(s)) {
    return { major: +loose[1]!, minor: loose[2] ? +loose[2] : 0, patch: 0, raw: s };
  }
  return null;
}

export function gte(v: SemVer | undefined, major: number, minor = 0): boolean {
  if (!v) return false;
  return v.major > major || (v.major === major && v.minor >= minor);
}

export function lt(v: SemVer | undefined, major: number, minor = 0): boolean {
  if (!v) return false;
  return !gte(v, major, minor);
}

export function fmt(v: SemVer | undefined): string {
  if (!v) return 'not installed';
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Short "16.3" style version for prose. */
export function short(v: SemVer | undefined): string {
  if (!v) return '?';
  return `${v.major}.${v.minor}`;
}
