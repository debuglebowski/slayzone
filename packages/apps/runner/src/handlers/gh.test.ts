import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToRunnerMethods } from '@slayzone/runner-transport/shared'
import type { RunnerConfig } from '../config'
import { createGhHandlers } from './gh'
import type { RunnerDialer } from './types'

const M = HubToRunnerMethods
const dialer: RunnerDialer = { notify: () => true }

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'runner-gh-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function handlersFor(roots: string[]) {
  const config: RunnerConfig = {
    hubUrl: 'ws://localhost:0/runners',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['git']
  }
  return createGhHandlers({ dialer, config, log: () => {} })
}

describe('gh.exec', () => {
  // The jail applies to gh exactly as to every other path-taking op. A repo
  // directory outside it is one this runner will not operate in, whatever the
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
