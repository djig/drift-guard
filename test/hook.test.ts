import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractFilePaths, hookResponse, runHook } from '../src/agents.js';
import { fixture } from './helpers.js';

const cwd = fixture('next16-app');
const abs = (rel: string) => path.join(cwd, rel);

describe('extractFilePaths', () => {
  it('Claude Code Edit/Write/MultiEdit payloads', () => {
    expect(extractFilePaths({ tool_name: 'Edit', tool_input: { file_path: '/a.ts', old_string: '', new_string: '' } }, 'claude')).toEqual(['/a.ts']);
    expect(extractFilePaths({ tool_name: 'Write', tool_input: { file_path: '/b.tsx', content: '' } }, 'claude')).toEqual(['/b.tsx']);
    expect(extractFilePaths({ tool_name: 'MultiEdit', tool_input: { file_path: '/c.ts', edits: [{ old_string: '', new_string: '' }] } }, 'claude')).toEqual(['/c.ts']);
    expect(extractFilePaths({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/n.ipynb' } }, 'claude')).toEqual([]);
    expect(extractFilePaths({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 'claude')).toEqual([]);
  });
  it('Codex apply_patch payload', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch';
    expect(extractFilePaths({ tool_name: 'apply_patch', tool_input: { patch } }, 'codex')).toEqual(['src/a.ts', 'src/b.ts']);
  });
  it('Cursor afterFileEdit payload', () => {
    expect(extractFilePaths({ file_path: '/x.tsx', edits: [{ old_string: 'a', new_string: 'b' }] }, 'cursor')).toEqual(['/x.tsx']);
  });
  it('garbage', () => {
    expect(extractFilePaths(null, 'claude')).toEqual([]);
    expect(extractFilePaths('str', 'claude')).toEqual([]);
  });
});

describe('runHook (claude)', () => {
  it('blocks on error findings with file:line + fix lines, max 6', () => {
    const res = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: abs('app/page.tsx') }, cwd }), 'claude', '/tmp');
    expect(res.output?.decision).toBe('block');
    const reason = res.output?.reason as string;
    expect(reason).toMatch(/^drift-guard: /);
    expect(reason).toContain('app/page.tsx:1');
    expect(reason).toContain('Fix:');
    expect(reason).toContain('next/sync-params');
    expect(reason.split('\n').filter((l) => /^app\//.test(l)).length).toBeLessThanOrEqual(6);
  });
  it('warn/info only → additionalContext, not block', () => {
    const res = runHook(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: abs('app/actions.ts') }, cwd }), 'claude', '/tmp');
    expect(res.output?.decision).toBeUndefined();
    const hso = res.output?.hookSpecificOutput as Record<string, string>;
    expect(hso.hookEventName).toBe('PostToolUse');
    expect(hso.additionalContext).toContain('revalidateTag');
  });
  it('clean file → no output', () => {
    const res = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: abs('app/blog/[slug]/page.tsx') }, cwd }), 'claude', '/tmp');
    expect(res.output).toBeNull();
  });
  it('invalid JSON / unrelated tool → no output, no throw', () => {
    expect(runHook('not json', 'claude', cwd).output).toBeNull();
    expect(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm' } }), 'claude', cwd).output).toBeNull();
    expect(runHook('', 'claude', cwd).output).toBeNull();
  });
  it('relative paths resolve against payload cwd', () => {
    const res = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'middleware.ts' }, cwd }), 'claude', '/nonexistent');
    expect(res.output?.decision).toBe('block');
    expect(res.output?.reason).toContain('proxy.ts');
  });
  it('truncates to 6 findings with a trailer', () => {
    const res = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: abs('lib/react-legacy.tsx') }, cwd, }), 'claude', '/tmp');
    expect(res.findings.filter((f) => f.severity === 'error').length).toBe(5);
    const many = hookResponse('claude', Array.from({ length: 9 }, (_, i) => ({ ruleId: 'r', severity: 'error' as const, file: 'f.ts', line: i + 1, col: 1, message: 'm', fix: 'x', confidence: 'high' as const })), ['f.ts']);
    expect((many?.reason as string)).toContain('and 3 more');
  });
});

describe('runHook (codex)', () => {
  it('uses the same contract as claude', () => {
    const res = runHook(JSON.stringify({ tool_name: 'apply_patch', tool_input: { patch: '*** Update File: next.config.ts\n' }, cwd }), 'codex', cwd);
    expect(res.output?.decision).toBe('block');
    expect(res.output?.reason).toContain('experimental.ppr');
  });
});

describe('runHook (cursor)', () => {
  it('returns agent_message and says it cannot block', () => {
    const res = runHook(JSON.stringify({ file_path: abs('middleware.ts'), edits: [], workspace_roots: [cwd] }), 'cursor', '/tmp');
    expect(Object.keys(res.output!)).toEqual(['agent_message']);
    expect(res.output?.agent_message).toContain('cannot block');
    expect(res.output?.agent_message).toContain('proxy.ts');
  });
  it('drops info-level findings', () => {
    const res = runHook(JSON.stringify({ file_path: path.join(fixture('react19-compiler'), 'src/App.tsx'), workspace_roots: [fixture('react19-compiler')] }), 'cursor', '/tmp');
    expect(res.output).toBeNull();
  });
});
