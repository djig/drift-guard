import { describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/config.js';
import { run } from '../src/engine.js';
import { tempProject } from './helpers.js';

describe('globToRegExp', () => {
  it('matches common patterns', () => {
    expect(globToRegExp('legacy/**').test('legacy/a/b.ts')).toBe(true);
    expect(globToRegExp('**/*.test.ts').test('src/x.test.ts')).toBe(true);
    expect(globToRegExp('**/*.test.ts').test('x.test.ts')).toBe(true);
    expect(globToRegExp('*.css').test('a/b.css')).toBe(false);
    expect(globToRegExp('legacy').test('legacy/x.ts')).toBe(true);
    expect(globToRegExp('src/**/*.{ts,tsx}').test('src/a/b.tsx')).toBe(true);
  });
});

describe('drift-guard.config.json + inline ignores', () => {
  const base = {
    'package.json': JSON.stringify({ dependencies: { next: '16.0.0', react: '19.0.0' } }),
    'app/layout.tsx': 'export default function L(){return null}',
    'middleware.ts': 'export function middleware(){}',
    'legacy/old.tsx': "import ReactDOM from 'react-dom'; ReactDOM.render(null, document.body);",
    'lib/a.ts': "import { revalidateTag } from 'next/cache';\n// drift-guard-ignore-next-line next/revalidate-tag-signature\nexport const a = () => revalidateTag('x');\nexport const b = () => revalidateTag('y'); // drift-guard-ignore\nexport const c = () => revalidateTag('z');\n",
  };

  it('ignore, severity override and exclude', () => {
    const dir = tempProject({
      ...base,
      'drift-guard.config.json': JSON.stringify({ ignore: ['next/middleware-file'], severity: { 'react/removed-apis': 'warn' }, exclude: ['legacy/**'] }),
    });
    const r = run({ cwd: dir });
    expect(r.rulesApplied).not.toContain('next/middleware-file');
    expect(r.findings.find((f) => f.file === 'middleware.ts')).toBeUndefined();
    expect(r.findings.find((f) => f.file.startsWith('legacy/'))).toBeUndefined();

    const r2 = run({ cwd: tempProject({ ...base, 'drift-guard.config.json': JSON.stringify({ severity: { 'react/removed-apis': 'warn' } }) }) });
    expect(r2.findings.find((f) => f.file === 'legacy/old.tsx')?.severity).toBe('warn');
  });

  it('inline ignore comments suppress a single finding', () => {
    const r = run({ cwd: tempProject(base) });
    expect(r.findings.filter((f) => f.file === 'lib/a.ts').map((f) => f.line)).toEqual([5]);
  });

  it('minSeverity filters', () => {
    const r = run({ cwd: tempProject(base), minSeverity: 'error' });
    expect(r.findings.every((f) => f.severity === 'error')).toBe(true);
  });
});
