#!/usr/bin/env node
/**
 * SPIKE: this package's typecheck. Fails on any error in the package's own files.
 *
 * Why not a plain `tsgo --noEmit`: `import type { AppRouter } from '@slayzone/api'` puts
 * the hub's server sources into this program, and Expo's ambient types
 * (`expo-modules-core` `ts-declarations/global.d.ts`) make `NodeJS.ProcessEnv.NODE_ENV`
 * REQUIRED. Server code that builds a child-process `env` then fails to typecheck here
 * (~25 errors in agent-turns, processes, terminal, worktrees, …) although it is correct
 * under Node's types, which is how its own package typechecks it. Those files are only
 * the source of the router type here, so their diagnostics are COUNTED, not failed on.
 * The real fix is a type boundary that does not drag server sources into a client
 * program (router types published as declarations) — see the spike report.
 */
import { spawnSync } from 'node:child_process'

const res = spawnSync('tsgo', ['--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], {
  encoding: 'utf8',
  shell: process.platform === 'win32'
})
if (res.error) {
  console.error(`typecheck: could not run tsgo: ${res.error.message}`)
  process.exit(2)
}

// `path(line,col): error TSnnnn: …`, continuation lines indented.
const DIAG = /^(.+?)\(\d+,\d+\): error TS\d+:/
const own = []
const foreign = new Map()
let current = null
for (const line of `${res.stdout}${res.stderr}`.split('\n')) {
  const m = DIAG.exec(line)
  if (m) {
    const file = m[1]
    current = file.startsWith('../') ? null : own
    if (current) current.push(line)
    else foreign.set(file, (foreign.get(file) ?? 0) + 1)
  } else if (current && line.startsWith(' ')) current.push(line)
}

if (own.length > 0) {
  console.error(own.join('\n'))
  process.exit(1)
}
if (res.status !== 0 && foreign.size === 0) {
  // A failure we could not attribute to a file: never pass it.
  console.error(`${res.stdout}${res.stderr}`)
  process.exit(res.status ?? 1)
}
const total = [...foreign.values()].reduce((a, b) => a + b, 0)
if (total > 0) {
  console.log(
    `typecheck: this package OK. ${total} diagnostics in ${foreign.size} files of other packages ` +
      '(server sources behind AppRouter, under Expo ambient types — see this script):'
  )
  for (const [file, n] of foreign) console.log(`  ${n}× ${file}`)
} else console.log('typecheck: OK')
