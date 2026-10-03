# drift-guard

**A version-aware gate for training-data drift in agent-written React / Next.js / Tailwind code.**

Coding agents write the React, Next.js and Tailwind they were *trained on*, not the versions you have *installed*. drift-guard reads your lockfile, figures out what is actually installed, and blocks the agent's edit — with a one-line fix — when it uses a pattern that was correct for an older version but is wrong, deprecated, or silently broken for yours.

Deterministic, no LLM, no network, ~100 ms per file. Ships as a Claude Code plugin, a Codex / Cursor hook, a Copilot instructions file, an `AGENTS.md` block, an agent skill, and a plain CLI with SARIF output for CI.

```
$ npx @djignesh21/drift-guard check app/page.tsx

drift-guard · next 16.1.2 · react 19.2.0 · tailwind 4.1.8 · app-router · 22 rules · 1 file

app/page.tsx
  1:16     error `params` is typed as a plain object; in Next 16.1 it is a Promise. next/sync-params
           → fix: type as `params: Promise<{ … }>` and `const { id } = await params`
  4:14     error `params.id` is read synchronously; `params` is a Promise in Next 16.1. next/sync-params
           → fix: type as `params: Promise<{ … }>` and `const { id } = await params`

2 errors
```

## Why

- Agents working from training data alone scored **53%** on Next.js 16 APIs in Vercel's own evals (https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals). Next.js 16's managed `AGENTS.md` block literally opens with *"This is NOT the Next.js you know"* (https://nextjs.org/blog/next-16-3-ai-improvements).
- The failures are **silent**. A stale `middleware.ts` on Next 16 "compiles without issue, passes TypeScript checks, and does absolutely nothing at runtime" (https://squaredtech.co/nextjs-16-upgrade-broke-4-things-no-errors-no-warnings). Treating `params` as a plain object on Next 15+ "compiles but crashes at runtime" — one of the 22 `.mdc` rules Cursor users wrote just to stop the most common Next 15 hallucinations (https://forum.cursor.com/t/22-mdc-rules-that-prevent-the-most-common-next-js-15-hallucinations/156397).
- Tailwind v4 shipped in 2025; "AI coding assistants are trained on Tailwind v3 data" (https://github.com/ofershap/tailwind-best-practices). `@tailwind base` emits nothing, `shadow-sm` renders a different size, `bg-opacity-50` produces no CSS.
- Hallucinated packages are a supply-chain vector: the non-existent `react-codeshift` spread to **237 repos** from LLM-generated skills before anyone registered it (https://www.aikido.dev/blog/slopsquatting-ai-package-hallucination-attacks), and 19.7% of LLM code samples reference at least one package that does not exist (USENIX Security '25, via https://labs.cloudsecurityalliance.org/research/csa-research-note-slopsquatting-ai-supply-chain-20260419-csa/).

Linters catch *bad* code. drift-guard catches *good code for the wrong version* — which is exactly what an agent with a stale world model produces, and exactly what existing tools wave through.

## Install

### Claude Code (plugin)

```sh
claude plugin marketplace add djig/drift-guard
claude plugin install drift-guard@djig-plugins
```

That registers a `PostToolUse` hook on `Edit|Write|MultiEdit` plus the `drift-guard` skill. Nothing else to configure.

### Any agent (one-liner)

```sh
npx @djignesh21/drift-guard init --agent all      # or: claude | codex | cursor | copilot
```

`init` detects your versions and writes:

| Agent | Files written |
| --- | --- |
| Claude Code | `.claude/settings.json` → `hooks.PostToolUse` entry (merged into existing JSON) |
| Codex | `.codex/hooks.json` (same shape, `--agent codex`) |
| Cursor | `.cursor/hooks.json` (`afterFileEdit`) + `.cursor/rules/drift-guard.mdc` (generated, version-specific) |
| Copilot | `.github/instructions/drift-guard.instructions.md` (generated, `applyTo: **/*.ts,**/*.tsx,**/*.css`) |
| all | `AGENTS.md` managed block `<!-- BEGIN:drift-guard -->…<!-- END:drift-guard -->` (upserted, never clobbers your notes) |

Add `--skill` to copy the agent skill into `.agents/skills/drift-guard/`. Existing files are never overwritten unless you pass `--yes`; JSON files are merged.

### CLI only

```sh
npm i -D @djignesh21/drift-guard
npx drift-guard check            # whole project, exit 1 on any error
npx drift-guard check src/a.tsx  # specific files
npx drift-guard rules            # which rules apply here and why
```

## How the hook blocks an edit

After every `Edit` / `Write` / `MultiEdit`, the hook runs `check` on just the touched files. If anything is `error` severity, the agent receives:

```json
{
  "decision": "block",
  "reason": "drift-guard: the edit uses patterns from an older framework version than the one installed. Fix these before continuing:\napp/page.tsx:1 [error] `params` is typed as a plain object; in Next 16.1 it is a Promise. Fix: type as `params: Promise<{ … }>` and `const { id } = await params` (next/sync-params)\napp/page.tsx:4 [error] `params.id` is read synchronously; `params` is a Promise in Next 16.1. Fix: type as `params: Promise<{ … }>` and `const { id } = await params` (next/sync-params)"
}
```

Up to six findings, one per line, each with `file:line`, the message, the fix and the rule id — enough for the agent to repair the edit in its next turn without re-reading docs. `warn` / `info` findings do not block; they arrive as `hookSpecificOutput.additionalContext` so the agent sees them but keeps going. A clean edit produces no output at all.

Cursor's `afterFileEdit` hook cannot block, so there drift-guard returns `{"agent_message": "…"}` (warn and above) and says so in the message.

The hook never crashes your session: on any internal error it exits 0 with no output (set `DRIFT_GUARD_DEBUG=1` to see why on stderr).

## Rules

Every rule is gated on the detected versions — a rule that does not apply to your project is never run and never appears in generated instructions.

| Rule | Applies when | Severity | Fix |
| --- | --- | --- | --- |
| `next/sync-dynamic-apis` | next ≥ 15 | error | `await cookies()` / `headers()` / `draftMode()` |
| `next/sync-params` | next ≥ 15, app router | error | `params: Promise<…>`, `const { id } = await params` |
| `next/middleware-file` | next ≥ 16 | error | rename `middleware.ts` → `proxy.ts`, export `proxy` |
| `next/revalidate-tag-signature` | next ≥ 16 | warn | `revalidateTag(tag, 'max')` or `updateTag(tag)` |
| `next/removed-experimental-flags` | next ≥ 16 | error | `experimental.ppr`/`dynamicIO` → `cacheComponents: true`; `experimental.turbo` → `turbopack` |
| `next/pages-apis-in-app-dir` | app router | error | drop `getServerSideProps` & co. under `app/`; fetch in the Server Component |
| `next/use-client-root-layout` | next ≥ 13, app router | error (root) / warn (nested) | remove `'use client'` from layouts |
| `next/fetch-in-effect` | next ≥ 13, app router | warn | fetch in a Server Component / Server Action / `use()` |
| `next/edge-runtime-node-client` | next | error | `runtime = 'nodejs'` or an edge driver when importing prisma/pg/mysql2/mongoose/bcrypt/fs |
| `next/removed-next-lint` | next ≥ 16 | error | `next lint` → `eslint .` / `biome check .` |
| `next/public-env-secret` | next | error | no `NEXT_PUBLIC_*SECRET*`, `*TOKEN*`, `*PRIVATE*`, `*API_KEY*`, `*SERVICE_ROLE*` |
| `next/legacy-import-paths` | next ≥ 13 | warn | `next/router` → `next/navigation`, `next/head` → `metadata`, `next/legacy/image` → `next/image` |
| `next/use-form-state` | react ≥ 19 | warn | `useFormState` (react-dom) → `useActionState` (react) |
| `react/forward-ref` | react ≥ 19 | info | `ref` is a regular prop |
| `react/removed-apis` | react ≥ 19 | error | `ReactDOM.render`/`hydrate`/`unmountComponentAtNode`/`findDOMNode`, `createFactory`, string refs, `propTypes`, `defaultProps` on function components |
| `react/manual-memo-with-compiler` | React Compiler detected | info | `useMemo`/`useCallback`/`memo` are usually redundant |
| `react/index-key` | react | warn | use a stable id, not the map index |
| `tailwind/v3-directives` | tailwindcss ≥ 4 | error | `@tailwind base/components/utilities` → `@import "tailwindcss"` |
| `tailwind/legacy-config-file` | tailwindcss ≥ 4 | warn | `tailwind.config.*` without `@config` is ignored; use `@theme` |
| `tailwind/renamed-utilities` | tailwindcss ≥ 4 | warn | `shadow-sm`→`shadow-xs`, `rounded`→`rounded-sm`, `bg-gradient-to-*`→`bg-linear-to-*`, `bg-opacity-50`→`bg-x/50`, `outline-none`→`outline-hidden`, `ring`→`ring-3`, `flex-shrink-*`→`shrink-*`, … |
| `tailwind/important-prefix` | tailwindcss ≥ 4 | warn | `!flex` → `flex!` |
| `tailwind/css-var-arbitrary` | tailwindcss ≥ 4 | warn | `bg-[--x]` → `bg-(--x)`; `grid-cols-[a,b]` → `grid-cols-[a_b]` |
| `deps/unknown-package` | package.json present | error | import of a package absent from `package.json` *and* `node_modules` — verify on npm before installing |

`drift-guard rules` prints this table for *your* project with each rule marked `applies` or `skipped`, and `drift-guard rules --json` includes the generated instruction line per rule.

### Version detection

Order of trust: lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` classic or berry, `bun.lock`) → `node_modules/<pkg>/package.json` → the semver range in `package.json`. `bun.lockb` (binary) falls through to `node_modules`. Also detected: App Router (`app/` or `src/app/`), `src/` layout, tsconfig `paths` aliases (used to resolve imports), `reactCompiler: true` in `next.config.*` or `babel-plugin-react-compiler` in deps.

## Generated instructions

`init` and `agents-md --print` emit one imperative line per *applicable* rule, with the real version number baked in. For a Next 16 / React 19 / Tailwind 4 project:

```md
<!-- BEGIN:drift-guard -->
## Version drift guard (generated by drift-guard — do not edit by hand)

Installed: next 16.1.2, react 19.2.0, tailwindcss 4.1.8, typescript 5.7.3. Your training data may describe older versions; the rules below are what is true for *this* project.

- Next 16.1 is installed: `cookies()`, `headers()` and `draftMode()` from `next/headers` return Promises — always `await` them.
- Next 16.1 is installed: `params` and `searchParams` props in page/layout/route files are Promises — type them as `Promise<...>` and `await` them.
- Next 16.1 is installed: do not create `middleware.ts`; the file is `proxy.ts` exporting a `proxy` function (middleware.ts silently does nothing).
- Next 16.1 is installed: `revalidateTag(tag)` takes a second argument (a cacheLife profile such as `'max'`); for read-your-own-writes use `updateTag(tag)` in Server Actions.
- Next 16.1 is installed: `experimental.ppr`, `experimental.dynamicIO` and `experimental.turbo` no longer exist in next.config — use `cacheComponents: true` and top-level `turbopack`.
- React 19.2 is installed: `ref` is a regular prop on function components — do not wrap new components in `forwardRef`.
- React 19.2 is installed: `ReactDOM.render`, `hydrate`, … are removed — use `createRoot`/`hydrateRoot`, default parameters and TypeScript types.
- Tailwind 4.1 is installed: CSS entry files use `@import "tailwindcss";` — never `@tailwind base/components/utilities`.
- Tailwind 4.1 is installed: the important modifier is a suffix — write `flex!`, not `!flex`.
- Only import packages that are declared in package.json; if you need a new one, verify it exists on npm and install it explicitly — never assume a package from memory exists.
  …

Run `npx drift-guard check <file>` before declaring a change done; fix `error` findings rather than suppressing them.
<!-- END:drift-guard -->
```

A Next 14 Pages Router project gets none of the Promise / proxy / Tailwind 4 lines — the agent is told only what is true for that repo. Re-run `init` after upgrading a dependency and the block is rewritten in place.

## CI

```sh
npx @djignesh21/drift-guard check --sarif > drift-guard.sarif
```

```yaml
# .github/workflows/drift-guard.yml
name: drift-guard
on: [push, pull_request]
permissions:
  contents: read
  security-events: write
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx @djignesh21/drift-guard check --sarif > drift-guard.sarif || true
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: drift-guard.sarif
```

Findings appear in the Security → Code scanning tab and as PR annotations. Without SARIF, plain `npx @djignesh21/drift-guard check` exits 1 on any error-severity finding.

## Configuration

`drift-guard.config.json` at the project root (JSON with comments allowed):

```json
{
  "ignore": ["react/index-key"],
  "severity": { "tailwind/renamed-utilities": "error", "react/forward-ref": "warn" },
  "exclude": ["legacy/**", "**/*.stories.tsx"]
}
```

Inline, for a single occurrence:

```ts
// drift-guard-ignore-next-line next/revalidate-tag-signature
revalidateTag('posts');

const c = headers(); // drift-guard-ignore
```

`node_modules`, `.next`, `dist`, `build`, `.git`, `coverage`, `out` are always skipped.

## How it compares

| | drift-guard | [react-doctor](https://github.com/millionco/react-doctor) | eslint-plugin-next | eslint-plugin-react-hooks |
| --- | --- | --- | --- | --- |
| Finds | code that is *correct for an older version* | bad React in general (perf, a11y, anti-patterns) | Next.js best practices | hook rules, compiler bailouts |
| Version-conditional | yes — rules switch on the lockfile | no | partially (by plugin version) | no |
| Blocks agent edits via hooks | yes (Claude Code, Codex; Cursor advisory) | no | no | no |
| Generates version-specific agent instructions | yes (AGENTS.md, .mdc, Copilot) | no | no | no |
| Hallucinated-package check | yes | no | no | no |
| Type-aware | no (AST + heuristics) | no | no | no |

These are complementary. react-doctor tells you the component is badly written; drift-guard tells you it was written for React 18 and you are on 19. Run both.

## Limitations

- **Heuristic.** No type information and no data flow. `params` that reaches a page through a helper, or a `cookies` identifier that is not the one from `next/headers`, can slip through or be mis-flagged. Confidence is reported per finding (`high` / `medium`); hooks only block on `error` severity and most heuristics with real false-positive risk are `warn`.
- **`tailwind/renamed-utilities` is inherently ambiguous** for the shifted scale (`shadow-sm`, `rounded-sm`, `rounded`, `shadow`, `blur`, `ring` exist in both v3 and v4 with different sizes). drift-guard flags them at `medium` confidence and suppresses them in any file that already uses a v4-only idiom (`shadow-xs`, `bg-linear-to-*`, `outline-hidden`, `ring-3`, `bg-(--var)`, `flex!`). Removed utilities (`bg-opacity-*`, `bg-gradient-to-*`, `flex-shrink-*`) are always `high` confidence.
- **`deps/unknown-package`** cannot know about packages provided by a bundler plugin, a monorepo tool that does not hoist, or a `paths` alias in a tsconfig it cannot see (`extends` chains are not followed). Declare the package or add the alias to the root tsconfig.
- **Class strings** are only read from `className=`/`class=` attributes, `cn()`/`clsx()`/`cva()`/`cx()`/`twMerge()` arguments, variables whose name contains `class`, and `@apply`. Classes built with string concatenation or coming from data are not seen.
- Lockfile parsing is best-effort and regex-based for pnpm/yarn; exotic layouts fall back to `node_modules`, then to the declared range.
- No auto-fix yet.

## Roadmap

- More frameworks: Remix / React Router 7 (loader/action signature drift, `json()` removal), Expo / React Native (new architecture APIs), Vite 6+ / Astro 5 config drift.
- Typed detection via `tsc` for `next/sync-params` and `next/sync-dynamic-apis` (resolve the actual type of `params`).
- Auto-fix (`--fix`) for the mechanical rules: Tailwind renames, `useFormState`, `revalidateTag`, `middleware.ts` → `proxy.ts`.
- Version-aware rule packs loaded from the installed framework itself (so Next 17 can ship its own drift rules).
- `pre-commit` / lint-staged recipe and a GitHub App that comments the fix hint on PRs.

## Development

```sh
npm install
npm run build        # tsc → dist/
npm test             # vitest; fixtures under fixtures/
npm run typecheck
```

Each rule lives in `src/rules/*.ts` as `{ id, title, severity, requires, docs, appliesWhen(ctx), instruction(ctx), check(file, ctx) }`. Add a fixture file that triggers it and one that does not, then assert on `ruleId@line` in `test/rules.test.ts`.

## License

MIT © 2026 Jignesh — https://djig.github.io
