/**
 * A git op on the computer is one request; without an explicit timeout the gateway's
 * 30 s default cut off a push with a pre-push hook, a commit running lint-staged, or
 * a worktree whose setup script runs `pnpm install` — while the work kept going
 * there (a retry then hit index.lock or a duplicate worktree). Every op names its
 * own limit; ops that run hooks, the network or setup scripts get minutes.
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import { GIT_INTERNAL_OPS, gitOpsContract, gitOpTimeoutMs } from '../shared/git-ops-contract'
import { executeGitOp, setGitOpTransport } from './git-op-routing'
import { setWorktreesRouterDeps } from './worktrees-router-deps'

const GATEWAY_DEFAULT_MS = 30_000
const sent: Array<{ op: string; timeoutMs: number | undefined; target: unknown }> = []

beforeAll(() => {
  setWorktreesRouterDeps({
    getWorkspace: () => ({ fs: {} as never, resolveComputer: async () => 'c1' }),
    shellOpenPath: async () => ''
  })
  setGitOpTransport({
    request: async (_computerId, params, timeoutMs, target) => {
      sent.push({ op: params.op, timeoutMs, target })
      return null
    },
    watchStart: async () => undefined,
    watchStop: async () => undefined
  })
})
afterAll(() => setGitOpTransport(null))

test('every git op has an explicit timeout above the gateway default', () => {
  for (const op of [...Object.keys(gitOpsContract), ...GIT_INTERNAL_OPS]) {
    expect(gitOpTimeoutMs(op as never), op).toBeGreaterThan(GATEWAY_DEFAULT_MS)
  }
})

test('hook, network and setup ops get minutes', () => {
  for (const op of [
    'push',
    'pull',
    'fetch',
    'commitFiles',
    'mergeIntoParent',
    'rebaseOnto',
    'continueRebase',
    'addWorktree',
    'runWorktreeSetupScript',
    'initSubmodules',
    'ensureBranchPushed'
  ] as const) {
    // The computer's own setup-script / submodule limit is 5 min: the request outlives it.
    expect(gitOpTimeoutMs(op), op).toBeGreaterThan(5 * 60_000)
  }
})

test("the routed request carries the op's timeout", async () => {
  const db = { get: async () => ({ project_id: null }) } as never
  await executeGitOp(
    'push',
    { repoPath: '/r', target: { projectId: 'p1' } } as never,
    true,
    db
  ).catch(() => undefined)
  // …and what it works on (its path scope): the hub gates the op on that.
  expect(sent.at(-1)).toEqual({
    op: 'push',
    timeoutMs: gitOpTimeoutMs('push'),
    target: { projectId: 'p1' }
  })
})
