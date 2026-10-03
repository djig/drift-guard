import fs from 'node:fs';
import path from 'node:path';
import { applicableRules, hasErrors, run } from './engine.js';
import { formatForAgent } from './format.js';
import { allRules } from './rules/index.js';
import { fmt } from './semver.js';
import type { Finding, ProjectContext, Rule } from './types.js';
import { detectProject } from './versions.js';

export type Agent = 'claude' | 'codex' | 'cursor';
export type InitAgent = Agent | 'copilot' | 'all';

export const HOOK_COMMAND = (agent: Agent): string => `npx -y @djig/drift-guard hook --agent ${agent}`;

// ---------------------------------------------------------------------------
// Hook payloads
// ---------------------------------------------------------------------------

/** Extract edited file paths from a Claude Code / Codex / Cursor hook payload. Returns [] for tools we don't care about. */
export function extractFilePaths(payload: unknown, agent: Agent): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) out.add(v);
  };

  if (agent === 'cursor') {
    add(p.file_path);
    add(p.filePath);
    if (Array.isArray(p.files)) for (const f of p.files) add(typeof f === 'string' ? f : (f as Record<string, unknown>)?.path);
    return [...out];
  }

  const toolName = typeof p.tool_name === 'string' ? p.tool_name : typeof p.toolName === 'string' ? p.toolName : '';
  if (/^NotebookEdit$/i.test(toolName)) return [];
  const input = (p.tool_input ?? p.toolInput ?? p.input ?? {}) as Record<string, unknown>;
  add(input.file_path);
  add(input.filePath);
  add(input.path);
  add(input.notebook_path === undefined ? undefined : undefined);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (e && typeof e === 'object') add((e as Record<string, unknown>).file_path);
  }
  // Codex `apply_patch` style: parse "*** Update File: path" / "*** Add File: path"
  const patch = typeof input.patch === 'string' ? input.patch : typeof input.input === 'string' ? input.input : null;
  if (patch) {
    for (const m of patch.matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)) add(m[1]?.trim());
  }
  if (toolName && !/^(Edit|Write|MultiEdit|apply_patch|shell|bash|str_replace_editor|create_file|write_file|edit_file|FileEdit|FileWrite)$/i.test(toolName) && out.size === 0) return [];
  return [...out];
}

export interface HookResult {
  /** JSON object to print on stdout, or null for no output. */
  output: Record<string, unknown> | null;
  findings: Finding[];
  files: string[];
}

export function hookResponse(agent: Agent, findings: Finding[], files: string[]): Record<string, unknown> | null {
  if (findings.length === 0) return null;
  const errors = findings.filter((f) => f.severity === 'error');
  const warnInfo = findings.filter((f) => f.severity !== 'error');

  if (agent === 'cursor') {
    const sorted = [...errors, ...warnInfo];
    const note = errors.length > 0 ? ' (afterFileEdit hooks cannot block; fix these before continuing.)' : '';
    return { agent_message: `drift-guard found version drift in ${files.map((f) => path.basename(f)).join(', ')}${note}\n${formatForAgent(sorted)}` };
  }

  if (errors.length > 0) {
    return {
      decision: 'block',
      reason: `drift-guard: the edit uses patterns from an older framework version than the one installed. Fix these before continuing:\n${formatForAgent(errors)}`,
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `drift-guard notes (non-blocking):\n${formatForAgent(warnInfo)}`,
    },
  };
}

export function runHook(payloadText: string, agent: Agent, cwd: string): HookResult {
  let payload: unknown;
  try {
    payload = payloadText.trim() ? JSON.parse(payloadText) : {};
  } catch {
    return { output: null, findings: [], files: [] };
  }
  const p = payload as Record<string, unknown>;
  const projectDir = typeof p.cwd === 'string' && p.cwd ? p.cwd : typeof p.workspace_roots === 'object' && Array.isArray(p.workspace_roots) && typeof p.workspace_roots[0] === 'string' ? p.workspace_roots[0] : cwd;
  const files = extractFilePaths(payload, agent).map((f) => (path.isAbsolute(f) ? f : path.resolve(projectDir, f)));
  if (files.length === 0) return { output: null, findings: [], files: [] };
  const report = run({ cwd: projectDir, files });
  // Only report findings located in the files the agent just touched (project-level
  // rules may surface other files; those belong in `check`, not in an edit hook).
  const touched = new Set(files.map((f) => path.relative(report.cwd, f).split(path.sep).join('/')));
  let findings = report.findings.filter((f) => touched.has(f.file));
  // Cursor: warn+ ; Claude/Codex: everything (info goes to additionalContext)
  if (agent === 'cursor') findings = findings.filter((f) => f.severity !== 'info');
  return { output: hookResponse(agent, findings, files), findings, files };
}

