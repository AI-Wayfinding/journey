import {mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {generate, pkgRoot} from './pipeline.ts'

const out = generate()
const dir = join(pkgRoot, 'generated')
rmSync(dir, {recursive: true, force: true})
mkdirSync(dir, {recursive: true})
for (const [path, text] of out) writeFileSync(join(pkgRoot, path), text)
console.log(`wrote ${readdirSync(dir).length} generated files and rules.lock.json`)
