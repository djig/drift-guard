import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/engine.js';
import type { Report } from '../src/types.js';

export const FIXTURES = path.resolve(__dirname, '..', 'fixtures');
export const fixture = (name: string): string => path.join(FIXTURES, name);

/** `ruleId@line` for findings in a given file (or all). */
export function hits(report: Report, file?: string): string[] {
  return report.findings.filter((f) => !file || f.file === file).map((f) => `${f.ruleId}@${f.line}`);
}

export function ruleIds(report: Report, file?: string): string[] {
  return [...new Set(report.findings.filter((f) => !file || f.file === file).map((f) => f.ruleId))];
}

export function runFixture(name: string, files?: string[]): Report {
  return run({ cwd: fixture(name), ...(files ? { files } : {}) });
}

/** Copy a fixture into a temp dir (so tests can write to it). */
export function tempCopy(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `drift-guard-${name}-`));
  fs.cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

export function tempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guard-tmp-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
