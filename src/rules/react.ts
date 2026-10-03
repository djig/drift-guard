import ts from 'typescript';
import { gte, short } from '../semver.js';
import type { Finding, ProjectContext, Rule } from '../types.js';
import { calleeName, collectImports, findingAt, walk } from '../file.js';

function reactGte(ctx: ProjectContext, major: number): boolean {
  return gte(ctx.versions.react?.version, major);
}

// 14 --------------------------------------------------------------------------
export const forwardRef: Rule = {
  id: 'react/forward-ref',
  title: '`forwardRef` is unnecessary in React 19',
  severity: 'info',
  requires: 'react >= 19',
  docs: 'https://react.dev/blog/2024/12/05/react-19#ref-as-a-prop',
  appliesWhen: (ctx) => reactGte(ctx, 19),
  instruction: (ctx) => `React ${short(ctx.versions.react?.version)} is installed: \`ref\` is a regular prop on function components — do not wrap new components in \`forwardRef\`.`,
  check(file) {
    const sf = file.ast;
    if (!sf || !file.source.includes('forwardRef')) return [];
    const out: Finding[] = [];
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && calleeName(n) === 'forwardRef') {
        out.push(findingAt(this, file, n, '`forwardRef` is a React 18 pattern; in React 19 `ref` is passed as a normal prop.', 'accept `{ ref, ...props }` directly in the function component (forwardRef still works but will be deprecated)'));
      }
    });
    return out;
  },
};

// 15 --------------------------------------------------------------------------
export const removedApis: Rule = {
  id: 'react/removed-apis',
  title: 'APIs removed in React 19',
  severity: 'error',
  requires: 'react >= 19',
  docs: 'https://react.dev/blog/2024/04/25/react-19-upgrade-guide#removed-apis',
  appliesWhen: (ctx) => reactGte(ctx, 19),
  instruction: (ctx) => `React ${short(ctx.versions.react?.version)} is installed: \`ReactDOM.render\`, \`hydrate\`, \`unmountComponentAtNode\`, \`findDOMNode\`, \`createFactory\`, string refs, \`propTypes\` and \`defaultProps\` on function components are removed — use \`createRoot\`/\`hydrateRoot\`, default parameters and TypeScript types.`,
  check(file) {
    const sf = file.ast;
    if (!sf) return [];
    const out: Finding[] = [];
    const src = file.source;
    if (!/render\(|hydrate\(|defaultProps|propTypes|createFactory|unmountComponentAtNode|findDOMNode|ref=["']/.test(src)) return [];

    const imports = collectImports(sf);
    const reactDomNs = new Set<string>();
    const reactDomNamed = new Set<string>();
    for (const i of imports) {
      if (i.specifier === 'react-dom') {
        for (const n of i.names) {
          if (/^(render|hydrate|unmountComponentAtNode|findDOMNode)$/.test(n)) reactDomNamed.add(n);
          else reactDomNs.add(n); // default / namespace import name
        }
      }
    }
    // also treat the conventional `ReactDOM` identifier as the namespace even without import (e.g. UMD)
    reactDomNs.add('ReactDOM');

    const functionComponents = new Set<string>();
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && /^[A-Z]/.test(st.name.text)) functionComponents.add(st.name.text);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && /^[A-Z]/.test(d.name.text) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) functionComponents.add(d.name.text);
        }
      }
    }

    walk(sf, (n) => {
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
          const ns = e.expression.text;
          const m = e.name.text;
          if (reactDomNs.has(ns) && /^(render|hydrate|unmountComponentAtNode|findDOMNode)$/.test(m)) {
            out.push(findingAt(this, file, n, `\`${ns}.${m}\` was removed in React 19.`, m === 'render' ? "createRoot(container).render(<App />) from 'react-dom/client'" : m === 'hydrate' ? "hydrateRoot(container, <App />) from 'react-dom/client'" : m === 'unmountComponentAtNode' ? 'root.unmount()' : 'use a ref instead of findDOMNode'));
          }
          if ((ns === 'React') && m === 'createFactory') {
            out.push(findingAt(this, file, n, '`React.createFactory` was removed in React 19.', 'use JSX'));
          }
        } else if (ts.isIdentifier(e) && reactDomNamed.has(e.text)) {
          out.push(findingAt(this, file, n, `\`${e.text}\` from react-dom was removed in React 19.`, e.text === 'render' ? "createRoot(container).render(<App />) from 'react-dom/client'" : e.text === 'hydrate' ? "hydrateRoot(container, <App />) from 'react-dom/client'" : 'use createRoot / refs'));
        }
      }
      // Component.defaultProps = ... / Component.propTypes = ...
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && ts.isIdentifier(n.left.expression)) {
        const target = n.left.expression.text;
        const prop = n.left.name.text;
        if (prop === 'defaultProps' && functionComponents.has(target)) {
          out.push(findingAt(this, file, n.left, `\`${target}.defaultProps\` is ignored on function components in React 19.`, 'use ES default parameter values: `function X({ size = "md" })`'));
        } else if (prop === 'propTypes') {
          out.push(findingAt(this, file, n.left, `\`${target}.propTypes\` is silently ignored in React 19.`, 'remove propTypes; rely on TypeScript types'));
        }
      }
      // string refs: ref="foo"
      if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && n.name.text === 'ref' && n.initializer && ts.isStringLiteral(n.initializer)) {
        out.push(findingAt(this, file, n, 'String refs were removed in React 19.', 'use `useRef()` / a callback ref'));
      }
    });
    return out;
  },
};

