import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentsMdBlock, cursorMdc, generatedLines, init, upsertManagedBlock } from '../src/agents.js';
import { detectProject } from '../src/versions.js';
import { fixture, tempCopy } from './helpers.js';

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

describe('generated instructions', () => {
  it('only include applicable rules for next16-app', () => {
    const ctx = detectProject(fixture('next16-app'));
    const lines = generatedLines(ctx);
    expect(lines.some((l) => l.includes('`params` and `searchParams`'))).toBe(true);
    expect(lines.some((l) => l.includes('proxy.ts'))).toBe(true);
    expect(lines.some((l) => l.includes('@import "tailwindcss"'))).toBe(true);
    expect(lines.some((l) => l.includes('React Compiler'))).toBe(false);
    expect(lines.some((l) => l.startsWith('Next 16.1 is installed'))).toBe(true);
  });
  it('next14-pages has no next15/16 or tailwind lines', () => {
    const lines = generatedLines(detectProject(fixture('next14-pages')));
    expect(lines.join('\n')).not.toMatch(/Promise|proxy\.ts|Tailwind|React 19/);
    expect(lines.length).toBeGreaterThan(0);
  });
  it('mdc has frontmatter and globs', () => {
    const mdc = cursorMdc(detectProject(fixture('next16-app')));
    expect(mdc.startsWith('---\ndescription:')).toBe(true);
    expect(mdc).toContain('globs: **/*.tsx,**/*.ts,**/*.css');
    expect(mdc).toContain('alwaysApply: false');
  });
  it('upsertManagedBlock is idempotent and preserves surrounding content', () => {
    const block = agentsMdBlock(detectProject(fixture('next16-app')));
    const once = upsertManagedBlock('# My project\n\nstuff\n', block);
    expect(once.startsWith('# My project')).toBe(true);
    expect(once.match(/BEGIN:drift-guard/g)?.length).toBe(1);
    const twice = upsertManagedBlock(once, block);
    expect(twice).toBe(once);
    const replaced = upsertManagedBlock(once.replace('Run `npx', 'OLD'), block);
    expect(replaced).toBe(once);
  });
});

describe('init', () => {
  it('writes all agent files for --agent all, merging existing settings', () => {
    const dir = tempCopy('next16-app');
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Repo\n\nexisting notes\n');

    const res = init({ cwd: dir, agent: 'all' });
    expect(res.merged).toEqual(expect.arrayContaining(['.claude/settings.json', 'AGENTS.md']));
    expect(res.written).toEqual(expect.arrayContaining(['.codex/hooks.json', '.cursor/hooks.json', '.cursor/rules/drift-guard.mdc', '.github/instructions/drift-guard.instructions.md']));

    const settings = JSON.parse(read(dir, '.claude/settings.json'));
    expect(settings.permissions.allow).toEqual(['Bash']);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[1]).toEqual({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'npx -y @djig/drift-guard hook --agent claude', timeout: 30 }] });

    const codex = JSON.parse(read(dir, '.codex/hooks.json'));
    expect(codex.hooks.PostToolUse[0].hooks[0].command).toBe('npx -y @djig/drift-guard hook --agent codex');

    const cursor = JSON.parse(read(dir, '.cursor/hooks.json'));
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.afterFileEdit[0].command).toBe('npx -y @djig/drift-guard hook --agent cursor');

    const mdc = read(dir, '.cursor/rules/drift-guard.mdc');
    expect(mdc).toContain('params` and `searchParams`');
    expect(mdc).not.toContain('React Compiler');

    const copilot = read(dir, '.github/instructions/drift-guard.instructions.md');
    expect(copilot.startsWith('---\napplyTo: "**/*.ts,**/*.tsx,**/*.css"')).toBe(true);

    const agents = read(dir, 'AGENTS.md');
    expect(agents).toContain('existing notes');
    expect(agents).toContain('<!-- BEGIN:drift-guard -->');
    expect(agents).toContain('Run `npx drift-guard check <file>` before declaring a change done');

    // second run: nothing changes
    const again = init({ cwd: dir, agent: 'all' });
    expect(again.written).toEqual([]);
    expect(again.merged).toEqual([]);
    expect(again.skipped).toEqual([]);
  });

  it('does not overwrite a customised mdc without --yes', () => {
    const dir = tempCopy('next16-app');
    fs.mkdirSync(path.join(dir, '.cursor/rules'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cursor/rules/drift-guard.mdc'), 'custom');
    const res = init({ cwd: dir, agent: 'cursor' });
    expect(res.skipped).toContain('.cursor/rules/drift-guard.mdc');
    expect(read(dir, '.cursor/rules/drift-guard.mdc')).toBe('custom');
    init({ cwd: dir, agent: 'cursor', yes: true });
    expect(read(dir, '.cursor/rules/drift-guard.mdc')).toContain('Version drift guard');
  });

  it('--skill copies the skill into .agents/skills/drift-guard', () => {
    const dir = tempCopy('tailwind4');
    const res = init({ cwd: dir, agent: 'claude', skill: true, skillSourceDir: path.resolve(__dirname, '..', 'skills', 'drift-guard') });
    expect(res.written).toContain('.agents/skills/drift-guard/');
    expect(fs.existsSync(path.join(dir, '.agents/skills/drift-guard/SKILL.md'))).toBe(true);
  });
});
