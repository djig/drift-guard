import { describe, expect, it } from 'vitest';
import { detectProject, parseBunLock, parsePackageLock, parsePnpmLock, parseYarnLock } from '../src/versions.js';
import { parseSemver } from '../src/semver.js';
import { fixture, tempProject } from './helpers.js';

const NAMES = ['next', 'react', 'tailwindcss'];

describe('semver', () => {
  it('parses ranges loosely', () => {
    expect(parseSemver('^15.0.3')?.major).toBe(15);
    expect(parseSemver('>=14 <16')?.major).toBe(14);
    expect(parseSemver('15')?.major).toBe(15);
    expect(parseSemver('latest')).toBeNull();
    expect(parseSemver('workspace:*')).toBeNull();
  });
});

describe('lockfile parsers', () => {
  it('package-lock v3 (packages) and v1 (dependencies)', () => {
    const v3 = parsePackageLock(JSON.stringify({ packages: { 'node_modules/next': { version: '15.3.1' } } }), NAMES);
    expect(v3.get('next')?.raw).toBe('15.3.1');
    const v1 = parsePackageLock(JSON.stringify({ dependencies: { react: { version: '18.2.0' } } }), NAMES);
    expect(v1.get('react')?.major).toBe(18);
  });

  it('pnpm-lock importers + packages', () => {
    const txt = `importers:\n  .:\n    dependencies:\n      next:\n        specifier: ^15\n        version: 15.4.0(react@19.1.0)\npackages:\n  react@19.1.0:\n    resolution: {}\n  '@scope/x@1.0.0':\n    resolution: {}\n`;
    const m = parsePnpmLock(txt, NAMES);
    expect(m.get('next')?.raw).toBe('15.4.0');
    expect(m.get('react')?.raw).toBe('19.1.0');
    // old pnpm v6 style
    const old = parsePnpmLock(`packages:\n  /tailwindcss/3.3.0:\n    resolution: {}\n`, NAMES);
    expect(old.get('tailwindcss')?.major).toBe(3);
  });

  it('yarn classic and berry', () => {
    const classic = `react@^18.0.0, react@^18.2.0:\n  version "18.3.1"\n  resolved "x"\n\nreact-dom@^18.2.0:\n  version "18.3.1"\n`;
    expect(parseYarnLock(classic, NAMES).get('react')?.raw).toBe('18.3.1');
    const berry = `"next@npm:^15.0.0":\n  version: 15.2.3\n  resolution: "next@npm:15.2.3"\n`;
    expect(parseYarnLock(berry, NAMES).get('next')?.raw).toBe('15.2.3');
    // must not confuse react-dom with react
    const only = `react-dom@^18.2.0:\n  version "18.3.1"\n`;
    expect(parseYarnLock(only, NAMES).has('react')).toBe(false);
  });

  it('bun.lock (JSONC)', () => {
    const txt = `{\n  "packages": {\n    "next": ["next@16.0.1", "", {}, "sha"],\n    "react": ["react@19.2.0", "", {}, "sha"],\n  },\n}`;
    const m = parseBunLock(txt, NAMES);
    expect(m.get('next')?.raw).toBe('16.0.1');
    expect(m.get('react')?.major).toBe(19);
  });
});

describe('detectProject', () => {
  it('next16-app: npm lockfile, app dir, aliases, no compiler', () => {
    const ctx = detectProject(fixture('next16-app'));
    expect(ctx.versions.next).toEqual({ version: expect.objectContaining({ major: 16, minor: 1, patch: 2 }), source: 'lockfile' });
    expect(ctx.versions.react?.version.major).toBe(19);
    expect(ctx.versions.tailwindcss?.version.major).toBe(4);
    expect(ctx.lockfile).toBe('npm');
    expect(ctx.appDir).toBe(true);
    expect(ctx.appDirPath).toBe('app');
    expect(ctx.pathAliases).toEqual(expect.arrayContaining(['@', '~lib']));
    expect(ctx.reactCompiler).toBe(false);
    expect(ctx.hasNodeModules).toBe(true);
  });

  it('next14-pages: pnpm lockfile, pages router', () => {
    const ctx = detectProject(fixture('next14-pages'));
    expect(ctx.versions.next?.version.major).toBe(14);
    expect(ctx.versions.next?.source).toBe('lockfile');
    expect(ctx.lockfile).toBe('pnpm');
    expect(ctx.appDir).toBe(false);
    expect(ctx.pagesDir).toBe(true);
  });

  it('react18-no-compiler: bun lockfile', () => {
    const ctx = detectProject(fixture('react18-no-compiler'));
    expect(ctx.versions.react?.version.raw).toBe('18.3.1');
    expect(ctx.versions.tailwindcss?.version.major).toBe(3);
    expect(ctx.lockfile).toBe('bun');
    expect(ctx.reactCompiler).toBe(false);
  });

  it('react19-compiler: node_modules fallback with dist-tag ranges, compiler detected', () => {
    const ctx = detectProject(fixture('react19-compiler'));
    expect(ctx.versions.react).toEqual({ version: expect.objectContaining({ major: 19, minor: 1 }), source: 'node_modules' });
    expect(ctx.lockfile).toBeNull();
    expect(ctx.reactCompiler).toBe(true);
  });

  it('tailwind3 / tailwind4: yarn classic + berry', () => {
    expect(detectProject(fixture('tailwind3')).versions.tailwindcss?.version.raw).toBe('3.4.17');
    expect(detectProject(fixture('tailwind4')).versions.tailwindcss?.version.raw).toBe('4.1.11');
  });

  it('falls back to package.json range and detects reactCompiler via next.config', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ dependencies: { next: '^15.1.0', react: '~19.0.0' } }),
      'next.config.mjs': 'export default { reactCompiler: true };',
      'src/app/page.tsx': 'export default function P(){return null}',
    });
    const ctx = detectProject(dir);
    expect(ctx.versions.next).toEqual({ version: expect.objectContaining({ major: 15, minor: 1 }), source: 'package.json' });
    expect(ctx.reactCompiler).toBe(true);
    expect(ctx.appDirPath).toBe('src/app');
    expect(ctx.srcDir).toBe(true);
  });

  it('handles a directory with no package.json', () => {
    const dir = tempProject({ 'a.ts': 'export {}' });
    const ctx = detectProject(dir);
    expect(ctx.packageJson).toBeNull();
    expect(ctx.versions.next).toBeUndefined();
  });
});
