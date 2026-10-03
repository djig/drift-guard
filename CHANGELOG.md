# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-03

### Added

- Version detection from `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
  (classic and berry), `bun.lock`, with `node_modules` and `package.json`
  range fallbacks; detects App Router, `src/` layout, tsconfig path aliases and
  the React Compiler.
- 23 rules across Next.js (13), React (4), Tailwind (5) and supply chain (1),
  each gated on the installed version.
- `drift-guard check` with text, `--json` and `--sarif` output.
- `drift-guard hook` for Claude Code, Codex (PostToolUse, blocking) and Cursor
  (`afterFileEdit`, advisory).
- `drift-guard init` writing hook configuration and version-specific generated
  instructions for Claude Code, Codex, Cursor (`.mdc`), GitHub Copilot and a
  managed `AGENTS.md` block; `--skill` installs the agent skill.
- `drift-guard rules` and `drift-guard agents-md --print`.
- `drift-guard.config.json` (`ignore`, `severity`, `exclude`) and inline
  `drift-guard-ignore-next-line` comments.
- Claude Code plugin + marketplace manifests so the repo installs directly.
