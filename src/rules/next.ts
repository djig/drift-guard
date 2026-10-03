import ts from 'typescript';
import { gte, short } from '../semver.js';
import type { FileInfo, Finding, ProjectContext, Rule } from '../types.js';
import { baseNameNoExt, calleeName, calleeText, collectImports, finding, findingAt, hasUseClient, inAppDir, posOf, walk } from '../file.js';

const NEXT_DOCS = 'https://nextjs.org/docs';

function nextGte(ctx: ProjectContext, major: number, minor = 0): boolean {
  return gte(ctx.versions.next?.version, major, minor);
}

function nextV(ctx: ProjectContext): string {
  return short(ctx.versions.next?.version);
}

/** Is `node` awaited / thenable-handled somewhere up its expression chain (within the enclosing statement)? */
function isAwaitedUpward(node: ts.Node): boolean {
  let cur: ts.Node = node;
  while (cur.parent) {
    const p: ts.Node = cur.parent;
    if (ts.isAwaitExpression(p)) return true;
    if (ts.isPropertyAccessExpression(p) && p.expression === cur && /^(then|catch|finally)$/.test(p.name.text)) return true;
    if (ts.isReturnStatement(p)) return true; // caller awaits
    if (ts.isCallExpression(p) && p.expression !== cur) {
      // argument position: use(x), Promise.all([...]), React.use(x)
      const name = calleeName(p);
      if (name === 'use' || name === 'all' || name === 'allSettled' || name === 'race' || name === 'any') return true;
      return false;
    }
    if (ts.isArrayLiteralExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p) || ts.isSpreadElement(p)) {
      cur = p;
      continue;
    }
    if (ts.isArrowFunction(p) && p.body === cur) return true; // concise arrow body returns it
    if (ts.isVariableDeclaration(p) || ts.isExpressionStatement(p) || ts.isPropertyAssignment(p) || ts.isBinaryExpression(p)) return false;
    if (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) return false;
    cur = p;
  }
  return false;
}

// 1 ---------------------------------------------------------------------------
export const syncDynamicApis: Rule = {
  id: 'next/sync-dynamic-apis',
  title: 'cookies()/headers()/draftMode() must be awaited (Next 15+)',
  severity: 'error',
  requires: 'next >= 15',
  docs: 'https://nextjs.org/docs/messages/sync-dynamic-apis',
  appliesWhen: (ctx) => nextGte(ctx, 15),
  instruction: (ctx) => `Next ${nextV(ctx)} is installed: \`cookies()\`, \`headers()\` and \`draftMode()\` from \`next/headers\` return Promises — always \`await\` them.`,
  check(file, ctx) {
    const sf = file.ast;
    if (!sf || !file.isScript) return [];
    const imports = collectImports(sf);
    const fromHeaders = imports.find((i) => i.specifier === 'next/headers');
    if (!fromHeaders && !file.source.includes('next/headers')) return [];
    const names = new Set((fromHeaders?.names ?? ['cookies', 'headers', 'draftMode']).filter((n) => /^(cookies|headers|draftMode)$/.test(n)));
    if (names.size === 0) return [];
    const out: Finding[] = [];
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
      const name = n.expression.text;
      if (!names.has(name)) return;
      if (isAwaitedUpward(n)) return;
      out.push(findingAt(this, file, n, `\`${name}()\` is async in Next ${nextV(ctx)} but is used synchronously.`, `await ${name}()  (and make the enclosing function async)`));
    });
    return out;
  },
};

// 2 ---------------------------------------------------------------------------
const ROUTE_ENTRY = /^(page|layout|route|default|template|opengraph-image|twitter-image|sitemap|icon|apple-icon)$/;

function isRouteEntryFile(file: FileInfo, ctx: ProjectContext): boolean {
  return inAppDir(file, ctx) && ROUTE_ENTRY.test(baseNameNoExt(file.rel));
}

