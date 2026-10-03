#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { agentsMdBlock, init, runHook, type Agent, type InitAgent } from './agents.js';
import { applicableRules, hasErrors, run } from './engine.js';
import { formatJson, formatSarif, formatText } from './format.js';
import { allRules } from './rules/index.js';
import { fmt } from './semver.js';
import type { Severity } from './types.js';
import { detectProject } from './versions.js';

const VERSION = readOwnVersion();

function readOwnVersion(): string {
  try {
    const pj = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pj.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let cmd = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k!] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-') && /^(agent|severity|cwd|format)$/.test(k!)) flags[k!] = argv[++i]!;
      else flags[k!] = true;
    } else if (a === '-y') flags.yes = true;
    else if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else if (!cmd) cmd = a;
    else positional.push(a);
  }
  return { cmd, positional, flags };
}

const HELP = `drift-guard ${VERSION} — version-aware gate for training-data drift in React / Next.js / Tailwind code

Usage:
  drift-guard check [files...] [--json|--sarif] [--severity error|warn|info] [--cwd <dir>]
  drift-guard hook --agent claude|codex|cursor        (reads hook JSON on stdin)
  drift-guard init [--agent claude|codex|cursor|copilot|all] [--yes] [--skill]
  drift-guard agents-md --print
  drift-guard rules [--json]

Exit codes: check → 1 when any error-severity finding exists; hook → always 0.
Env: DRIFT_GUARD_DEBUG=1 logs internal errors to stderr.`;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 5000).unref();
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { cmd, positional, flags } = parseArgs(argv);
  const cwd = path.resolve(typeof flags.cwd === 'string' ? flags.cwd : process.cwd());

  if (flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (flags.help || !cmd) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }

  switch (cmd) {
    case 'check': {
      const minSeverity = typeof flags.severity === 'string' ? (flags.severity as Severity) : undefined;
      const report = run({ cwd, ...(positional.length ? { files: positional } : {}), ...(minSeverity ? { minSeverity } : {}) });
      if (flags.json) console.log(formatJson(report));
      else if (flags.sarif) console.log(formatSarif(report, VERSION));
      else console.log(formatText(report, { color: !!process.stdout.isTTY && !process.env.NO_COLOR }));
      return hasErrors(report) ? 1 : 0;
    }
    case 'hook': {
      try {
        const agent = (typeof flags.agent === 'string' ? flags.agent : 'claude') as Agent;
        if (!/^(claude|codex|cursor)$/.test(agent)) throw new Error(`unknown agent ${agent}`);
        const input = await readStdin();
        const res = runHook(input, agent, cwd);
        if (res.output) console.log(JSON.stringify(res.output));
      } catch (err) {
        if (process.env.DRIFT_GUARD_DEBUG) console.error('[drift-guard] hook error:', err);
      }
      return 0;
    }
    case 'init': {
      const agent = (typeof flags.agent === 'string' ? flags.agent : 'all') as InitAgent;
      if (!/^(claude|codex|cursor|copilot|all)$/.test(agent)) {
        console.error(`unknown agent "${agent}"`);
        return 1;
      }
      const res = init({ cwd, agent, yes: !!flags.yes, skill: !!flags.skill });
      for (const f of res.written) console.log(`  created  ${f}`);
      for (const f of res.merged) console.log(`  merged   ${f}`);
      for (const f of res.skipped) console.log(`  skipped  ${f} (exists; pass --yes to overwrite)`);
      if (!res.written.length && !res.merged.length && !res.skipped.length) console.log('  nothing to do — already configured');
      return 0;
    }
    case 'agents-md': {
      console.log(agentsMdBlock(detectProject(cwd)));
      return 0;
    }
    case 'rules': {
      const ctx = detectProject(cwd);
      const applicable = new Set(applicableRules(ctx).map((r) => r.id));
      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              detected: {
                next: ctx.versions.next ? fmt(ctx.versions.next.version) : null,
                react: ctx.versions.react ? fmt(ctx.versions.react.version) : null,
                tailwindcss: ctx.versions.tailwindcss ? fmt(ctx.versions.tailwindcss.version) : null,
                reactCompiler: ctx.reactCompiler,
                appDir: ctx.appDir,
              },
              rules: allRules.map((r) => ({ id: r.id, title: r.title, severity: r.severity, requires: r.requires, applies: applicable.has(r.id), docs: r.docs, instruction: applicable.has(r.id) ? r.instruction(ctx) : null })),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      console.log(`Detected: next ${fmt(ctx.versions.next?.version)}, react ${fmt(ctx.versions.react?.version)}, tailwindcss ${fmt(ctx.versions.tailwindcss?.version)}${ctx.reactCompiler ? ', React Compiler on' : ''}${ctx.appDir ? ', app router' : ''}`);
      console.log('');
      for (const r of allRules) {
        const on = applicable.has(r.id);
        console.log(`  ${on ? '●' : '○'} ${r.id.padEnd(36)} ${r.severity.padEnd(5)} ${on ? 'applies' : 'skipped'} (${r.requires})`);
      }
      console.log(`\n${applicable.size}/${allRules.length} rules apply to this project.`);
      return 0;
    }
    default:
      console.error(`unknown command "${cmd}"\n`);
      console.log(HELP);
      return 1;
  }
}

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    const self = fs.realpathSync(new URL(import.meta.url).pathname);
    return entry === self || /drift-guard(\.js)?$/.test(entry);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      if (process.env.DRIFT_GUARD_DEBUG) console.error(err);
      process.exitCode = 1;
    },
  );
}