// 16 --------------------------------------------------------------------------
export const manualMemoWithCompiler: Rule = {
  id: 'react/manual-memo-with-compiler',
  title: 'Manual memoization while React Compiler is enabled',
  severity: 'info',
  requires: 'React Compiler detected',
  docs: 'https://react.dev/learn/react-compiler',
  appliesWhen: (ctx) => ctx.reactCompiler,
  instruction: () => 'The React Compiler is enabled in this project: do not add `useMemo`, `useCallback` or `React.memo` for performance — the compiler memoizes automatically.',
  check(file) {
    const sf = file.ast;
    if (!sf || !/useMemo|useCallback|memo\(/.test(file.source)) return [];
    const out: Finding[] = [];
    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const e = n.expression;
      const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'React' ? e.name.text : null;
      if (name === 'useMemo' || name === 'useCallback' || name === 'memo') {
        out.push(findingAt(this, file, n, `\`${ts.isIdentifier(e) ? name : 'React.' + name}\` is usually redundant with the React Compiler enabled.`, 'remove manual memoization unless profiling shows the compiler bailed out', { confidence: 'medium' }));
      }
    });
    return out;
  },
};

// 17 --------------------------------------------------------------------------
export const indexKey: Rule = {
  id: 'react/index-key',
  title: 'Array index used as `key`',
  severity: 'warn',
  requires: 'react',
  docs: 'https://react.dev/learn/rendering-lists#why-does-react-need-keys',
  appliesWhen: (ctx) => !!ctx.versions.react,
  instruction: () => 'Do not use the array index as a React `key` in `.map()` — use a stable id from the data.',
  check(file) {
    const sf = file.ast;
    if (!sf || !/key=\{/.test(file.source)) return [];
    const out: Finding[] = [];
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || calleeName(n) !== 'map') return;
      const cb = n.arguments[0];
      if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return;
      const idx = cb.parameters[1];
      if (!idx || !ts.isIdentifier(idx.name)) return;
      const idxName = idx.name.text;
      walk(cb.body, (m) => {
        if (ts.isJsxAttribute(m) && ts.isIdentifier(m.name) && m.name.text === 'key' && m.initializer && ts.isJsxExpression(m.initializer) && m.initializer.expression) {
          const ex = m.initializer.expression;
          const usesIndex = ts.isIdentifier(ex) ? ex.text === idxName : ts.isTemplateExpression(ex) ? ex.templateSpans.some((s) => ts.isIdentifier(s.expression) && s.expression.text === idxName) : false;
          if (usesIndex) out.push(findingAt(this, file, m, `Array index \`${idxName}\` is used as the React key.`, 'use a stable identifier from the item (e.g. `key={item.id}`)', { confidence: 'medium' }));
        }
      });
    });
    return out;
  },
};

export const reactRules: Rule[] = [forwardRef, removedApis, manualMemoWithCompiler, indexKey];