export const syncParams: Rule = {
  id: 'next/sync-params',
  title: '`params` / `searchParams` are Promises (Next 15+)',
  severity: 'error',
  requires: 'next >= 15, app router',
  docs: 'https://nextjs.org/docs/messages/sync-dynamic-apis',
  appliesWhen: (ctx) => nextGte(ctx, 15) && ctx.appDir,
  instruction: (ctx) => `Next ${nextV(ctx)} is installed: \`params\` and \`searchParams\` props in page/layout/route files are Promises — type them as \`Promise<...>\` and \`await\` them.`,
  check(file, ctx) {
    const sf = file.ast;
    if (!sf || !isRouteEntryFile(file, ctx)) return [];
    const out: Finding[] = [];
    const fix = 'type as `params: Promise<{ … }>` and `const { id } = await params`';

    // (a) type annotations: params: { ... } instead of Promise<...>
    walk(sf, (n) => {
      if (ts.isPropertySignature(n) && n.type && ts.isIdentifier(n.name) && /^(params|searchParams)$/.test(n.name.text)) {
        const t = n.type;
        const isPromise = ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === 'Promise';
        const isAny = t.kind === ts.SyntaxKind.AnyKeyword || t.kind === ts.SyntaxKind.UnknownKeyword;
        const isRef = ts.isTypeReferenceNode(t) && !isPromise; // e.g. a named alias; can't resolve
        if (!isPromise && !isAny && !isRef) {
          out.push(findingAt(this, file, n, `\`${n.name.text}\` is typed as a plain object; in Next ${nextV(ctx)} it is a Promise.`, fix));
        }
      }
    });

    // (b) usage: destructured params used synchronously
    const visitFn = (fn: ts.FunctionLikeDeclaration): void => {
      const first = fn.parameters[0];
      if (!first || !fn.body) return;
      const body = fn.body;
      const tracked: Array<{ name: string; prop: string }> = [];
      if (ts.isObjectBindingPattern(first.name)) {
        for (const el of first.name.elements) {
          const propName = el.propertyName ? (ts.isIdentifier(el.propertyName) ? el.propertyName.text : null) : ts.isIdentifier(el.name) ? el.name.text : null;
          if (!propName || !/^(params|searchParams)$/.test(propName)) continue;
          if (ts.isObjectBindingPattern(el.name)) {
            // { params: { id } } — synchronous nested destructuring
            out.push(findingAt(this, file, el, `\`${propName}\` is destructured synchronously; it is a Promise in Next ${nextV(ctx)}.`, fix));
            continue;
          }
          if (ts.isIdentifier(el.name)) tracked.push({ name: el.name.text, prop: propName });
        }
      } else if (ts.isIdentifier(first.name)) {
        const propsName = first.name.text;
        walk(body, (n) => {
          if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === propsName && /^(params|searchParams)$/.test(n.name.text)) {
            const p = n.parent;
            if (ts.isAwaitExpression(p) || (ts.isCallExpression(p) && calleeName(p) === 'use')) return;
            if (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || (ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name))) {
              out.push(findingAt(this, file, n, `\`${propsName}.${n.name.text}\` is accessed synchronously; it is a Promise in Next ${nextV(ctx)}.`, fix));
            }
          }
        });
      }
      for (const t of tracked) {
        walk(body, (n) => {
          if (!ts.isIdentifier(n) || n.text !== t.name) return;
          const p = n.parent;
          if (ts.isPropertyAccessExpression(p) && p.expression === n) {
            if (/^(then|catch|finally)$/.test(p.name.text)) return;
            out.push(findingAt(this, file, n, `\`${t.prop}.${p.name.text}\` is read synchronously; \`${t.prop}\` is a Promise in Next ${nextV(ctx)}.`, fix));
          } else if (ts.isElementAccessExpression(p) && p.expression === n) {
            out.push(findingAt(this, file, n, `\`${t.prop}[…]\` is read synchronously; \`${t.prop}\` is a Promise in Next ${nextV(ctx)}.`, fix));
          } else if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isObjectBindingPattern(p.name)) {
            out.push(findingAt(this, file, n, `\`${t.prop}\` is destructured without await; it is a Promise in Next ${nextV(ctx)}.`, fix));
          } else if (ts.isSpreadAssignment(p) || ts.isSpreadElement(p)) {
            out.push(findingAt(this, file, n, `\`${t.prop}\` is spread without await; it is a Promise in Next ${nextV(ctx)}.`, fix));
          }
        });
      }
    };
    walk(sf, (n) => {
      if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) visitFn(n);
    });
    return out;
  },
};