// ---------------------------------------------------------------------------
// Generated instructions
// ---------------------------------------------------------------------------

export function generatedLines(ctx: ProjectContext, rules: Rule[] = allRules): string[] {
  const lines: string[] = [];
  for (const r of applicableRules(ctx, rules)) {
    const l = r.instruction(ctx);
    if (l) lines.push(l);
  }
  return lines;
}

export function versionsLine(ctx: ProjectContext): string {
  const v = ctx.versions;
  const parts: string[] = [];
  if (v.next) parts.push(`next ${fmt(v.next.version)}`);
  if (v.react) parts.push(`react ${fmt(v.react.version)}`);
  if (v.tailwindcss) parts.push(`tailwindcss ${fmt(v.tailwindcss.version)}`);
  if (v.typescript) parts.push(`typescript ${fmt(v.typescript.version)}`);
  if (ctx.reactCompiler) parts.push('React Compiler on');
  return parts.length ? parts.join(', ') : 'no React/Next/Tailwind detected';
}

export const BLOCK_BEGIN = '<!-- BEGIN:drift-guard -->';
export const BLOCK_END = '<!-- END:drift-guard -->';

export function agentsMdBlock(ctx: ProjectContext): string {
  const lines = generatedLines(ctx);
  const body = [
    BLOCK_BEGIN,
    '## Version drift guard (generated by drift-guard — do not edit by hand)',
    '',
    `Installed: ${versionsLine(ctx)}. Your training data may describe older versions; the rules below are what is true for *this* project.`,
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    'Run `npx drift-guard check <file>` before declaring a change done; fix `error` findings rather than suppressing them.',
    BLOCK_END,
  ];
  return body.join('\n');
}

export function upsertManagedBlock(existing: string | null, block: string): string {
  if (!existing) return block + '\n';
  const start = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
  }
  return existing.replace(/\s*$/, '') + '\n\n' + block + '\n';
}

export function cursorMdc(ctx: ProjectContext): string {
  const lines = generatedLines(ctx);
  return [
    '---',
    `description: Version-specific rules for this project (${versionsLine(ctx)}). Generated by drift-guard.`,
    'globs: **/*.tsx,**/*.ts,**/*.css',
    'alwaysApply: false',
    '---',
    '',
    '# Version drift guard',
    '',
    `Installed: ${versionsLine(ctx)}. Follow these over anything you remember from training data:`,
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    'Run `npx drift-guard check <file>` on files you edit and fix every `error` finding.',
    '',
  ].join('\n');
}

