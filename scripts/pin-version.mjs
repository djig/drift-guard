#!/usr/bin/env node
// Rewrites every `@scope/name@x.y.z` reference in the plugin's manifests, hooks,
// skill and docs to the version in package.json. Runs automatically from the
// `version` npm lifecycle (npm version patch|minor|major), so release pins
// never drift. Anthropic's plugin directory requires exact pins on npx launchers.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const name = pkg.name; // e.g. @djignesh21/drift-guard
const version = pkg.version;

const files = (pkg.pinnedFiles ?? []).map((f) => resolve(root, f)).filter(existsSync);
const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Matches name@<semver-ish> (so an older pin gets replaced) and a bare name
// followed by a space, quote, or end (so an unpinned reference gets pinned).
const pinned = new RegExp(`${escaped}@[0-9][0-9A-Za-z.\\-+]*`, 'g');
const bare = new RegExp(`${escaped}(?=["'\\s,\\])}]|$)`, 'g');

let changed = 0;
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(pinned, `${name}@${version}`).replace(bare, `${name}@${version}`);
  if (after !== before) {
    writeFileSync(file, after);
    changed++;
    console.log(`pinned ${name}@${version} in ${file.slice(root.length + 1)}`);
  }
}
console.log(`pin-version: ${changed} file(s) updated to ${version}`);