// 3 ---------------------------------------------------------------------------
export const middlewareFile: Rule = {
  id: 'next/middleware-file',
  title: '`middleware.ts` is replaced by `proxy.ts` (Next 16+)',
  severity: 'error',
  requires: 'next >= 16',
  docs: 'https://nextjs.org/docs/app/api-reference/file-conventions/proxy',
  appliesWhen: (ctx) => nextGte(ctx, 16),
  instruction: (ctx) => `Next ${nextV(ctx)} is installed: do not create \`middleware.ts\`; the file is \`proxy.ts\` exporting a \`proxy\` function (middleware.ts silently does nothing).`,
  check(file) {
    const out: Finding[] = [];
    const base = baseNameNoExt(file.rel);
    const dir = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/')) : '';
    if (dir !== '' && dir !== 'src') return out;
    if (base === 'middleware' && file.isScript) {
      out.push(finding(this, file, 1, 1, `\`${file.rel}\` is ignored by Next 16+; it compiles, type-checks and does nothing at runtime.`, `rename to ${dir ? dir + '/' : ''}proxy.ts and export \`function proxy(request)\` (run \`npx @next/codemod@canary middleware-to-proxy .\`)`));
    }
    if (base === 'proxy' && file.isScript) {
      const sf = file.ast;
      if (sf) {
        for (const st of sf.statements) {
          const isExport = ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (!isExport) continue;
          if (ts.isFunctionDeclaration(st) && st.name?.text === 'middleware') {
            out.push(findingAt(this, file, st.name, '`proxy.ts` must export `proxy`, not `middleware`.', 'rename the export to `proxy`'));
          }
          if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
              if (ts.isIdentifier(d.name) && d.name.text === 'middleware') {
                out.push(findingAt(this, file, d.name, '`proxy.ts` must export `proxy`, not `middleware`.', 'rename the export to `proxy`'));
              }
            }
          }
        }
      }
    }
    return out;
  },
};

// 4 ---------------------------------------------------------------------------
export const revalidateTagSignature: Rule = {
  id: 'next/revalidate-tag-signature',
  title: '`revalidateTag(tag)` single-argument form is deprecated (Next 16+)',
  severity: 'warn',
  requires: 'next >= 16',
  docs: 'https://nextjs.org/docs/app/api-reference/functions/revalidateTag',
  appliesWhen: (ctx) => nextGte(ctx, 16),
  instruction: (ctx) => `Next ${nextV(ctx)} is installed: \`revalidateTag(tag)\` takes a second argument (a cacheLife profile such as \`'max'\`); for read-your-own-writes use \`updateTag(tag)\` in Server Actions.`,
  check(file) {
    const sf = file.ast;
    if (!sf || !file.source.includes('revalidateTag')) return [];
    const out: Finding[] = [];
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && calleeName(n) === 'revalidateTag' && n.arguments.length === 1) {
        out.push(findingAt(this, file, n, '`revalidateTag(tag)` with one argument is the deprecated Next 15 signature.', "add a second arg: revalidateTag(tag, 'max') — or use updateTag(tag) inside a Server Action"));
      }
    });
    return out;
  },
};

// 5 ---------------------------------------------------------------------------
const REMOVED_FLAGS: Record<string, string> = {
  ppr: 'replace `experimental.ppr` with top-level `cacheComponents: true`',
  dynamicIO: 'replace `experimental.dynamicIO` with top-level `cacheComponents: true`',
  turbo: 'move `experimental.turbo` to top-level `turbopack`',
};

