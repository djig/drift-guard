import ts from 'typescript';
import { gte, short } from '../semver.js';
import type { FileInfo, Finding, ProjectContext, Rule } from '../types.js';
import { finding, walk } from '../file.js';

function twGte4(ctx: ProjectContext): boolean {
  return gte(ctx.versions.tailwindcss?.version, 4);
}
function twV(ctx: ProjectContext): string {
  return short(ctx.versions.tailwindcss?.version);
}

// ---------- class string extraction ----------

export interface ClassToken {
  token: string;
  line: number;
  col: number;
}

const CLASS_FN = /^(cn|clsx|cva|cx|classNames|twMerge|twJoin|tv)$/;

/** Yield class tokens found in className/class attributes, cn()/clsx()/cva() args, and @apply lines. */
export function extractClassTokens(file: FileInfo): ClassToken[] {
  const out: ClassToken[] = [];
  const pushString = (text: string, startPos: number, sf: ts.SourceFile): void => {
    // iterate tokens with their offsets
    const re = /\S+/g;
    for (const m of text.matchAll(re)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(startPos + m.index);
      out.push({ token: m[0], line: line + 1, col: character + 1 });
    }
  };

  if (file.isCss) {
    file.lines.forEach((l, i) => {
      const m = /@apply\s+([^;{}]+)/.exec(l);
      if (!m) return;
      const base = m.index + m[0].indexOf(m[1]!);
      for (const t of m[1]!.matchAll(/\S+/g)) out.push({ token: t[0], line: i + 1, col: base + t.index + 1 });
    });
    return out;
  }

  const sf = file.ast;
  if (!sf) return out;

  const inClassContext = (node: ts.Node): boolean => {
    let cur: ts.Node | undefined = node.parent;
    let depth = 0;
    while (cur && depth < 8) {
      if (ts.isJsxAttribute(cur)) {
        const name = ts.isIdentifier(cur.name) ? cur.name.text : cur.name.getText();
        return name === 'className' || name === 'class';
      }
      if (ts.isCallExpression(cur)) {
        const e = cur.expression;
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
        if (CLASS_FN.test(name)) return true;
        return false;
      }
      if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && /class/i.test(cur.name.text)) return true;
      if (ts.isPropertyAssignment(cur) && (ts.isIdentifier(cur.name) || ts.isStringLiteral(cur.name)) && /^(class|className|variants|base|defaultVariants)$/.test(cur.name.text)) return true;
      // keep climbing through ternaries, arrays, objects, template spans, parens
      if (ts.isConditionalExpression(cur) || ts.isArrayLiteralExpression(cur) || ts.isObjectLiteralExpression(cur) || ts.isTemplateSpan(cur) || ts.isTemplateExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isJsxExpression(cur) || ts.isBinaryExpression(cur) || ts.isPropertyAssignment(cur)) {
        cur = cur.parent;
        depth++;
        continue;
      }
      return false;
    }
    return false;
  };

  walk(sf, (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (inClassContext(n)) pushString(n.text, n.getStart(sf) + 1, sf);
    } else if (ts.isTemplateExpression(n) && inClassContext(n)) {
      pushString(n.head.text, n.head.getStart(sf) + 1, sf);
      for (const span of n.templateSpans) {
        // literal.getStart() points at the `}`; text starts after it
        pushString(span.literal.text, span.literal.getStart(sf) + 1, sf);
      }
      return true;
    }
    return undefined;
  });
  return out;
}

/** Split `md:hover:bg-red-500` into prefix (`md:hover:`) and utility (`bg-red-500`). Handles arbitrary variants with brackets. */
export function splitVariants(token: string): { prefix: string; util: string } {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) lastColon = i;
  }
  return lastColon === -1 ? { prefix: '', util: token } : { prefix: token.slice(0, lastColon + 1), util: token.slice(lastColon + 1) };
}

// 18 --------------------------------------------------------------------------
export const v3Directives: Rule = {
  id: 'tailwind/v3-directives',
  title: '`@tailwind` directives in Tailwind v4',
  severity: 'error',
  requires: 'tailwindcss >= 4',
  docs: 'https://tailwindcss.com/docs/upgrade-guide#using-postcss',
  appliesWhen: twGte4,
  instruction: (ctx) => `Tailwind ${twV(ctx)} is installed: CSS entry files use \`@import "tailwindcss";\` — never \`@tailwind base/components/utilities\`.`,
  check(file) {
    if (!file.isCss) return [];
    const out: Finding[] = [];
    file.lines.forEach((l, i) => {
      const m = /@tailwind\s+(base|components|utilities|variants|screens)/.exec(l);
      if (m) out.push(finding(this, file, i + 1, m.index + 1, `\`@tailwind ${m[1]}\` is a Tailwind v3 directive; v4 ignores it and emits no utilities.`, 'replace all @tailwind lines with a single `@import "tailwindcss";`'));
    });
    return out;
  },
};

