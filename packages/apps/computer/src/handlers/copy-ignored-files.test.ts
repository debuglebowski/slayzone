/**
 * Round-5 K3: copying a worktree's ignored files (`node_modules`, often tens of
 * thousands of files) ran synchronously, one long block of the computer's event
 * loop — every terminal and agent on the machine froze, and past the hub's heartbeat
 * window the computer was declared lost. The copy now yields: a timer standing in
 * for the heartbeat keeps firing all through a ~20k-file copy.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ComputerConfig } from '../config'
import { createGitHandlers, GitMethods } from './git'

const FILES = 20_000
let base = ''
let repo = ''
let wt = ''

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'copy-ignored-')))
  repo = join(base, 'repo')
  wt = join(base, 'wt')
  mkdirSync(wt, { recursive: true })
  // 200 packages × 100 files.
  for (let p = 0; p < FILES / 100; p++) {
    const dir = join(repo, 'node_modules', `pkg-${p}`)
    mkdirSync(dir, { recursive: true })
    for (let f = 0; f < 100; f++) writeFileSync(join(dir, `f${f}.js`), `module.exports=${f}\n`)
  }
}, 120_000)
afterAll(() => rmSync(base, { recursive: true, force: true }))

it('a 20k-file copy never starves the event loop (the heartbeat keeps going)', async () => {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 't',
    allowedRoots: [base],
    capabilities: []
  }
  const handlers = createGitHandlers({ dialer: { notify: () => true }, config, log: () => {} })

  // A heartbeat-like timer: every 50 ms, the longest wait between its ticks.
  let last = Date.now()
  let longest = 0
  const beat = setInterval(() => {
    const now = Date.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 50)
  try {
    const res = (await (handlers[GitMethods.copyIgnoredFiles] as (p: unknown) => unknown)({
      repoPath: repo,
      worktreePath: wt,
      behavior: 'custom',
      customPaths: ['node_modules']
    })) as { copied: number }
    expect(res.copied).toBe(1)
  } finally {
    // The stretch since the last tick counts too: a copy that blocks throughout
    // lets no tick run at all.
    longest = Math.max(longest, Date.now() - last)
    clearInterval(beat)
  }
  expect(readFileSync(join(wt, 'node_modules', 'pkg-199', 'f99.js'), 'utf-8')).toBe(
    'module.exports=99\n'
  )
  // The computer's heartbeat goes every 15 s and times out after 10 s; the old copy
  // blocked for seconds in one go. Far under either, even on a loaded machine.
  expect(longest, `longest event-loop gap ${longest} ms`).toBeLessThan(1_000)
}, 180_000)