export const removedExperimentalFlags: Rule = {
  id: 'next/removed-experimental-flags',
  title: 'Removed `experimental.*` flags in next.config (Next 16+)',
  severity: 'error',
  requires: 'next >= 16',
  docs: 'https://nextjs.org/docs/app/guides/upgrading/version-16',
  appliesWhen: (ctx) => nextGte(ctx, 16),
  instruction: (ctx) => `Next ${nextV(ctx)} is installed: \`experimental.ppr\`, \`experimental.dynamicIO\` and \`experimental.turbo\` no longer exist in next.config — use \`cacheComponents: true\` and top-level \`turbopack\`.`,
  check(file) {
    if (!/^next\.config\.(js|mjs|cjs|ts|mts)$/.test(file.rel)) return [];
    const sf = file.ast;
    if (!sf) return [];
    const out: Finding[] = [];
    walk(sf, (n) => {
      if (!ts.isPropertyAssignment(n) || !ts.isObjectLiteralExpression(n.initializer)) return;
      const key = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : null;
      if (key !== 'experimental') return;
      for (const prop of n.initializer.properties) {
        const pk = (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
        if (pk && REMOVED_FLAGS[pk]) {
          out.push(findingAt(this, file, prop, `\`experimental.${pk}\` was removed in Next 16; the build will fail or ignore it.`, REMOVED_FLAGS[pk]!));
        }
      }
    });
    return out;
  },
};

// 6 ---------------------------------------------------------------------------
const PAGES_APIS = /^(getServerSideProps|getStaticProps|getStaticPaths|getInitialProps)$/;

export const pagesApisInAppDir: Rule = {
  id: 'next/pages-apis-in-app-dir',
  title: 'Pages-router data APIs exported from `app/`',
  severity: 'error',
  requires: 'next, app router',
  docs: 'https://nextjs.org/docs/app/guides/migrating/app-router-migration',
  appliesWhen: (ctx) => !!ctx.versions.next && ctx.appDir,
  instruction: () => 'The App Router is in use: never export `getServerSideProps`, `getStaticProps`, `getStaticPaths` or `getInitialProps` from files under `app/` — fetch directly in async Server Components.',
  check(file, ctx) {
    const sf = file.ast;
    if (!sf || !inAppDir(file, ctx)) return [];
    const out: Finding[] = [];
    const flag = (node: ts.Node, name: string): void => {
      out.push(findingAt(this, file, node, `\`${name}\` is a Pages Router API; it is silently ignored under \`app/\`.`, 'fetch data directly in the async Server Component (or use `generateStaticParams` for static paths)'));
    };
    for (const st of sf.statements) {
      const exported = ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isFunctionDeclaration(st) && st.name && PAGES_APIS.test(st.name.text) && exported) flag(st.name, st.name.text);
      if (ts.isVariableStatement(st) && exported) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && PAGES_APIS.test(d.name.text)) flag(d.name, d.name.text);
      }
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) if (PAGES_APIS.test(el.name.text)) flag(el.name, el.name.text);
      }
      // Component.getInitialProps = ...
      if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && ts.isPropertyAccessExpression(st.expression.left) && st.expression.left.name.text === 'getInitialProps') {
        flag(st.expression.left.name, 'getInitialProps');
      }
    }
    return out;
  },
};

// 7 ---------------------------------------------------------------------------
export const useClientRootLayout: Rule = {
  id: 'next/use-client-root-layout',
  title: "'use client' in a layout",
  severity: 'error',
  requires: 'next >= 13, app router',
  docs: 'https://nextjs.org/docs/app/api-reference/file-conventions/layout',
  appliesWhen: (ctx) => nextGte(ctx, 13) && ctx.appDir,
  instruction: () => "Root `app/layout.tsx` must stay a Server Component (it renders `<html>`/`<body>` and metadata): never add `'use client'` to it — move interactive parts into a child component.",
  check(file, ctx) {
    if (!file.isScript || !inAppDir(file, ctx) || baseNameNoExt(file.rel) !== 'layout') return [];
    if (!hasUseClient(file)) return [];
    const root = ctx.appDirPath ?? (file.rel.startsWith('src/app/') ? 'src/app' : 'app');
    const isRoot = file.rel.replace(/\.[^.]+$/, '') === `${root}/layout`;
    const line = file.lines.findIndex((l) => /['"]use client['"]/.test(l)) + 1 || 1;
    if (isRoot) {
      return [finding(this, file, line, 1, "Root layout is marked 'use client'; metadata export and <html>/<body> rendering break and the whole tree becomes client-rendered.", "remove 'use client' here; wrap interactive UI in a client component imported into the layout")];
    }
    return [finding(this, file, line, 1, "Nested layout is marked 'use client'; every route below it loses Server Component benefits.", "remove 'use client' from the layout and move stateful UI into a client child", { severity: 'warn', confidence: 'medium' })];
  },
};

// 8 ---------------------------------------------------------------------------
export const fetchInEffect: Rule = {
  id: 'next/fetch-in-effect',
  title: 'Client-side fetch-in-useEffect inside the App Router',
  severity: 'warn',
  requires: 'next >= 13, app router',
  docs: 'https://nextjs.org/docs/app/getting-started/fetching-data',
  appliesWhen: (ctx) => nextGte(ctx, 13) && ctx.appDir,
  instruction: () => 'With the App Router, do not fetch data in `useEffect` + `useState` inside `app/` client components by default — fetch in the async Server Component, a Server Action, or React 19 `use()`.',
  check(file, ctx) {
    const sf = file.ast;
    if (!sf || !inAppDir(file, ctx) || !hasUseClient(file)) return [];
    if (!/useEffect/.test(file.source) || !/\bfetch\s*\(|\baxios\b/.test(file.source)) return [];
    const setters = new Set<string>();
    walk(sf, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer && ts.isCallExpression(n.initializer) && calleeName(n.initializer) === 'useState') {
        const s = n.name.elements[1];
        if (s && ts.isBindingElement(s) && ts.isIdentifier(s.name)) setters.add(s.name.text);
      }
    });
    if (setters.size === 0) return [];
    const out: Finding[] = [];
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || calleeName(n) !== 'useEffect') return;
      const cb = n.arguments[0];
      if (!cb) return;
      const txt = cb.getText(sf);
      const hasFetch = /\bfetch\s*\(|\baxios\s*[.(]/.test(txt);
      const usesSetter = [...setters].some((s) => new RegExp(`\\b${s}\\b`).test(txt));
      if (hasFetch && usesSetter) {
        out.push(findingAt(this, file, n, 'Data is fetched client-side in useEffect and stored in useState — the 2021 pattern; in the App Router this waterfalls and skips the cache.', 'fetch in the parent Server Component and pass props, or use a Server Action / React 19 `use(promise)`', { confidence: 'medium' }));
      }
    });
    return out;
  },
};

