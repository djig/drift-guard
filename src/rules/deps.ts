import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import type { Finding, ProjectContext, Rule } from '../types.js';
import { collectImports, findingAt } from '../file.js';

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Packages that are virtual / provided by frameworks and never need to be declared. */
const VIRTUAL_ROOTS = new Set(['next', 'react', 'react-dom', 'server-only', 'client-only', 'typescript', 'bun', 'deno', 'virtual', 'astro', 'vite', '$app', '$lib', '$env', '@sveltejs', 'svelte', 'expo', 'expo-router', '@next']);

/** Return the root package name for an import specifier: `@scope/name/sub` → `@scope/name`, `lodash/fp` → `lodash`. */
export function rootPackage(spec: string): string {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split('/')[0] ?? spec;
}

export function isBareSpecifier(spec: string): boolean {
  if (!spec) return false;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return false;
  if (/^[a-zA-Z]+:/.test(spec)) return false; // node:, data:, http:, virtual:, bun:
  return true;
}

export function isPathAlias(spec: string, ctx: ProjectContext): boolean {
  if (spec.startsWith('~') || spec.startsWith('@/') || spec === '@') return true;
  for (const alias of ctx.pathAliases) {
    if (spec === alias || spec.startsWith(alias.endsWith('/') ? alias : alias + '/')) return true;
  }
  return false;
}

const nmCache = new Map<string, boolean>();
function inNodeModules(ctx: ProjectContext, root: string): boolean {
  const key = `${ctx.cwd}::${root}`;
  const cached = nmCache.get(key);
  if (cached !== undefined) return cached;
  let found = false;
  // walk up: monorepo roots hoist packages
  let dir = ctx.cwd;
  for (let i = 0; i < 6 && !found; i++) {
    try {
      fs.accessSync(path.join(dir, 'node_modules', root));
      found = true;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  nmCache.set(key, found);
  return found;
}

export function _resetNodeModulesCache(): void {
  nmCache.clear();
}

// 23 --------------------------------------------------------------------------
export const unknownPackage: Rule = {
  id: 'deps/unknown-package',
  title: 'Import of a package that is not declared or installed',
  severity: 'error',
  requires: 'package.json present',
  docs: 'https://github.com/djig/drift-guard#depsunknown-package',
  appliesWhen: (ctx) => ctx.packageJson !== null,
  instruction: () => 'Only import packages that are declared in package.json; if you need a new one, verify it exists on npm and install it explicitly — never assume a package from memory exists.',
  check(file, ctx) {
    const sf = file.ast;
    if (!sf) return [];
    const out: Finding[] = [];
    const seen = new Set<string>();
    for (const imp of collectImports(sf)) {
      const spec = imp.specifier;
      if (!isBareSpecifier(spec) || BUILTINS.has(spec) || isPathAlias(spec, ctx)) continue;
      const root = rootPackage(spec);
      if (seen.has(root)) continue;
      if (VIRTUAL_ROOTS.has(root) || root.startsWith('@types/')) continue;
      if (ctx.declaredDeps.has(root)) continue;
      if (ctx.hasNodeModules && inNodeModules(ctx, root)) continue;
      // Type-only imports of @types-style packages resolve via node_modules only; still flag if truly absent.
      seen.add(root);
      out.push(findingAt(this, file, imp.node, `\`${root}\` is not in package.json and not in node_modules — possibly a hallucinated package.`, `verify \`${root}\` exists on npm (\`npm view ${root}\`) before installing; if it is a local module, fix the path or tsconfig alias`));
    }
    return out;
  },
};

export const depsRules: Rule[] = [unknownPackage];
