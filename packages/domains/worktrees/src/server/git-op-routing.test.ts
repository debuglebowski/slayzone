/**
 * The git panel's procedures run on the computer that holds the checkout: the
 * caller's target (a task, a project, an explicit computer — or the caller's
 * default) resolves it, and the op leaves as one `git.op` request. Only with NO
 * computer does it run on the hub's own disk — and a hub with processes switched off
 * refuses that (`NO_COMPUTER_CONNECTED`), as every hub-local exec.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { TRPCError } from '@trpc/server'
import { worktreesRouter } from './worktrees-router'
import { setWorktreesRouterDeps } from './worktrees-router-deps'
import { setGitOpTransport } from './git-op-routing'

const sent: Array<{
  computerId: string
  params: { op: string; input: unknown; mutates: boolean }
}> = []
let resolved: string | null = 'computer-1'
const targets: unknown[] = []

beforeAll(() => {
  setWorktreesRouterDeps({
    getWorkspace: () => ({
      fs: {} as never,
      resolveComputer: async (target) => {
        targets.push(target)
        return resolved
      }
    }),
    shellOpenPath: async () => ''
  })
  setGitOpTransport({
    request: async (computerId, params) => {
      sent.push({ computerId, params })
      return params.op === 'getCurrentBranch' ? 'main' : null
    }
  })
})

afterEach(() => {
  sent.length = 0
  targets.length = 0
  resolved = 'computer-1'
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
})

afterAll(() => setGitOpTransport(null))

// A hub that knows no checkout: no path names a target.
const noCheckouts = { get: async () => undefined, all: async () => [] }
const caller = worktreesRouter.createCaller({ db: noCheckouts as never, dataRoot: '' } as never)

describe('git panel ops routed to the computer', () => {
  test('a read goes to the resolved computer, its target resolved and not sent on', async () => {
    const branch = await caller.getCurrentBranch({ path: '/w/repo', target: { taskId: 't1' } })
    expect(branch).toBe('main')
    expect(targets).toEqual([{ taskId: 't1' }])
    expect(sent).toEqual([
      {
        computerId: 'computer-1',
        params: { op: 'getCurrentBranch', input: { path: '/w/repo' }, mutates: false }
      }
    ])
  })

  test('a write says so (the audit log records it)', async () => {
    await caller.stageFile({ path: '/w/repo', filePath: 'a.ts' })
    expect(sent[0]?.params).toMatchObject({ op: 'stageFile', mutates: true })
  })

  test('no target: the caller default decides', async () => {
    await caller.listStashes({ repoPath: '/w/repo' })
    expect(targets).toEqual([{}])
    expect(sent).toHaveLength(1)
  })

  test('works on a hub with processes off — nothing runs on the hub', async () => {
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    await caller.fetch({ path: '/w/repo' })
    expect(sent).toHaveLength(1)
  })

  test('no computer on a hub with processes off: NO_COMPUTER_CONNECTED, nothing sent', async () => {
    resolved = null
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    const err = await caller.getCurrentBranch({ path: '/w/repo' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect(sent).toHaveLength(0)
  })
})
