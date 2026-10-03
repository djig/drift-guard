import fs from 'node:fs';
import path from 'node:path';
import { createFileInfo, isIgnored, toPosix } from './file.js';
import { globToRegExp, loadConfig } from './config.js';
import { allRules } from './rules/index.js';
import type { DriftGuardConfig, FileInfo, Finding, ProjectContext, Report, Rule, Severity } from './types.js';
import { detectProject } from './versions.js';

export const IGNORED_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage', 'out', '.turbo', '.vercel', '.cache', '.output', 'storybook-static']);

const CHECKABLE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.css', '.scss', '.pcss']);
const CHECKABLE_NAMES = /^(package\.json|\.env(\..*)?)$/;
const MAX_FILE_BYTES = 1_500_000;

export interface RunOptions {
  cwd: string;
  /** Explicit files to check (absolute or relative to cwd). When given, only these are checked (plus project-level rules). */
  files?: string[];
  /** Override config (merged over drift-guard.config.json). */
  config?: DriftGuardConfig;
  /** Minimum severity to report. */
  minSeverity?: Severity;
  /** Rule set override (tests). */
  rules?: Rule[];
  /** Pre-computed context (tests / hooks). */
  context?: ProjectContext;
}

export function isCheckablePath(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  if (CHECKABLE_NAMES.test(base)) return true;
  const ext = path.extname(base).toLowerCase();
  if (!CHECKABLE_EXT.has(ext)) return false;
  if (/\.d\.ts$/.test(base)) return false;
  return true;
}

export function listProjectFiles(cwd: string, excludes: RegExp[] = []): string[] {
  const out: string[] = [];
  const walkDir = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = toPosix(path.relative(cwd, abs));
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        if (excludes.some((re) => re.test(rel) || re.test(rel + '/'))) continue;
        walkDir(abs, depth + 1);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (!isCheckablePath(rel)) continue;
        if (excludes.some((re) => re.test(rel))) continue;
        out.push(abs);
      }
    }
  };
  walkDir(cwd, 0);
  return out.sort();
}

function loadFile(abs: string, cwd: string): FileInfo | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return createFileInfo(abs, fs.readFileSync(abs, 'utf8'), cwd);
  } catch {
    return null;
  }
}

const SEV_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function applicableRules(ctx: ProjectContext, rules: Rule[] = allRules): Rule[] {
  return rules.filter((r) => {
    try {
      return r.appliesWhen(ctx);
    } catch {
      return false;
    }
  });
}

export function run(opts: RunOptions): Report {
  const started = Date.now();
  const cwd = path.resolve(opts.cwd);
  const ctx = opts.context ?? detectProject(cwd);
  const fileConfig = loadConfig(cwd);
  const config: DriftGuardConfig = {
    ignore: [...(fileConfig.ignore ?? []), ...(opts.config?.ignore ?? [])],
    exclude: [...(fileConfig.exclude ?? []), ...(opts.config?.exclude ?? [])],
    severity: { ...(fileConfig.severity ?? {}), ...(opts.config?.severity ?? {}) },
  };
  const excludes = (config.exclude ?? []).map(globToRegExp);
  const ignored = new Set(config.ignore ?? []);

  const rules = applicableRules(ctx, opts.rules ?? allRules).filter((r) => !ignored.has(r.id));
  const projectRules = rules.filter((r) => typeof r.checkProject === 'function');

  // Target files
  let targets: string[];
  if (opts.files && opts.files.length > 0) {
    targets = opts.files
      .map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f)))
      .filter((abs) => {
        const rel = toPosix(path.relative(cwd, abs));
        if (rel.startsWith('..')) return false;
        if (rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) return false;
        if (excludes.some((re) => re.test(rel))) return false;
        return isCheckablePath(rel);
      });
  } else {
    targets = listProjectFiles(cwd, excludes);
  }

  const targetInfos: FileInfo[] = [];
  for (const abs of targets) {
    const fi = loadFile(abs, cwd);
    if (fi) targetInfos.push(fi);
  }

  const findings: Finding[] = [];
  const push = (f: Finding, file: FileInfo | null): void => {
    if (file && isIgnored(file, f.line, f.ruleId)) return;
    const override = config.severity?.[f.ruleId];
    if (override) f.severity = override;
    if (opts.minSeverity && SEV_RANK[f.severity] > SEV_RANK[opts.minSeverity]) return;
    findings.push(f);
  };

  for (const file of targetInfos) {
    for (const rule of rules) {
      let res: Finding[] = [];
      try {
        res = rule.check(file, ctx);
      } catch (err) {
        if (process.env.DRIFT_GUARD_DEBUG) console.error(`[drift-guard] rule ${rule.id} crashed on ${file.rel}:`, err);
      }
      for (const f of res) push(f, file);
    }
  }

  if (projectRules.length > 0) {
    // Project rules need the whole file set (cheap: lazy AST, only css/config files are usually read).
    const allInfos = opts.files && opts.files.length > 0 ? listProjectFiles(cwd, excludes).map((abs) => targetInfos.find((t) => t.path === abs) ?? loadFile(abs, cwd)).filter((x): x is FileInfo => x !== null) : targetInfos;
    const byPath = new Map(allInfos.map((f) => [f.path, f]));
    for (const rule of projectRules) {
      try {
        for (const f of rule.checkProject!(allInfos, ctx)) push(f, byPath.get(path.resolve(cwd, f.file)) ?? null);
      } catch (err) {
        if (process.env.DRIFT_GUARD_DEBUG) console.error(`[drift-guard] project rule ${rule.id} crashed:`, err);
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || SEV_RANK[a.severity] - SEV_RANK[b.severity]);

  return {
    cwd,
    findings,
    filesChecked: targetInfos.length,
    rulesApplied: rules.map((r) => r.id),
    context: ctx,
    durationMs: Date.now() - started,
  };
}

export function hasErrors(report: Report): boolean {
  return report.findings.some((f) => f.severity === 'error');
}