// 19 --------------------------------------------------------------------------
export const legacyConfigFile: Rule = {
  id: 'tailwind/legacy-config-file',
  title: '`tailwind.config.*` without `@config` in Tailwind v4',
  severity: 'warn',
  requires: 'tailwindcss >= 4',
  docs: 'https://tailwindcss.com/docs/upgrade-guide#using-a-javascript-config-file',
  appliesWhen: twGte4,
  instruction: (ctx) => `Tailwind ${twV(ctx)} is installed: configuration is CSS-first (\`@theme { --color-brand: … }\` in the CSS entry) — do not create or extend \`tailwind.config.js\` unless the CSS has an \`@config\` directive.`,
  check() {
    return [];
  },
  checkProject(files, ctx) {
    const cfg = files.find((f) => /^tailwind\.config\.(js|ts|cjs|mjs|mts|cts)$/.test(f.rel));
    if (!cfg) return [];
    const hasConfigDirective = ctx.cssHasConfigDirective ?? files.some((f) => f.isCss && /@config\s+['"]/.test(f.source));
    if (hasConfigDirective) return [];
    return [finding(this, cfg, 1, 1, `\`${cfg.rel}\` exists but no CSS file loads it with \`@config\`; Tailwind v4 ignores it entirely.`, 'move theme tokens into `@theme { … }` in your CSS, or add `@config "./tailwind.config.js";` to keep it', { confidence: 'medium' })];
  },
};

// 20 --------------------------------------------------------------------------
export type RenameKind = 'resized' | 'removed' | 'changed';

/** utility (exact match) → [replacement, kind] */
export const RENAMED_EXACT: Record<string, [string, RenameKind]> = {
  'shadow-sm': ['shadow-xs', 'resized'],
  shadow: ['shadow-sm', 'resized'],
  'drop-shadow-sm': ['drop-shadow-xs', 'resized'],
  'drop-shadow': ['drop-shadow-sm', 'resized'],
  'rounded-sm': ['rounded-xs', 'resized'],
  rounded: ['rounded-sm', 'resized'],
  'blur-sm': ['blur-xs', 'resized'],
  blur: ['blur-sm', 'resized'],
  'backdrop-blur-sm': ['backdrop-blur-xs', 'resized'],
  'backdrop-blur': ['backdrop-blur-sm', 'resized'],
  ring: ['ring-3', 'resized'],
  'outline-none': ['outline-hidden', 'changed'],
  'overflow-ellipsis': ['text-ellipsis', 'removed'],
  'decoration-slice': ['box-decoration-slice', 'removed'],
  'decoration-clone': ['box-decoration-clone', 'removed'],
  'flex-shrink': ['shrink', 'removed'],
  'flex-grow': ['grow', 'removed'],
};

/** prefix-based renames: [regex, replacer] — all are removed in v4 */
export const RENAMED_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^(bg|text|border|divide|ring|placeholder)-opacity-(\d+)$/, (m) => `${m[1]}-<color>/${m[2]}`],
  [/^bg-gradient-to-(t|tr|r|br|b|bl|l|tl)$/, (m) => `bg-linear-to-${m[1]}`],
  [/^flex-shrink-(\d+)$/, (m) => `shrink-${m[1]}`],
  [/^flex-grow-(\d+)$/, (m) => `grow-${m[1]}`],
];

const KIND_TEXT: Record<RenameKind, string> = {
  resized: 'in v4 it still exists but renders a different (larger) size',
  removed: 'in v4 it does not exist and produces no CSS',
  changed: 'in v4 it exists with different behaviour (`outline-none` now really sets outline-style: none)',
};

export function renamedUtility(util: string): { to: string; kind: RenameKind; note: string } | null {
  const exact = RENAMED_EXACT[util];
  if (exact) return { to: exact[0], kind: exact[1], note: KIND_TEXT[exact[1]] };
  for (const [re, rep] of RENAMED_PATTERNS) {
    const m = re.exec(util);
    if (m) return { to: rep(m), kind: 'removed', note: KIND_TEXT.removed };
  }
  return null;
}

/** Tokens that only exist in Tailwind v4 — their presence means the author is writing v4. */
const V4_ONLY_IDIOM = /^(shadow-xs|rounded-xs|blur-xs|drop-shadow-xs|backdrop-blur-xs|outline-hidden|ring-3|bg-linear-to-[a-z]+|bg-radial|bg-conic|inset-shadow-.*|text-shadow-.*|[a-z-]+-\(--[a-zA-Z0-9_-]+\)|[a-z-]+!)$/;

