#!/usr/bin/env node
// The app's version lives in several files; this keeps them in step.
//   node scripts/version.mjs              print the version (from desktop/tauri.conf.json)
//   node scripts/version.mjs bump-patch   X.Y.Z → X.Y.(Z+1)   — what `./run.sh push` does once per new day of commits
//   node scripts/version.mjs bump-minor   X.Y.Z → X.(Y+1).0   — by hand, for a minor release
// Each prints the new version. Files: desktop/tauri.conf.json, backend/Cargo.toml, desktop/Cargo.toml
// (+ Cargo.lock), frontend/package.json (+ lock), frontend/src/version.ts (shown in About).

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const current = JSON.parse(readFileSync(`${root}desktop/tauri.conf.json`, 'utf8')).version
const command = process.argv[2]

if (!command) {
  console.log(current)
  process.exit(0)
}

const [major, minor, patch] = current.split('.').map(Number)
const next = { 'bump-patch': `${major}.${minor}.${patch + 1}`, 'bump-minor': `${major}.${minor + 1}.0` }[command]
if (!next) {
  console.error(`unknown command "${command}" (use bump-patch or bump-minor)`)
  process.exit(2)
}

/** Replace the version in one file; fail loudly if the pattern isn't there (a file moved or changed shape). */
function set(file, pattern) {
  const path = root + file
  const text = readFileSync(path, 'utf8')
  const updated = text.replace(pattern, (_, before, after) => `${before}${next}${after}`)
  if (updated === text) throw new Error(`version not found in ${file}`)
  writeFileSync(path, updated)
}

set('desktop/tauri.conf.json', /("version":\s*")[^"]+(")/)
set('backend/Cargo.toml', /^(version\s*=\s*")[^"]+(")/m)
set('desktop/Cargo.toml', /^(version\s*=\s*")[^"]+(")/m)
set('frontend/src/version.ts', /(APP_VERSION\s*=\s*')[^']+(')/)
// package.json and package-lock.json together.
execFileSync('npm', ['version', next, '--no-git-tag-version', '--allow-same-version'], { cwd: `${root}frontend`, stdio: 'ignore' })
// The workspace crates' versions in Cargo.lock (no network needed).
execFileSync('cargo', ['update', '--workspace', '--offline'], { cwd: root, stdio: 'ignore' })

console.log(next)
