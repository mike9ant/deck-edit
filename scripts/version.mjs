#!/usr/bin/env node
// The app's version lives in several files; this keeps them in step.
//   node scripts/version.mjs              print the version (from desktop/tauri.conf.json)
//   node scripts/version.mjs bump-minor   X.Y.Z → X.(Y+1).0 everywhere, print the new version
// Used by `./run.sh push`, which bumps the minor version once per new day of commits.

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const current = JSON.parse(readFileSync(`${root}desktop/tauri.conf.json`, 'utf8')).version

if (process.argv[2] !== 'bump-minor') {
  console.log(current)
  process.exit(0)
}

const [major, minor] = current.split('.').map(Number)
const next = `${major}.${minor + 1}.0`

/** Replace the version in one file; fail loudly if the pattern isn't there (a file moved or changed shape). */
function set(file, pattern, value) {
  const path = root + file
  const text = readFileSync(path, 'utf8')
  const updated = text.replace(pattern, (_, before, after) => `${before}${value}${after}`)
  if (updated === text) throw new Error(`version not found in ${file}`)
  writeFileSync(path, updated)
}

set('desktop/tauri.conf.json', /("version":\s*")[^"]+(")/, next)
set('backend/Cargo.toml', /^(version\s*=\s*")[^"]+(")/m, next)
set('desktop/Cargo.toml', /^(version\s*=\s*")[^"]+(")/m, next)
set('frontend/src/version.ts', /(APP_VERSION\s*=\s*')[^']+(')/, `${major}.${minor + 1}`) // shown in About as "X.Y"
// package.json and package-lock.json together.
execFileSync('npm', ['version', next, '--no-git-tag-version', '--allow-same-version'], { cwd: `${root}frontend`, stdio: 'ignore' })
// The workspace crates' versions in Cargo.lock (no network needed).
execFileSync('cargo', ['update', '--workspace', '--offline'], { cwd: root, stdio: 'ignore' })

console.log(next)
