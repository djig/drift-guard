import type ts from 'typescript';

export type Severity = 'error' | 'warn' | 'info';
export type Confidence = 'high' | 'medium';

export interface Finding {
  ruleId: string;
  severity: Severity;
  file: string;
  /** 1-based line */
  line: number;
  /** 1-based column */
  col: number;
  message: string;
  /** One-line human fix hint. */
  fix: string;
  confidence: Confidence;
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export type VersionSource = 'lockfile' | 'node_modules' | 'package.json' | 'none';

export interface DetectedVersion {
  version: SemVer;
  source: VersionSource;
}

export interface ProjectContext {
  cwd: string;
  packageJson: Record<string, unknown> | null;
  /** All declared deps (dependencies + devDependencies + peerDependencies). */
  declaredDeps: Set<string>;
  versions: {
    next?: DetectedVersion;
    react?: DetectedVersion;
    'react-dom'?: DetectedVersion;
    tailwindcss?: DetectedVersion;
    typescript?: DetectedVersion;
  };
  /** `babel-plugin-react-compiler` declared or `reactCompiler: true` in next.config. */
  reactCompiler: boolean;
  /** App router detected (`app/` or `src/app/`). */
  appDir: boolean;
  /** Directory of the app router relative to cwd (e.g. "app" or "src/app"), if any. */
  appDirPath: string | null;
  /** Pages router detected (`pages/` or `src/pages/`). */
  pagesDir: boolean;
  /** Project uses a `src/` prefix. */
  srcDir: boolean;
  /** tsconfig `paths` keys, with trailing `/*` stripped (e.g. "@", "~"). */
  pathAliases: string[];
  /** Whether a node_modules directory exists. */
  hasNodeModules: boolean;
  /** Lockfile kind found, if any. */
  lockfile: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  /** Whether any `.css` file contains an `@config` directive (lazy; computed by engine). */
  cssHasConfigDirective?: boolean;
}

export interface FileInfo {
  /** Absolute path. */
  path: string;
  /** Path relative to cwd, posix separators. */
  rel: string;
  source: string;
  /** Lazily parsed TypeScript AST for JS/TS/JSX/TSX files; null for other files. */
  readonly ast: ts.SourceFile | null;
  /** Whether this is a JS/TS source file. */
  isScript: boolean;
  isCss: boolean;
  /** Lines of the file (lazy). */
  readonly lines: string[];
}

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  docs: string;
  /** Short reason string for `drift-guard rules` output. */
  appliesWhen(ctx: ProjectContext): boolean;
  /** Human readable precondition for listing (e.g. "next >= 15"). */
  requires: string;
  /** One imperative line for generated agent instructions; null if not worth stating. */
  instruction(ctx: ProjectContext): string | null;
  /** Per-file check. */
  check(file: FileInfo, ctx: ProjectContext): Finding[];
  /** Optional project-level check run once against the whole file set. */
  checkProject?(files: FileInfo[], ctx: ProjectContext): Finding[];
}

export interface DriftGuardConfig {
  ignore?: string[];
  severity?: Record<string, Severity>;
  exclude?: string[];
}

export interface Report {
  cwd: string;
  findings: Finding[];
  filesChecked: number;
  rulesApplied: string[];
  context: ProjectContext;
  durationMs: number;
}