export function copilotInstructions(ctx: ProjectContext): string {
  const lines = generatedLines(ctx);
  return [
    '---',
    'applyTo: "**/*.ts,**/*.tsx,**/*.css"',
    '---',
    '',
    '# Version drift guard',
    '',
    `Installed: ${versionsLine(ctx)}. Follow these over anything you remember from training data:`,
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    'Run `npx drift-guard check <file>` on files you edit and fix every `error` finding.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export interface InitOptions {
  cwd: string;
  agent: InitAgent;
  yes?: boolean;
  skill?: boolean;
  /** Where to copy the skill from (defaults to the package's own skills/ dir). */
  skillSourceDir?: string;
}

export interface InitResult {
  written: string[];
  skipped: string[];
  merged: string[];
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function hookEntryClaudeStyle(agent: Agent): Record<string, unknown> {
  return {
    matcher: 'Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command: HOOK_COMMAND(agent), timeout: 30 }],
  };
}

/** Merge a PostToolUse hook entry into a Claude-Code-shaped settings object. Returns true if changed. */
export function mergeHookIntoSettings(settings: Record<string, unknown>, agent: Agent): boolean {
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const post = (hooks.PostToolUse ??= []) as unknown[];
  if (!Array.isArray(post)) return false;
  const cmd = HOOK_COMMAND(agent);
  const already = post.some((entry) => {
    const hs = (entry as Record<string, unknown>)?.hooks;
    return Array.isArray(hs) && hs.some((h) => typeof (h as Record<string, unknown>)?.command === 'string' && ((h as Record<string, unknown>).command as string).includes('drift-guard hook'));
  });
  if (already) return false;
  post.push(hookEntryClaudeStyle(agent));
  void cmd;
  return true;
}

export function init(opts: InitOptions): InitResult {
  const cwd = path.resolve(opts.cwd);
  const ctx = detectProject(cwd);
  const res: InitResult = { written: [], skipped: [], merged: [] };
  const agents: InitAgent[] = opts.agent === 'all' ? ['claude', 'codex', 'cursor', 'copilot'] : [opts.agent];

  const writeOrSkip = (rel: string, content: string): void => {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs) && !opts.yes) {
      if (fs.readFileSync(abs, 'utf8') === content) return;
      res.skipped.push(rel);
      return;
    }
    writeFile(abs, content);
    res.written.push(rel);
  };

  const mergeJsonHooks = (rel: string, agent: Agent): void => {
    const abs = path.join(cwd, rel);
    const existing = fs.existsSync(abs) ? readJsonFile(abs) : null;
    if (fs.existsSync(abs) && existing === null) {
      res.skipped.push(`${rel} (invalid JSON)`);
      return;
    }
    const settings = existing ?? {};
    const changed = mergeHookIntoSettings(settings, agent);
    if (!changed) return;
    writeFile(abs, JSON.stringify(settings, null, 2) + '\n');
    (existing ? res.merged : res.written).push(rel);
  };

  for (const a of agents) {
    if (a === 'claude') mergeJsonHooks('.claude/settings.json', 'claude');
    if (a === 'codex') mergeJsonHooks('.codex/hooks.json', 'codex');
    if (a === 'cursor') {
      const abs = path.join(cwd, '.cursor/hooks.json');
      const existing = fs.existsSync(abs) ? readJsonFile(abs) : null;
      if (fs.existsSync(abs) && existing === null) res.skipped.push('.cursor/hooks.json (invalid JSON)');
      else {
        const cfg = existing ?? { version: 1, hooks: {} };
        cfg.version ??= 1;
        const hooks = (cfg.hooks ??= {}) as Record<string, unknown>;
        const after = (hooks.afterFileEdit ??= []) as unknown[];
        if (Array.isArray(after) && !after.some((h) => typeof (h as Record<string, unknown>)?.command === 'string' && ((h as Record<string, unknown>).command as string).includes('drift-guard'))) {
          after.push({ command: HOOK_COMMAND('cursor') });
          writeFile(abs, JSON.stringify(cfg, null, 2) + '\n');
          (existing ? res.merged : res.written).push('.cursor/hooks.json');
        }
      }
      writeOrSkip('.cursor/rules/drift-guard.mdc', cursorMdc(ctx));
    }
    if (a === 'copilot') writeOrSkip('.github/instructions/drift-guard.instructions.md', copilotInstructions(ctx));
  }

  // AGENTS.md managed block (always; merges)
  const agentsPath = path.join(cwd, 'AGENTS.md');
  const existingAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null;
  const next = upsertManagedBlock(existingAgents, agentsMdBlock(ctx));
  if (next !== existingAgents) {
    writeFile(agentsPath, next);
    (existingAgents ? res.merged : res.written).push('AGENTS.md');
  }

  if (opts.skill) {
    const src = opts.skillSourceDir ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'skills', 'drift-guard');
    const dest = path.join(cwd, '.agents', 'skills', 'drift-guard');
    if (fs.existsSync(src)) {
      if (fs.existsSync(dest) && !opts.yes) res.skipped.push('.agents/skills/drift-guard/');
      else {
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
        res.written.push('.agents/skills/drift-guard/');
      }
    } else res.skipped.push('.agents/skills/drift-guard/ (skill source not found)');
  }

  return res;
}

export { hasErrors };
