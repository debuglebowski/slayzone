import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createGhHandlers } from './gh'
import type { ComputerDialer } from './types'

const M = HubToComputerMethods
const dialer: ComputerDialer = { notify: () => true }
const isWin = process.platform === 'win32'

let dir: string
let savedPath: string | undefined

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-gh-')))
  savedPath = process.env.PATH
})
afterEach(() => {
  process.env.PATH = savedPath
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Put a stand-in `gh` first on PATH. The real one makes the result depend on the
 * machine — whether gh is installed, signed in, or waiting on the network — and
 * a slow one timed CI out (2026-10-29).
 */
function fakeGh(lines: string[]): void {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const gh = join(bin, 'gh')
  writeFileSync(gh, ['#!/bin/sh', ...lines].join('\n') + '\n')
  chmodSync(gh, 0o755)
  process.env.PATH = `${bin}:${savedPath ?? ''}`
}

function handlersFor(roots: string[]) {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['git']
  }
  return createGhHandlers({ dialer, config, log: () => {} })
}

describe('gh.exec', () => {
  // The jail applies to gh exactly as to every other path-taking op. A repo
  // directory outside it is one this computer will not operate in, whatever the
  // hub asked for.
  it('refuses a cwd outside allowedRoots', async () => {
    const inner = join(dir, 'inner')
    mkdirSync(inner, { recursive: true })
    const handlers = handlersFor([inner])
    await expect(handlers[M.ghExec]({ args: ['--version'], cwd: dir })).rejects.toThrow(
      /allowedRoots/
    )
  })

  it('rejects a non-absolute cwd via schema before touching anything', async () => {
    const handlers = handlersFor([dir])
    await expect(handlers[M.ghExec]({ args: ['--version'], cwd: '' })).rejects.toThrow()
  })

  // gh uses exit codes for ordinary answers ("no pull requests found") as well as
  // real errors, and every caller above already branches on status. Rejecting
  // would turn a normal answer into an exception.
  it.skipIf(isWin)('resolves with a non-zero status rather than rejecting', async () => {
    fakeGh(['echo "args: $*" >&2', 'echo "cwd: $(pwd)" >&2', 'exit 1'])
    const handlers = handlersFor([dir])
    const res = (await handlers[M.ghExec]({ args: ['pr', 'list'], cwd: dir })) as {
      status: number | null
      stdout: string
      stderr: string
    }
    expect(res.status).toBe(1)
    expect(res.stderr, 'argv reaches gh as given').toContain('args: pr list')
    expect(res.stderr, 'gh runs in the requested cwd').toContain(`cwd: ${dir}`)
  })
})
