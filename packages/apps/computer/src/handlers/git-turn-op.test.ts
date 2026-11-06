/**
 * `git.turnOp`: turn snapshots and their reads run here, through the same table the
 * hub declares (`@slayzone/agent-turns/turn-git`), every repo path jailed.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createGitOpHandlers } from './git-op'

let dir: string
let call: (params: unknown) => Promise<unknown>

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-turn-op-')))
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  g(['add', '.'])
  g(['commit', '-qm', 'first'])
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [realpathSync(tmpdir())],
    capabilities: ['git']
  }
  const handlers = createGitOpHandlers({ dialer: { notify: () => true }, config, log: () => {} })
  call = (params) =>
    Promise.resolve((handlers[HubToComputerMethods.gitTurnOp] as (p: unknown) => unknown)(params))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('git.turnOp', () => {
  it('snapshots the worktree here and answers the snapshot', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const { result } = (await call({ op: 'snapshot', input: { repoPath: dir, turnId: 't1' } })) as {
      result: { snapshotSha: string; headSha: string }
    }
    expect(result.snapshotSha).toMatch(/^[0-9a-f]{40}$/)
    const empty = (await call({
      op: 'diffIsEmpty',
      input: { repoPath: dir, from: result.headSha, to: result.snapshotSha }
    })) as { result: boolean }
    expect(empty.result).toBe(false)
  })

  it('canonicalizes a path on this disk', async () => {
    expect(await call({ op: 'canonical', input: { repoPath: `${dir}/.` } })).toEqual({
      result: dir
    })
  })

  it('refuses a repo outside its folders and an unknown op', async () => {
    await expect(
      call({ op: 'snapshot', input: { repoPath: '/etc', turnId: 'x' } })
    ).rejects.toThrow(/outside/)
    await expect(call({ op: 'rmRf', input: { repoPath: dir } })).rejects.toThrow(/unknown turn op/)
  })
})
