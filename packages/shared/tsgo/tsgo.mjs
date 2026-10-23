#!/usr/bin/env node
// Run TypeScript 7's `tsc` with our arguments. Resolved from this package, whose
// `typescript` dependency is 7.x; the workspace root keeps 5.x for the JS compiler API.
// `exports` hides bin/, so find the package by its manifest and run its declared bin.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const manifest = createRequire(import.meta.url).resolve('typescript/package.json')
const tsc = join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.tsc)
const { status, signal } = spawnSync(process.execPath, [tsc, ...process.argv.slice(2)], {
  stdio: 'inherit'
})
process.exit(status ?? (signal ? 1 : 0))
