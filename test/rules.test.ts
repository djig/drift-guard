import { describe, expect, it } from 'vitest';
import { allRules } from '../src/rules/index.js';
import { applicableRules } from '../src/engine.js';
import { detectProject } from '../src/versions.js';
import { fixture, hits, ruleIds, runFixture, tempProject } from './helpers.js';
import { run } from '../src/engine.js';

describe('rule registry', () => {
  it('has 23 rules with unique ids and docs', () => {
    expect(allRules).toHaveLength(23);
    expect(new Set(allRules.map((r) => r.id)).size).toBe(23);
    for (const r of allRules) expect(r.docs).toMatch(/^https?:\/\//);
  });
});

describe('next16-app fixture (next 16 / react 19 / tailwind 4)', () => {
  const report = runFixture('next16-app');

  it('applies the version-gated rules', () => {
    const ids = new Set(report.rulesApplied);
    for (const id of ['next/sync-dynamic-apis', 'next/sync-params', 'next/middleware-file', 'next/removed-experimental-flags', 'next/removed-next-lint', 'react/removed-apis', 'tailwind/v3-directives', 'deps/unknown-package']) expect(ids.has(id), id).toBe(true);
    expect(ids.has('react/manual-memo-with-compiler')).toBe(false);
  });

  it('next/sync-dynamic-apis: flags sync cookies(), accepts await / .then', () => {
    expect(hits(report, 'app/api/me/route.ts')).toEqual(['next/sync-dynamic-apis@5']);
  });

  it('next/sync-params: flags plain-object types and sync access; accepts awaited Promise props', () => {
    expect(hits(report, 'app/page.tsx')).toEqual(['next/sync-params@1', 'next/sync-params@1', 'next/sync-params@4', 'next/sync-params@5']);
    expect(hits(report, 'app/blog/[slug]/page.tsx')).toEqual([]);
  });

  it('next/middleware-file: flags root middleware.ts', () => {
    expect(hits(report, 'middleware.ts')).toEqual(['next/middleware-file@1']);
  });

  it('next/revalidate-tag-signature: one-arg form only', () => {
    expect(hits(report, 'app/actions.ts')).toEqual(['next/revalidate-tag-signature@5']);
  });

  it('next/removed-experimental-flags: ppr, dynamicIO, turbo but not serverActions', () => {
    expect(hits(report, 'next.config.ts')).toEqual(['next/removed-experimental-flags@6', 'next/removed-experimental-flags@7', 'next/removed-experimental-flags@8']);
  });

  it('next/pages-apis-in-app-dir', () => {
    expect(hits(report, 'app/legacy/page.tsx')).toEqual(['next/pages-apis-in-app-dir@5']);
  });

  it("next/use-client-root-layout: error at root, warn nested", () => {
    const root = report.findings.find((f) => f.file === 'app/layout.tsx')!;
    expect(root.ruleId).toBe('next/use-client-root-layout');
    expect(root.severity).toBe('error');
    const nested = report.findings.find((f) => f.file === 'app/settings/layout.tsx')!;
    expect(nested.ruleId).toBe('next/use-client-root-layout');
    expect(nested.severity).toBe('warn');
  });

  it('next/fetch-in-effect, legacy-import-paths, use-form-state on a client component', () => {
    expect(hits(report, 'app/dashboard/Client.tsx')).toEqual(['next/legacy-import-paths@3', 'next/use-form-state@4', 'next/fetch-in-effect@10']);
    expect(report.findings.find((f) => f.ruleId === 'next/fetch-in-effect')?.confidence).toBe('medium');
  });

  it('next/edge-runtime-node-client', () => {
    expect(hits(report, 'app/edge/route.ts')).toEqual(['next/edge-runtime-node-client@1']);
  });

  it('next/removed-next-lint in package.json', () => {
    expect(hits(report, 'package.json')).toEqual(['next/removed-next-lint@7']);
  });

  it('next/public-env-secret in .env and in code, ignoring ANON keys', () => {
    expect(hits(report, '.env.local')).toEqual(['next/public-env-secret@3']);
    expect(hits(report, 'lib/utils.ts')).toContain('next/public-env-secret@11');
    expect(hits(report, 'lib/utils.ts')).not.toContain('next/public-env-secret@12');
  });

  it('react/removed-apis + deps/unknown-package in legacy react file', () => {
    expect(hits(report, 'lib/react-legacy.tsx')).toEqual(['deps/unknown-package@3', 'react/removed-apis@8', 'react/removed-apis@9', 'react/removed-apis@11', 'react/removed-apis@12']);
  });

  it('react/forward-ref info, react/index-key, tailwind rules in Button.tsx', () => {
    const h = hits(report, 'components/Button.tsx');
    expect(h).toContain('react/forward-ref@4');
    expect(h).toContain('react/index-key@9');
    expect(h).toContain('tailwind/important-prefix@7');
    expect(h).toContain('tailwind/css-var-arbitrary@7');
    expect(h.filter((x) => x.startsWith('tailwind/renamed-utilities@7')).length).toBeGreaterThanOrEqual(3);
    // "Good" component (lines 17-24) is clean
    expect(h.filter((x) => /@(1[7-9]|2\d)$/.test(x))).toEqual([]);
    // no manual-memo rule without compiler
    expect(h.some((x) => x.startsWith('react/manual-memo'))).toBe(false);
    const renamed = report.findings.filter((f) => f.file === 'components/Button.tsx' && f.ruleId === 'tailwind/renamed-utilities').map((f) => f.fix);
    expect(renamed).toEqual(expect.arrayContaining(['use `bg-linear-to-r`', 'use `bg-<color>/50`', 'use `outline-hidden`', 'use `md:shrink-0`']));
  });

  it('tailwind/v3-directives + @apply renames in css; legacy-config-file project rule', () => {
    expect(hits(report, 'app/globals.css')).toEqual(['tailwind/v3-directives@1', 'tailwind/v3-directives@2', 'tailwind/v3-directives@3', 'tailwind/renamed-utilities@6', 'tailwind/renamed-utilities@6']);
    expect(hits(report, 'tailwind.config.js')).toEqual(['tailwind/legacy-config-file@1']);
  });

  it('deps/unknown-package: hallucinated pkg flagged; alias, scoped subpath, builtins, node_modules-only, virtuals accepted', () => {
    const h = hits(report, 'lib/utils.ts').filter((x) => x.startsWith('deps/'));
    expect(h).toEqual(['deps/unknown-package@1']);
  });

  it('checking a single file still runs project-level rules', () => {
    const r = runFixture('next16-app', ['components/Button.tsx']);
    expect(r.filesChecked).toBe(1);
    expect(ruleIds(r)).toContain('tailwind/legacy-config-file');
    expect(ruleIds(r)).toContain('react/forward-ref');
    expect(ruleIds(r)).not.toContain('next/sync-params');
  });
});

describe('next14-pages fixture (negative controls)', () => {
  const report = runFixture('next14-pages');
  it('does not apply next15/16 rules and finds nothing', () => {
    expect(report.rulesApplied).not.toContain('next/sync-dynamic-apis');
    expect(report.rulesApplied).not.toContain('next/middleware-file');
    expect(report.rulesApplied).not.toContain('next/sync-params');
    expect(report.rulesApplied).not.toContain('react/forward-ref');
    expect(report.findings).toEqual([]);
  });
});

describe('react fixtures', () => {
  it('react18: no react19 rules; index-key still fires', () => {
    const r = runFixture('react18-no-compiler');
    expect(ruleIds(r)).toEqual(['react/index-key']);
  });
  it('react19 + compiler: manual memo info for useMemo/useCallback/memo/React.memo, forwardRef info', () => {
    const r = runFixture('react19-compiler');
    expect(hits(r, 'src/App.tsx')).toEqual(['react/forward-ref@4', 'react/manual-memo-with-compiler@5', 'react/manual-memo-with-compiler@6', 'react/manual-memo-with-compiler@10', 'react/manual-memo-with-compiler@11']);
    for (const f of r.findings) expect(f.severity).toBe('info');
  });
});

describe('tailwind fixtures', () => {
  it('tailwind3: no v4 rules apply', () => {
    const r = runFixture('tailwind3');
    expect(r.rulesApplied.filter((x) => x.startsWith('tailwind/'))).toEqual([]);
    expect(r.findings).toEqual([]);
  });
  it('tailwind4: variants handled, @config satisfies legacy-config-file, v4 idioms suppress resized renames', () => {
    const r = runFixture('tailwind4');
    expect(ruleIds(r)).not.toContain('tailwind/legacy-config-file');
    expect(ruleIds(r)).not.toContain('tailwind/v3-directives');
    expect(ruleIds(r)).not.toContain('deps/unknown-package');
    const card = r.findings.filter((f) => f.file === 'src/Card.tsx');
    expect(card.map((f) => f.fix)).toEqual(['use `md:flex!`', 'use `sm:bg-linear-to-br`', 'use `text-<color>/75`']);
    expect(hits(r, 'src/styles.css')).toEqual([]);
  });
});

describe('targeted rule cases', () => {
  const next16 = (files: Record<string, string>) =>
    tempProject({
      'package.json': JSON.stringify({ dependencies: { next: '16.0.0', react: '19.0.0', 'react-dom': '19.0.0' } }),
      'app/layout.tsx': 'export default function L({children}:{children:React.ReactNode}){return children}',
      ...files,
    });

  it('sync-params: props.params.id and nested destructuring; use(params) is fine', () => {
    const dir = next16({
      'app/a/page.tsx': `export default function P(props: { params: Promise<{ id: string }> }) { const id = props.params.id; return <div>{id}</div>; }`,
      'app/b/page.tsx': `export default function P({ params: { id } }: any) { return <div>{id}</div>; }`,
      'app/c/page.tsx': `import { use } from 'react'; export default function P({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <div>{id}</div>; }`,
      'app/d/page.tsx': `export default async function P(props: { params: Promise<{ id: string }> }) { const { id } = await props.params; return <div>{id}</div>; }`,
    });
    const r = run({ cwd: dir });
    expect(hits(r, 'app/a/page.tsx')).toEqual(['next/sync-params@1']);
    expect(hits(r, 'app/b/page.tsx')).toEqual(['next/sync-params@1']);
    expect(hits(r, 'app/c/page.tsx')).toEqual([]);
    expect(hits(r, 'app/d/page.tsx')).toEqual([]);
  });

  it('sync-params does not fire outside route entry files', () => {
    const dir = next16({ 'components/Thing.tsx': `export function T({ params }: { params: { id: string } }) { return <div>{params.id}</div>; }` });
    expect(hits(run({ cwd: dir }), 'components/Thing.tsx')).toEqual([]);
  });

  it('sync-dynamic-apis: return cookies(), Promise.all, use() are fine; headers() in sync fn flagged', () => {
    const dir = next16({
      'app/x/route.ts': `import { cookies, headers } from 'next/headers';
export async function GET() {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return Response.json({ c, h });
}
export function helper() { return cookies(); }
export function bad() { const h = headers(); return h; }`,
    });
    expect(hits(run({ cwd: dir }), 'app/x/route.ts')).toEqual(['next/sync-dynamic-apis@7']);
  });

  it('middleware-file: src/middleware.ts flagged, proxy.ts exporting middleware flagged, correct proxy.ts fine', () => {
    const dir = next16({ 'src/middleware.ts': 'export function middleware() {}', 'proxy.ts': 'export function middleware() {}\nexport function proxy() {}' });
    const r = run({ cwd: dir });
    expect(hits(r, 'src/middleware.ts')).toEqual(['next/middleware-file@1']);
    expect(hits(r, 'proxy.ts')).toEqual(['next/middleware-file@1']);
    const ok = next16({ 'proxy.ts': 'export function proxy() {}' });
    expect(hits(run({ cwd: ok }), 'proxy.ts')).toEqual([]);
    // middleware.ts nested in a feature folder is not the convention file
    const nested = next16({ 'lib/auth/middleware.ts': 'export const middleware = 1;' });
    expect(hits(run({ cwd: nested }), 'lib/auth/middleware.ts')).toEqual([]);
  });

  it('middleware-file does not apply on next 15', () => {
    const dir = tempProject({ 'package.json': JSON.stringify({ dependencies: { next: '15.5.0' } }), 'middleware.ts': 'export function middleware() {}' });
    expect(run({ cwd: dir }).findings).toEqual([]);
  });

  it('removed-apis: string refs, createFactory, unmountComponentAtNode; defaultProps on class component not flagged', () => {
    const dir = next16({
      'lib/a.tsx': `import React from 'react';
import ReactDOM from 'react-dom';
class Old extends React.Component { render() { return <div ref="legacy" />; } }
Old.defaultProps = {};
const f = React.createFactory('div');
ReactDOM.unmountComponentAtNode(document.body);`,
    });
    expect(hits(run({ cwd: dir }), 'lib/a.tsx')).toEqual(['react/removed-apis@3', 'react/removed-apis@5', 'react/removed-apis@6']);
  });

  it('index-key: template keys and non-index second param; key={item.id} fine', () => {
    const dir = next16({
      'lib/k.tsx': `export const A = ({xs}:{xs:{id:string}[]}) => <>{xs.map((x, idx) => <i key={\`row-\${idx}\`}>{x.id}</i>)}{xs.map((x) => <i key={x.id} />)}{xs.map((x, i) => <i key={x.id + i} />)}</>;`,
    });
    expect(hits(run({ cwd: dir }), 'lib/k.tsx')).toEqual(['react/index-key@1']);
  });

  it('edge runtime: nodejs runtime with prisma is fine; edge + fs flagged', () => {
    const dir = next16({
      'app/a/route.ts': `import fs from 'fs'; export const runtime = 'nodejs'; export function GET(){ return Response.json(fs.existsSync('x')); }`,
      'app/b/route.ts': `import fs from 'node:fs'; import { readFile } from 'fs/promises'; export const runtime = 'edge'; export function GET(){ return Response.json([fs, readFile]); }`,
    });
    const r = run({ cwd: dir });
    expect(hits(r, 'app/a/route.ts')).toEqual([]);
    expect(hits(r, 'app/b/route.ts')).toEqual(['next/edge-runtime-node-client@1', 'next/edge-runtime-node-client@1']);
  });

  it('legacy-import-paths: next/router outside app/ is fine, next/legacy/image everywhere', () => {
    const dir = next16({ 'components/x.tsx': `import { useRouter } from 'next/router'; import Image from 'next/legacy/image'; export const X = () => { useRouter(); return <Image alt="" src="" />; };` });
    expect(hits(run({ cwd: dir }), 'components/x.tsx')).toEqual(['next/legacy-import-paths@1']);
  });

  it('public-env-secret ignores unrelated names and publishable keys', () => {
    const dir = next16({ '.env': 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk\nNEXT_PUBLIC_SITE_URL=x\nSTRIPE_SECRET_KEY=y\nNEXT_PUBLIC_SERVICE_ROLE_KEY=z\n' });
    expect(hits(run({ cwd: dir }), '.env')).toEqual(['next/public-env-secret@4']);
  });

  it('tailwind: negative & arbitrary variants, important suffix, and cn()/clsx() contexts', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ dependencies: { tailwindcss: '4.0.0', clsx: '1' } }),
      'src/a.tsx': `import clsx from 'clsx';
export const A = () => <div className={clsx('-mt-2 hover:!bg-red-500 [&>*]:flex-grow-0', { 'bg-opacity-10': true })} />;
export const notClasses = fetch('bg-opacity-10');`,
    });
    const r = run({ cwd: dir });
    expect(r.findings.map((f) => `${f.ruleId}:${f.fix}`)).toEqual(['tailwind/important-prefix:use `hover:bg-red-500!`', 'tailwind/renamed-utilities:use `[&>*]:grow-0`', 'tailwind/renamed-utilities:use `bg-<color>/10`']);
  });

  it('pages-apis-in-app-dir: fine under pages/, and generateStaticParams is not flagged', () => {
    const dir = next16({ 'pages/old.tsx': 'export async function getStaticProps(){return {props:{}}}; export default function O(){return null}', 'app/n/page.tsx': 'export async function generateStaticParams(){return []}; export default function P(){return null}' });
    expect(ruleIds(run({ cwd: dir }))).not.toContain('next/pages-apis-in-app-dir');
  });

  it('applicableRules lists nothing framework-specific for an empty project', () => {
    const ctx = detectProject(tempProject({ 'package.json': '{}' }));
    expect(applicableRules(ctx).map((r) => r.id)).toEqual(['deps/unknown-package']);
    expect(applicableRules(detectProject(fixture('react18-no-compiler'))).map((r) => r.id)).toEqual(['react/index-key', 'deps/unknown-package']);
  });
});
