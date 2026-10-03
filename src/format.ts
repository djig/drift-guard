import { rulesById } from './rules/index.js';
import { fmt } from './semver.js';
import type { Finding, Report, Severity } from './types.js';

export interface TextOptions {
  color?: boolean;
  /** Print version summary header. */
  header?: boolean;
}

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  green: '\x1b[32m',
  underline: '\x1b[4m',
};

function paint(on: boolean, color: keyof typeof COLORS, s: string): string {
  return on ? `${COLORS[color]}${s}${COLORS.reset}` : s;
}

const SEV_COLOR: Record<Severity, keyof typeof COLORS> = { error: 'red', warn: 'yellow', info: 'blue' };

export function versionSummary(report: Report): string {
  const v = report.context.versions;
  const parts: string[] = [];
  if (v.next) parts.push(`next ${fmt(v.next.version)}`);
  if (v.react) parts.push(`react ${fmt(v.react.version)}`);
  if (v.tailwindcss) parts.push(`tailwind ${fmt(v.tailwindcss.version)}`);
  if (report.context.reactCompiler) parts.push('react-compiler');
  if (report.context.appDir) parts.push('app-router');
  return parts.length ? parts.join(' · ') : 'no next/react/tailwind detected';
}

export function formatText(report: Report, opts: TextOptions = {}): string {
  const c = opts.color ?? false;
  const lines: string[] = [];
  if (opts.header !== false) {
    lines.push(paint(c, 'dim', `drift-guard · ${versionSummary(report)} · ${report.rulesApplied.length} rules · ${report.filesChecked} files`));
  }
  if (report.findings.length === 0) {
    lines.push(paint(c, 'green', '✓ no version drift found'));
    return lines.join('\n');
  }
  const byFile = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }
  for (const [file, fs] of byFile) {
    lines.push('');
    lines.push(paint(c, 'underline', file));
    for (const f of fs) {
      const loc = paint(c, 'dim', `${f.line}:${f.col}`.padEnd(8));
      const sev = paint(c, SEV_COLOR[f.severity], f.severity.padEnd(5));
      lines.push(`  ${loc} ${sev} ${f.message} ${paint(c, 'dim', f.ruleId)}`);
      lines.push(`           ${paint(c, 'dim', '→ fix:')} ${f.fix}`);
    }
  }
  const counts = countBySeverity(report.findings);
  lines.push('');
  lines.push(
    [
      counts.error ? paint(c, 'red', `${counts.error} error${counts.error === 1 ? '' : 's'}`) : null,
      counts.warn ? paint(c, 'yellow', `${counts.warn} warning${counts.warn === 1 ? '' : 's'}`) : null,
      counts.info ? paint(c, 'blue', `${counts.info} info`) : null,
    ]
      .filter(Boolean)
      .join(', '),
  );
  return lines.join('\n');
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

export function formatJson(report: Report): string {
  const v = report.context.versions;
  return JSON.stringify(
    {
      version: 1,
      cwd: report.cwd,
      detected: {
        next: v.next ? { version: fmt(v.next.version), source: v.next.source } : null,
        react: v.react ? { version: fmt(v.react.version), source: v.react.source } : null,
        tailwindcss: v.tailwindcss ? { version: fmt(v.tailwindcss.version), source: v.tailwindcss.source } : null,
        typescript: v.typescript ? { version: fmt(v.typescript.version), source: v.typescript.source } : null,
        reactCompiler: report.context.reactCompiler,
        appDir: report.context.appDir,
        lockfile: report.context.lockfile,
      },
      rulesApplied: report.rulesApplied,
      filesChecked: report.filesChecked,
      summary: countBySeverity(report.findings),
      findings: report.findings,
    },
    null,
    2,
  );
}

const SARIF_LEVEL: Record<Severity, string> = { error: 'error', warn: 'warning', info: 'note' };

export function formatSarif(report: Report, toolVersion = '0.1.0'): string {
  const ruleIds = [...new Set(report.findings.map((f) => f.ruleId))];
  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'drift-guard',
            version: toolVersion,
            informationUri: 'https://github.com/djig/drift-guard',
            rules: ruleIds.map((id) => {
              const r = rulesById.get(id);
              return {
                id,
                name: id.replace(/[^a-zA-Z0-9]+/g, '_'),
                shortDescription: { text: r?.title ?? id },
                helpUri: r?.docs ?? 'https://github.com/djig/drift-guard',
                defaultConfiguration: { level: SARIF_LEVEL[r?.severity ?? 'warn'] },
              };
            }),
          },
        },
        results: report.findings.map((f) => ({
          ruleId: f.ruleId,
          ruleIndex: ruleIds.indexOf(f.ruleId),
          level: SARIF_LEVEL[f.severity],
          message: { text: `${f.message} Fix: ${f.fix}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' },
                region: { startLine: f.line, startColumn: f.col },
              },
            },
          ],
          properties: { confidence: f.confidence },
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

/** Compact one-line-per-finding list used in hook messages. */
export function formatForAgent(findings: Finding[], max = 6): string {
  const shown = findings.slice(0, max).map((f) => `${f.file}:${f.line} [${f.severity}] ${f.message} Fix: ${f.fix} (${f.ruleId})`);
  if (findings.length > max) shown.push(`…and ${findings.length - max} more. Run \`npx @djig/drift-guard check\` for the full list.`);
  return shown.join('\n');
}
