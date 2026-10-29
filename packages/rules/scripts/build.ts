import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import {join, relative} from 'node:path'
import {generate, pkgRoot} from './pipeline.ts'

// Write only files whose bytes changed, and remove stale generated files, so a
// rerun on an up-to-date tree touches nothing.
const out = generate()
const dir = join(pkgRoot, 'generated')
mkdirSync(dir, {recursive: true})
const wanted = new Set([...out.keys()].map((p) => join(pkgRoot, p)))
for (const name of readdirSync(dir)) {
  const full = join(dir, name)
  if (!wanted.has(full)) rmSync(full, {recursive: true, force: true})
}
let written = 0
for (const [path, text] of out) {
  const full = join(pkgRoot, path)
  if (existsSync(full) && readFileSync(full, 'utf8') === text) continue
  writeFileSync(full, text)
  written++
  console.log(`wrote ${relative(pkgRoot, full)}`)
}
console.log(`${out.size} generated files and rules.lock.json up to date (${written} written)`)
