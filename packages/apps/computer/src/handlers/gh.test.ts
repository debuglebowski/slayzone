import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createGhHandlers } from './gh'
import type { ComputerDialer } from './types'

const M = HubToComputerMethods
const dialer: ComputerDialer = { notify: () => true }

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-gh-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

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
  it('resolves with a non-zero status rather than rejecting', async () => {
    const handlers = handlersFor([dir])
    const res = (await handlers[M.ghExec]({
      // A subcommand that cannot succeed here — no gh, or no repo. Either way the
      // contract is the same: resolve, do not throw.
      args: ['pr', 'list'],
      cwd: dir,
      timeoutMs: 10_000
    })) as { status: number | null; stdout: string; stderr: string }
    expect(res.status === 0).toBe(false)
    expect(typeof res.stderr).toBe('string')
  })
})
