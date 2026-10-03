import fs from 'node:fs';
import path from 'node:path';
import { parseSemver } from './semver.js';
import type { DetectedVersion, ProjectContext, SemVer } from './types.js';

const TRACKED = ['next', 'react', 'react-dom', 'tailwindcss', 'typescript'] as const;
type Tracked = (typeof TRACKED)[number];

function readJson(file: string): Record<string, unknown> | null {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return JSON.parse(stripJsonComments(txt)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Strip line and block comments and trailing commas (tsconfig / bun.lock are JSONC). */
export function stripJsonComments(txt: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < txt.length) {
    const c = txt[i]!;
    const n = txt[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < txt.length && txt[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < txt.length && !(txt[i] === '*' && txt[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // trailing commas
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------- lockfile parsers (best effort) ----------

export function parsePackageLock(txt: string, names: readonly string[]): Map<string, SemVer> {
  const out = new Map<string, SemVer>();
  try {
    const json = JSON.parse(txt) as {
      packages?: Record<string, { version?: string }>;
      dependencies?: Record<string, { version?: string }>;
    };
    for (const name of names) {
      const v2 = json.packages?.[`node_modules/${name}`]?.version;
      const v1 = json.dependencies?.[name]?.version;
      const sv = parseSemver(v2 ?? v1);
      if (sv) out.set(name, sv);
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function parsePnpmLock(txt: string, names: readonly string[]): Map<string, SemVer> {
  const out = new Map<string, SemVer>();
  // Prefer importers section (root importer '.') which has `version: 15.0.0(...)`.
  // Fallback: packages keys like `/next@15.0.0:` or `next@15.0.0:` or `/next/15.0.0:`.
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const importerRe = new RegExp(`^\\s{2,}${esc}:\\s*\\n(?:\\s+specifier:.*\\n)?\\s+version:\\s*['"]?(\\d+\\.\\d+\\.\\d+)`, 'm');
    const m1 = importerRe.exec(txt);
    if (m1) {
      const sv = parseSemver(m1[1]);
      if (sv) {
        out.set(name, sv);
        continue;
      }
    }
    const pkgRe = new RegExp(`^\\s*['"]?/?${esc}[@/](\\d+\\.\\d+\\.\\d+)[^:\\n]*['"]?:`, 'm');
    const m2 = pkgRe.exec(txt);
    if (m2) {
      const sv = parseSemver(m2[1]);
      if (sv) out.set(name, sv);
    }
  }
  return out;
}

export function parseYarnLock(txt: string, names: readonly string[]): Map<string, SemVer> {
  const out = new Map<string, SemVer>();
  // Classic:  next@^15.0.0, next@latest:\n  version "15.0.0"
  // Berry:    "next@npm:^15.0.0":\n  version: 15.0.0
  const blocks = txt.split(/\n(?=\S)/);
  for (const block of blocks) {
    const header = block.split('\n')[0] ?? '';
    const versionMatch = /^\s+version:?\s*"?(\d+\.\d+\.\d+[^"\s]*)"?/m.exec(block);
    if (!versionMatch) continue;
    for (const name of names) {
      if (out.has(name)) continue;
      const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const headerRe = new RegExp(`(^|[\\s,"])${esc}@`);
      if (headerRe.test(header)) {
        const sv = parseSemver(versionMatch[1]);
        if (sv) out.set(name, sv);
      }
    }
  }
  return out;
}

export function parseBunLock(txt: string, names: readonly string[]): Map<string, SemVer> {
  const out = new Map<string, SemVer>();
  try {
    const json = JSON.parse(stripJsonComments(txt)) as { packages?: Record<string, unknown[]> };
    for (const name of names) {
      const entry = json.packages?.[name];
      const first = Array.isArray(entry) ? entry[0] : undefined;
      if (typeof first === 'string') {
        const at = first.lastIndexOf('@');
        const sv = parseSemver(at > 0 ? first.slice(at + 1) : first);
        if (sv) out.set(name, sv);
      }
    }
  } catch {
    // regex fallback
    for (const name of names) {
      const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const m = new RegExp(`"${esc}":\\s*\\[\\s*"${esc}@(\\d+\\.\\d+\\.\\d+)`).exec(txt);
      const sv = parseSemver(m?.[1]);
      if (sv) out.set(name, sv);
    }
  }
  return out;
}

function readLockfile(cwd: string, names: readonly string[]): { kind: ProjectContext['lockfile']; versions: Map<string, SemVer> } {
  const candidates: Array<[string, ProjectContext['lockfile'], (t: string, n: readonly string[]) => Map<string, SemVer>]> = [
    ['package-lock.json', 'npm', parsePackageLock],
    ['npm-shrinkwrap.json', 'npm', parsePackageLock],
    ['pnpm-lock.yaml', 'pnpm', parsePnpmLock],
    ['yarn.lock', 'yarn', parseYarnLock],
    ['bun.lock', 'bun', parseBunLock],
  ];
  for (const [file, kind, parser] of candidates) {
    const p = path.join(cwd, file);
    if (!exists(p)) continue;
    try {
      return { kind, versions: parser(fs.readFileSync(p, 'utf8'), names) };
    } catch {
      return { kind, versions: new Map() };
    }
  }
  if (exists(path.join(cwd, 'bun.lockb'))) return { kind: 'bun', versions: new Map() };
  return { kind: null, versions: new Map() };
}

function nodeModulesVersion(cwd: string, name: string): SemVer | null {
  const pj = readJson(path.join(cwd, 'node_modules', name, 'package.json'));
  return parseSemver(typeof pj?.version === 'string' ? pj.version : undefined);
}

// ---------- next.config detection ----------

export function readNextConfigSource(cwd: string): { file: string; source: string } | null {
  for (const f of ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs', 'next.config.mts']) {
    const p = path.join(cwd, f);
    if (exists(p)) {
      try {
        return { file: p, source: fs.readFileSync(p, 'utf8') };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function detectReactCompiler(cwd: string, declared: Set<string>): boolean {
  if (declared.has('babel-plugin-react-compiler')) return true;
  const cfg = readNextConfigSource(cwd);
  if (cfg && /reactCompiler\s*:\s*(true|\{)/.test(cfg.source)) return true;
  // babel config
  for (const f of ['babel.config.js', 'babel.config.cjs', 'babel.config.mjs', '.babelrc', '.babelrc.json', 'vite.config.ts', 'vite.config.js']) {
    const p = path.join(cwd, f);
    if (exists(p)) {
      try {
        if (fs.readFileSync(p, 'utf8').includes('babel-plugin-react-compiler')) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

function readTsconfigPaths(cwd: string): string[] {
  const out = new Set<string>();
  for (const f of ['tsconfig.json', 'jsconfig.json']) {
    const json = readJson(path.join(cwd, f));
    const co = json?.compilerOptions as { paths?: Record<string, unknown>; baseUrl?: string } | undefined;
    if (co?.paths) {
      for (const key of Object.keys(co.paths)) {
        out.add(key.replace(/\/?\*$/, ''));
      }
    }
  }
  return [...out];
}

// ---------- public API ----------

export function detectProject(cwd: string): ProjectContext {
  cwd = path.resolve(cwd);
  const packageJson = readJson(path.join(cwd, 'package.json'));
  const declaredDeps = new Set<string>();
  const ranges = new Map<string, string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = packageJson?.[field];
    if (deps && typeof deps === 'object') {
      for (const [k, v] of Object.entries(deps as Record<string, unknown>)) {
        declaredDeps.add(k);
        if (typeof v === 'string' && !ranges.has(k)) ranges.set(k, v);
      }
    }
  }

  const lock = readLockfile(cwd, TRACKED);
  const hasNodeModules = isDir(path.join(cwd, 'node_modules'));

  const versions: ProjectContext['versions'] = {};
  for (const name of TRACKED) {
    let det: DetectedVersion | undefined;
    const fromLock = lock.versions.get(name);
    if (fromLock) det = { version: fromLock, source: 'lockfile' };
    if (!det && hasNodeModules) {
      const nm = nodeModulesVersion(cwd, name);
      if (nm) det = { version: nm, source: 'node_modules' };
    }
    if (!det) {
      const range = ranges.get(name);
      const sv = parseSemver(range);
      if (sv) det = { version: sv, source: 'package.json' };
      else if (range && /^(latest|canary|next|rc|beta)$/.test(range.trim())) {
        // dist-tags: can't know; try node_modules already failed. leave undefined.
      }
    }
    if (det) (versions as Record<Tracked, DetectedVersion>)[name] = det;
  }

  const srcDir = isDir(path.join(cwd, 'src'));
  let appDirPath: string | null = null;
  if (isDir(path.join(cwd, 'app'))) appDirPath = 'app';
  else if (isDir(path.join(cwd, 'src', 'app'))) appDirPath = 'src/app';
  const pagesDir = isDir(path.join(cwd, 'pages')) || isDir(path.join(cwd, 'src', 'pages'));

  return {
    cwd,
    packageJson,
    declaredDeps,
    versions,
    reactCompiler: detectReactCompiler(cwd, declaredDeps),
    appDir: appDirPath !== null,
    appDirPath,
    pagesDir,
    srcDir,
    pathAliases: readTsconfigPaths(cwd),
    hasNodeModules,
    lockfile: lock.kind,
  };
}