export const renamedUtilities: Rule = {
  id: 'tailwind/renamed-utilities',
  title: 'Tailwind v3 utility names that changed in v4',
  severity: 'warn',
  requires: 'tailwindcss >= 4',
  docs: 'https://tailwindcss.com/docs/upgrade-guide#renamed-utilities',
  appliesWhen: twGte4,
  instruction: (ctx) => `Tailwind ${twV(ctx)} is installed: v3 names changed — \`shadow-sm\`→\`shadow-xs\`, \`shadow\`→\`shadow-sm\`, \`rounded-sm\`→\`rounded-xs\`, \`rounded\`→\`rounded-sm\`, \`outline-none\`→\`outline-hidden\`, \`ring\`→\`ring-3\`, \`bg-gradient-to-r\`→\`bg-linear-to-r\`, \`bg-opacity-50\`→\`bg-black/50\`, \`flex-shrink-0\`→\`shrink-0\`.`,
  check(file) {
    if (!file.isScript && !file.isCss) return [];
    const out: Finding[] = [];
    const tokens = extractClassTokens(file);
    // If the file already uses v4-only idioms, `shadow-sm` / `rounded-sm` etc. are most likely intentional v4 sizes.
    const authorKnowsV4 = tokens.some((t) => V4_ONLY_IDIOM.test(splitVariants(t.token).util));
    for (const t of tokens) {
      const neg = t.token.startsWith('-');
      const { prefix, util } = splitVariants(neg ? t.token.slice(1) : t.token);
      const bang = util.startsWith('!');
      const core = bang ? util.slice(1) : util;
      const r = renamedUtility(core);
      if (!r) continue;
      if (r.kind === 'resized' && authorKnowsV4) continue;
      out.push(finding(this, file, t.line, t.col, `\`${t.token}\` is Tailwind v3 naming; ${r.note}.`, `use \`${prefix}${r.to}\``, { confidence: r.kind === 'removed' ? 'high' : 'medium' }));
    }
    return out;
  },
};

// 21 --------------------------------------------------------------------------
export const importantPrefix: Rule = {
  id: 'tailwind/important-prefix',
  title: 'Leading `!important` prefix moved to suffix in v4',
  severity: 'warn',
  requires: 'tailwindcss >= 4',
  docs: 'https://tailwindcss.com/docs/upgrade-guide#important-modifier',
  appliesWhen: twGte4,
  instruction: (ctx) => `Tailwind ${twV(ctx)} is installed: the important modifier is a suffix — write \`flex!\`, not \`!flex\`.`,
  check(file) {
    if (!file.isScript && !file.isCss) return [];
    const out: Finding[] = [];
    for (const t of extractClassTokens(file)) {
      const { prefix, util } = splitVariants(t.token);
      if (util.startsWith('!') && util.length > 1 && /^[a-z-]/.test(util.slice(1))) {
        out.push(finding(this, file, t.line, t.col, `\`${t.token}\` uses the v3 leading \`!\` important syntax.`, `use \`${prefix}${util.slice(1)}!\``));
      }
    }
    return out;
  },
};

// 22 --------------------------------------------------------------------------
export const cssVarArbitrary: Rule = {
  id: 'tailwind/css-var-arbitrary',
  title: 'v3 arbitrary-value syntax for CSS variables / commas',
  severity: 'warn',
  requires: 'tailwindcss >= 4',
  docs: 'https://tailwindcss.com/docs/upgrade-guide#variables-in-arbitrary-values',
  appliesWhen: twGte4,
  instruction: (ctx) => `Tailwind ${twV(ctx)} is installed: CSS variables in arbitrary values use parentheses — \`bg-(--brand)\` not \`bg-[--brand]\` — and commas in arbitrary values must be underscores: \`grid-cols-[1fr_2fr]\`.`,
  check(file) {
    if (!file.isScript && !file.isCss) return [];
    const out: Finding[] = [];
    for (const t of extractClassTokens(file)) {
      const { prefix, util } = splitVariants(t.token);
      const varM = /^([a-z][a-z0-9-]*)-\[(--[a-zA-Z0-9_-]+)\]$/.exec(util);
      if (varM) {
        out.push(finding(this, file, t.line, t.col, `\`${t.token}\` uses v3 square-bracket syntax for a CSS variable; v4 treats it as a literal value.`, `use \`${prefix}${varM[1]}-(${varM[2]})\``));
        continue;
      }
      const arbM = /^([a-z][a-z0-9-]*)-\[([^\]]*)\]$/.exec(util);
      if (arbM && arbM[2]!.includes(',') && !/\(/.test(arbM[2]!) && /^(grid-cols|grid-rows|grid-template-columns|grid-template-rows|font|shadow|transition|bg|animate)$/.test(arbM[1]!)) {
        out.push(finding(this, file, t.line, t.col, `\`${t.token}\` has commas inside an arbitrary value; v4 requires underscores as separators.`, `use \`${prefix}${arbM[1]}-[${arbM[2]!.replace(/,\s*/g, '_')}]\``, { confidence: 'medium' }));
      }
    }
    return out;
  },
};

export const tailwindRules: Rule[] = [v3Directives, legacyConfigFile, renamedUtilities, importantPrefix, cssVarArbitrary];
