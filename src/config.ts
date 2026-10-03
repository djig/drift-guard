import fs from 'node:fs';
import path from 'node:path';
import type { DriftGuardConfig, Severity } from './types.js';
import { stripJsonComments } from './versions.js';

const SEVERITIES: Severity[] = ['error', 'warn', 'info'];

export function loadConfig(cwd: string): DriftGuardConfig {
  const file = path.join(cwd, 'drift-guard.config.json');
  try {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8'))) as Record<string, unknown>;
    const cfg: DriftGuardConfig = {};
    if (Array.isArray(raw.ignore)) cfg.ignore = raw.ignore.filter((x): x is string => typeof x === 'string');
    if (Array.isArray(raw.exclude)) cfg.exclude = raw.exclude.filter((x): x is string => typeof x === 'string');
    if (raw.severity && typeof raw.severity === 'object') {
      cfg.severity = {};
      for (const [k, v] of Object.entries(raw.severity as Record<string, unknown>)) {
        if (typeof v === 'string' && (SEVERITIES as string[]).includes(v)) cfg.severity[k] = v as Severity;
      }
    }
    return cfg;
  } catch {
    return {};
  }
}

/** Minimal glob → RegExp: supports `**`, `*`, `?`, `{a,b}`. Matches against posix-relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, '');
  // a bare directory name like "legacy" or "legacy/" matches everything under it
  if (!/[*?{]/.test(g)) g = g.replace(/\/$/, '') + '/**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += '(?:' + g.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      }
    } else if (/[.+^$()|[\]\\]/.test(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