// 9 ---------------------------------------------------------------------------
const NODE_ONLY = new Set(['@prisma/client', 'drizzle-orm/node-postgres', 'pg', 'mysql2', 'mysql2/promise', 'mongoose', 'bcrypt', 'fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'child_process', 'node:child_process', 'net', 'node:net', 'tls', 'node:tls']);

export const edgeRuntimeNodeClient: Rule = {
  id: 'next/edge-runtime-node-client',
  title: 'Node-only module imported in an Edge runtime file',
  severity: 'error',
  requires: 'next',
  docs: 'https://nextjs.org/docs/app/api-reference/edge',
  appliesWhen: (ctx) => !!ctx.versions.next,
  instruction: () => "Files that declare `export const runtime = 'edge'` cannot import Node-only modules (`@prisma/client`, `pg`, `mysql2`, `mongoose`, `bcrypt`, `fs`, `child_process`) — use `runtime = 'nodejs'` or an edge-compatible driver.",
  check(file) {
    const sf = file.ast;
    if (!sf || !/runtime\s*=\s*['"]edge['"]/.test(file.source)) return [];
    let isEdge = false;
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === 'runtime' && d.initializer && ts.isStringLiteralLike(d.initializer) && d.initializer.text === 'edge') isEdge = true;
        }
      }
    }
    if (!isEdge) return [];
    const out: Finding[] = [];
    for (const imp of collectImports(sf)) {
      if (NODE_ONLY.has(imp.specifier) || imp.specifier.startsWith('@prisma/client/')) {
        out.push(findingAt(this, file, imp.node, `\`${imp.specifier}\` is Node-only but this file runs on the Edge runtime; it fails at build or at request time.`, "change to `export const runtime = 'nodejs'` or use an edge-compatible driver (e.g. Prisma Accelerate / Neon serverless)"));
      }
    }
    return out;
  },
};

// 10 --------------------------------------------------------------------------
export const removedNextLint: Rule = {
  id: 'next/removed-next-lint',
  title: '`next lint` was removed (Next 16+)',
  severity: 'error',
  requires: 'next >= 16',
  docs: 'https://nextjs.org/docs/app/guides/upgrading/version-16',
  appliesWhen: (ctx) => nextGte(ctx, 16),
  instruction: (ctx) => `Next ${nextV(ctx)} is installed: the \`next lint\` command no longer exists — run \`eslint .\` (or Biome) directly in package.json scripts.`,
  check(file) {
    if (file.rel !== 'package.json') return [];
    const out: Finding[] = [];
    file.lines.forEach((l, i) => {
      const m = /["'][^"']*\bnext lint\b/.exec(l);
      if (m) out.push(finding(this, file, i + 1, m.index + 1, '`next lint` was removed in Next 16; this script fails.', 'replace with `eslint .` (run `npx @next/codemod@canary next-lint-to-eslint-cli .`) or `biome check .`'));
    });
    return out;
  },
};

// 11 --------------------------------------------------------------------------
const SECRET_RE = /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|SERVICE_ROLE)[A-Z0-9_]*/gi;

