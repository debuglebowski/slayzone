/**
 * Agent-turn snapshots run their git on this computer (robustness plan §9; hub
 * v207), and every checkout the hub names is judged by the path jail first: a
 * folder outside the allowed roots is never snapshotted or read.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComputerConfig } from '../config'
import { createTurnGitIo } from './turn-git-io'
import type { ComputerDialer } from './types'

const dialer: ComputerDialer = { notify: () => true }
let root: string
let outside: string

function repo(dir: string): string {
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 't@t'],
    ['config', 'user.name', 't']
  ])
    spawnSync('git', args, { cwd: dir })
  writeFileSync(join(dir, 'seed.txt'), 'x')
  spawnSync('git', ['add', '.'], { cwd: dir })
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'computer-turn-io-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'computer-turn-io-outside-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function io() {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [root],
    capabilities: []
  }
  return createTurnGitIo({ dialer, config, log: () => {} })
}

describe('turn git io', () => {
  it('snapshots a checkout inside the allowed roots', async () => {
    const dir = repo(root)
    writeFileSync(join(dir, 'a.txt'), 'change')
    expect(await io().canonical(dir)).toBe(dir)
    const snap = await io().snapshot(dir, 'turn-1')
    expect(snap?.snapshotSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('refuses a checkout outside them before any git runs', async () => {
    const dir = repo(outside)
    writeFileSync(join(dir, 'a.txt'), 'change')
    await expect(io().snapshot(dir, 'turn-1')).rejects.toThrow()
    await expect(io().canonical(dir)).rejects.toThrow()
    expect(
      spawnSync('git', ['for-each-ref', 'refs/slayzone'], { cwd: dir }).stdout.toString()
    ).toBe('')
  })
})
