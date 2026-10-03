---
name: drift-guard
description: Check React / Next.js / Tailwind edits for training-data version drift — patterns that were correct for an older framework version but are wrong or silently broken for the version installed in this project. Use after editing .ts/.tsx/.css files in a Next.js, React or Tailwind project, before declaring a change done.
license: MIT
metadata:
  author: djig
  version: "0.1.0"
---

# drift-guard

## What "version drift" is

Your training data contains many more examples of Next.js 13/14, React 18 and
Tailwind v3 than of the versions installed here. Code that was correct then is
often *silently* wrong now: `middleware.ts` compiles and does nothing on
Next 16, `params.id` compiles and crashes at runtime on Next 15+,
`@tailwind base` emits no CSS on Tailwind v4, `shadow-sm` renders a different
size. drift-guard is a deterministic checker (no LLM) that reads the installed
versions from the lockfile and flags only the patterns that are wrong *for
this project*.

## Workflow

1. Once per session, learn which rules apply here:

   ```sh
   npx -y @djig/drift-guard rules
   ```

   The output names the detected versions and marks each rule `applies` or
   `skipped`. Treat every applying rule as a fact about this codebase that
   overrides what you remember.

2. After editing files, check exactly the files you touched:

   ```sh
   npx -y @djig/drift-guard check path/to/file.tsx path/to/other.css
   ```

   Run `npx -y @djig/drift-guard check` with no paths to scan the whole project.

3. Read findings as `file:line  severity  message  rule-id` followed by
   `→ fix: …`. The fix line is a one-line instruction; apply it.

4. Fix every `error` before you report the task as done. Do not add
   `drift-guard-ignore` comments or edit `drift-guard.config.json` to make an
   error disappear unless the user explicitly asks for that; `warn` and
   `info` are advisory but usually worth fixing in new code.

5. If a hook blocked your edit, the block reason already contains the file,
   line, message and fix for up to six findings — fix them and re-apply the
   edit. Do not retry the same edit unchanged.

## Severity

- `error` — will break at build or runtime, or is silently ignored by the
  installed version (exit code 1; hooks block).
- `warn` — deprecated or renamed; works today but behaves differently or will
  be removed.
- `info` — stylistic for the installed version (e.g. `forwardRef` on React 19).

## Rule ids

Next.js: `next/sync-dynamic-apis`, `next/sync-params`, `next/middleware-file`,
`next/revalidate-tag-signature`, `next/removed-experimental-flags`,
`next/pages-apis-in-app-dir`, `next/use-client-root-layout`,
`next/fetch-in-effect`, `next/edge-runtime-node-client`,
`next/removed-next-lint`, `next/public-env-secret`,
`next/legacy-import-paths`, `next/use-form-state`.

React: `react/forward-ref`, `react/removed-apis`,
`react/manual-memo-with-compiler`, `react/index-key`.

Tailwind: `tailwind/v3-directives`, `tailwind/legacy-config-file`,
`tailwind/renamed-utilities`, `tailwind/important-prefix`,
`tailwind/css-var-arbitrary`.

Supply chain: `deps/unknown-package` — an import whose package is neither in
package.json nor in node_modules. Verify the package exists on npm
(`npm view <name>`) before installing it; never assume a package from memory
exists.

## Output formats

`--json` for machine reading, `--sarif` for GitHub code scanning. Exit code 1
means at least one `error` finding.