export const publicEnvSecret: Rule = {
  id: 'next/public-env-secret',
  title: 'Secret-looking name under NEXT_PUBLIC_*',
  severity: 'error',
  requires: 'next',
  docs: 'https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser',
  appliesWhen: (ctx) => !!ctx.versions.next,
  instruction: () => '`NEXT_PUBLIC_*` variables are inlined into the browser bundle: never put secrets, tokens, private keys or service-role keys under that prefix.',
  check(file) {
    const isEnv = /(^|\/)\.env(\..*)?$/.test(file.rel);
    if (!isEnv && !file.isScript) return [];
    if (!file.source.includes('NEXT_PUBLIC_')) return [];
    const out: Finding[] = [];
    const seen = new Set<string>();
    file.lines.forEach((l, i) => {
      // skip the obvious "public" anon key for supabase (not a secret)
      for (const m of l.matchAll(SECRET_RE)) {
        const name = m[0];
        if (/ANON/i.test(name) || /PUBLISHABLE/i.test(name)) continue;
        const key = `${i}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(finding(this, file, i + 1, m.index + 1, `\`${name}\` is exposed to the browser because of the NEXT_PUBLIC_ prefix.`, `drop the NEXT_PUBLIC_ prefix and read it only in server code (\`${name.replace(/^NEXT_PUBLIC_/, '')}\`)`));
      }
    });
    return out;
  },
};

// 12 --------------------------------------------------------------------------
export const legacyImportPaths: Rule = {
  id: 'next/legacy-import-paths',
  title: 'Legacy Next import paths in the App Router',
  severity: 'warn',
  requires: 'next >= 13',
  docs: 'https://nextjs.org/docs/app/api-reference/functions/use-router',
  appliesWhen: (ctx) => nextGte(ctx, 13),
  instruction: () => 'Inside `app/`, import `useRouter`/`usePathname`/`useSearchParams` from `next/navigation` (not `next/router`), use the `metadata` export instead of `next/head`, and `next/image` instead of `next/legacy/image`.',
  check(file, ctx) {
    const sf = file.ast;
    if (!sf) return [];
    const out: Finding[] = [];
    const inApp = inAppDir(file, ctx);
    for (const imp of collectImports(sf)) {
      if (imp.specifier === 'next/legacy/image') {
        out.push(findingAt(this, file, imp.node, '`next/legacy/image` is the Next 12 component kept for migration.', "import Image from 'next/image'"));
      } else if (inApp && imp.specifier === 'next/router') {
        out.push(findingAt(this, file, imp.node, '`next/router` does not work in the App Router (throws "NextRouter was not mounted").', "import { useRouter, usePathname, useSearchParams } from 'next/navigation'"));
      } else if (inApp && imp.specifier === 'next/head') {
        out.push(findingAt(this, file, imp.node, '`next/head` is a no-op in the App Router.', 'export `metadata` / `generateMetadata` from the page or layout instead'));
      }
    }
    return out;
  },
};

// 13 --------------------------------------------------------------------------
export const useFormState: Rule = {
  id: 'next/use-form-state',
  title: '`useFormState` → `useActionState` (React 19)',
  severity: 'warn',
  requires: 'react >= 19',
  docs: 'https://react.dev/reference/react/useActionState',
  appliesWhen: (ctx) => gte(ctx.versions.react?.version, 19),
  instruction: (ctx) => `React ${short(ctx.versions.react?.version)} is installed: use \`useActionState\` from \`react\`, not \`useFormState\` from \`react-dom\`.`,
  check(file) {
    const sf = file.ast;
    if (!sf || !file.source.includes('useFormState')) return [];
    const out: Finding[] = [];
    for (const imp of collectImports(sf)) {
      if (imp.specifier === 'react-dom' && imp.names.includes('useFormState')) {
        out.push(findingAt(this, file, imp.node, '`useFormState` from react-dom is deprecated in React 19.', "import { useActionState } from 'react' (same signature, plus an `isPending` third return value)"));
      }
    }
    return out;
  },
};

export const nextRules: Rule[] = [
  syncDynamicApis,
  syncParams,
  middlewareFile,
  revalidateTagSignature,
  removedExperimentalFlags,
  pagesApisInAppDir,
  useClientRootLayout,
  fetchInEffect,
  edgeRuntimeNodeClient,
  removedNextLint,
  publicEnvSecret,
  legacyImportPaths,
  useFormState,
];

// re-export helpers used by tests
export { calleeText, posOf, NEXT_DOCS };
