import path from 'node:path';
import ts from 'typescript';
import type { Confidence, FileInfo, Finding, ProjectContext, Rule, Severity } from './types.js';

const SCRIPT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function createFileInfo(absPath: string, source: string, cwd: string): FileInfo {
  const ext = path.extname(absPath).toLowerCase();
  const isScript = SCRIPT_EXT.has(ext);
  const isCss = ext === '.css' || ext === '.scss' || ext === '.pcss';
  let ast: ts.SourceFile | null | undefined;
  let lines: string[] | undefined;
  const rel = toPosix(path.relative(cwd, absPath)) || path.basename(absPath);
  return {
    path: absPath,
    rel,
    source,
    isScript,
    isCss,
    get ast() {
      if (ast === undefined) {
        if (!isScript) ast = null;
        else {
          const kind =
            ext === '.tsx' ? ts.ScriptKind.TSX
            : ext === '.jsx' ? ts.ScriptKind.JSX
            : ext === '.js' || ext === '.mjs' || ext === '.cjs' ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
          try {
            ast = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, kind);
          } catch {
            ast = null;
          }
        }
      }
      return ast;
    },
    get lines() {
      if (!lines) lines = source.split(/\r?\n/);
      return lines;
    },
  };
}

// ---------- AST helpers ----------

export function posOf(sf: ts.SourceFile, node: ts.Node): { line: number; col: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, col: character + 1 };
}

export function walk(node: ts.Node, visit: (n: ts.Node) => void | boolean): void {
  const stop = visit(node);
  if (stop === true) return;
  node.forEachChild((c) => walk(c, visit));
}

export function finding(
  rule: Rule,
  file: FileInfo,
  line: number,
  col: number,
  message: string,
  fix: string,
  opts: { confidence?: Confidence; severity?: Severity } = {},
): Finding {
  return {
    ruleId: rule.id,
    severity: opts.severity ?? rule.severity,
    file: file.rel,
    line,
    col,
    message,
    fix,
    confidence: opts.confidence ?? 'high',
  };
}

export function findingAt(rule: Rule, file: FileInfo, node: ts.Node, message: string, fix: string, opts?: { confidence?: Confidence; severity?: Severity }): Finding {
  const sf = file.ast!;
  const { line, col } = posOf(sf, node);
  return finding(rule, file, line, col, message, fix, opts);
}

/** Returns callee name for `foo()` / `ns.foo()` call expressions. */
export function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

export function calleeText(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    return `${ts.isIdentifier(e.expression) ? e.expression.text : '…'}.${e.name.text}`;
  }
  return e.getText();
}

/** Whether the file starts with a 'use client' directive. */
export function hasUseClient(file: FileInfo): boolean {
  const sf = file.ast;
  if (!sf) return /^\s*(['"])use client\1/m.test(file.source.slice(0, 500));
  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      if (stmt.expression.text === 'use client') return true;
      continue;
    }
    break;
  }
  return false;
}

export interface ImportRecord {
  specifier: string;
  node: ts.Node;
  /** Imported binding names (named imports + default + namespace) */
  names: string[];
}

/** Static imports, `export ... from`, `require()` and dynamic `import()` with string literal specifiers. */
export function collectImports(sf: ts.SourceFile): ImportRecord[] {
  const out: ImportRecord[] = [];
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const names: string[] = [];
      const c = n.importClause;
      if (c) {
        if (c.name) names.push(c.name.text);
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) names.push(c.namedBindings.name.text);
          else for (const el of c.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
        }
      }
      out.push({ specifier: n.moduleSpecifier.text, node: n.moduleSpecifier, names });
      return true;
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ specifier: n.moduleSpecifier.text, node: n.moduleSpecifier, names: [] });
      return true;
    }
    if (ts.isCallExpression(n)) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
          out.push({ specifier: arg.text, node: arg, names: [] });
        } else if (ts.isIdentifier(n.expression) && n.expression.text === 'require') {
          out.push({ specifier: arg.text, node: arg, names: [] });
        }
      }
    }
    return undefined;
  });
  return out;
}

/** Whether a given line has a `drift-guard-ignore-next-line <id>` comment on the line above (or `drift-guard-ignore <id>` on the same line). */
export function isIgnored(file: FileInfo, line: number, ruleId: string): boolean {
  const lines = file.lines;
  const prev = lines[line - 2] ?? '';
  const cur = lines[line - 1] ?? '';
  const re = /drift-guard-ignore(?:-next-line)?\s*([^\n*]*)/;
  const check = (text: string, nextLineOnly: boolean): boolean => {
    const m = re.exec(text);
    if (!m) return false;
    if (nextLineOnly && !text.includes('ignore-next-line')) return false;
    const ids = (m[1] ?? '')
      .replace(/\*\/.*$/, '')
      .replace(/-->.*$/, '')
      .split(/[\s,]+/)
      .filter(Boolean);
    return ids.length === 0 || ids.includes(ruleId);
  };
  return check(prev, true) || (check(cur, false) && !cur.includes('ignore-next-line'));
}

/** Project-relative path helpers. */
export function inAppDir(file: FileInfo, ctx: ProjectContext): boolean {
  const rel = file.rel;
  if (ctx.appDirPath && (rel === ctx.appDirPath || rel.startsWith(ctx.appDirPath + '/'))) return true;
  return rel.startsWith('app/') || rel.startsWith('src/app/');
}

export function baseNameNoExt(rel: string): string {
  const b = rel.split('/').pop() ?? rel;
  return b.replace(/\.[^.]+$/, '');
}
