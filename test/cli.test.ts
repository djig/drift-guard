import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixture } from './helpers.js';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

function cli(args: string[], opts: { cwd?: string; input?: string } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? ROOT, input: opts.input ?? '', encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('cli (built dist)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  });

  it('check exits 1 with errors and prints grouped text', () => {
    const r = cli(['check', '--cwd', fixture('next16-app')]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('middleware.ts');
    expect(r.out).toContain('→ fix:');
    expect(r.out).toMatch(/\d+ errors?, \d+ warnings?/);
  });

  it('check exits 0 on a clean fixture', () => {
    const r = cli(['check', '--cwd', fixture('next14-pages')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no version drift found');
  });

  it('--json has detected versions and findings', () => {
    const r = cli(['check', '--json', '--cwd', fixture('next16-app'), 'app/page.tsx']);
    const json = JSON.parse(r.out);
    expect(json.detected.next).toEqual({ version: '16.1.2', source: 'lockfile' });
    expect(json.findings.every((f: { file: string }) => f.file === 'app/page.tsx' || f.file === 'tailwind.config.js')).toBe(true);
    expect(json.summary.error).toBeGreaterThan(0);
  });

  it('--sarif is valid SARIF 2.1.0', () => {
    const r = cli(['check', '--sarif', '--cwd', fixture('next16-app'), 'middleware.ts']);
    const sarif = JSON.parse(r.out);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('drift-guard');
    const res = sarif.runs[0].results.find((x: { ruleId: string }) => x.ruleId === 'next/middleware-file');
    expect(res.level).toBe('error');
    expect(res.locations[0].physicalLocation.artifactLocation.uri).toBe('middleware.ts');
    expect(sarif.runs[0].tool.driver.rules.map((x: { id: string }) => x.id)).toContain('next/middleware-file');
  });

  it('--severity error drops warnings', () => {
    const r = cli(['check', '--json', '--severity', 'error', '--cwd', fixture('next16-app')]);
    const json = JSON.parse(r.out);
    expect(json.summary.warn).toBe(0);
    expect(json.summary.info).toBe(0);
  });

  it('hook reads stdin, exits 0, prints block JSON', () => {
    const cwd = fixture('next16-app');
    const r = cli(['hook', '--agent', 'claude'], { input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'middleware.ts') }, cwd }) });
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.decision).toBe('block');
  });

  it('hook never crashes on bad input', () => {
    const r = cli(['hook', '--agent', 'claude'], { input: '{{{' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    const r2 = cli(['hook', '--agent', 'nope'], { input: '{}' });
    expect(r2.code).toBe(0);
    expect(r2.out).toBe('');
  });

  it('rules --json marks applicability', () => {
    const r = cli(['rules', '--json', '--cwd', fixture('react19-compiler')]);
    const json = JSON.parse(r.out);
    expect(json.detected.reactCompiler).toBe(true);
    const byId = Object.fromEntries(json.rules.map((x: { id: string; applies: boolean }) => [x.id, x.applies]));
    expect(byId['react/manual-memo-with-compiler']).toBe(true);
    expect(byId['next/sync-params']).toBe(false);
    expect(json.rules).toHaveLength(23);
  });

  it('agents-md --print prints a managed block', () => {
    const r = cli(['agents-md', '--print', '--cwd', fixture('tailwind4')]);
    expect(r.out).toContain('<!-- BEGIN:drift-guard -->');
    expect(r.out).toContain('Tailwind 4.1 is installed');
    expect(r.out).not.toContain('Next ');
  });

  it('no command prints help and exits 1', () => {
    const r = cli([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Usage:');
  });
});
