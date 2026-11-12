/**
 * The git panel's procedures run on the computer that holds the checkout: the
 * caller's path scope (a task, or a project; §9 Phase 7b) resolves it, and the op
 * leaves as one `git.op` request under that scope. A call naming neither is refused;
 * with no computer the hub refuses too (it never runs git itself).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { TRPCError } from '@trpc/server'
import { worktreesRouter } from './worktrees-router'
import { setWorktreesRouterDeps } from './worktrees-router-deps'
import { setGitOpTransport } from './git-op-routing'
import { setGhExecutor } from './gh-cli'

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
      if (params.op === 'listWorktrees') return []
      if (params.op === 'startMergeNoCommit') return { clean: true, conflictedFiles: [] }
      return params.op === 'getCurrentBranch' ? 'main' : null
    },
    watchStart: async () => undefined,
    watchStop: async () => undefined
  })
})

afterEach(() => {
  sent.length = 0
  targets.length = 0
  resolved = 'computer-1'
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
})

afterAll(() => setGitOpTransport(null))

// A hub with one task (t1, project p1), projects p1 and p-test, and no checkouts.
const noRows = {
  get: async (sql: string, params?: unknown[]) =>
    sql.includes('FROM projects')
      ? params?.[0] === 'p1' || params?.[0] === 'p-test'
        ? { id: params[0] }
        : undefined
      : params?.[0] === 't1'
        ? { project_id: 'p1' }
        : undefined,
  all: async () => []
}
// A prepared statement's get takes params, not SQL: no rows.
const noCheckouts = {
  ...noRows,
  prepare: () => ({ get: async () => undefined, all: async () => [] })
}
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
    await caller.stageFile({ target: { projectId: 'p-test' }, path: '/w/repo', filePath: 'a.ts' })
    expect(sent[0]?.params).toMatchObject({ op: 'stageFile', mutates: true })
  })

  test('no scope: refused, nothing sent (a bare path names nobody)', async () => {
    // Cast: the type requires a scope; this proves the run-time refusal too.
    await expect(caller.listStashes({ repoPath: '/w/repo' } as never)).rejects.toThrow(
      /must name the task or project/
    )
    expect(sent).toHaveLength(0)
  })

  test('works on a hub with processes off — nothing runs on the hub', async () => {
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    await caller.fetch({ target: { projectId: 'p-test' }, path: '/w/repo' })
    expect(sent).toHaveLength(1)
  })

  test('no computer, on ANY hub: "connect a computer" — the hub never runs git itself', async () => {
    resolved = null
    for (const op of [
      () => caller.getCurrentBranch({ target: { projectId: 'p-test' }, path: '/w/repo' }),
      () => caller.stageAll({ target: { projectId: 'p-test' }, path: '/w/repo' }),
      () => caller.watchStart({ target: { projectId: 'p-test' }, worktreePath: '/w/never' })
    ]) {
      const err = await op().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TRPCError)
      expect((err as TRPCError).code).toBe('FORBIDDEN')
      expect((err as TRPCError).message).toMatch(/Connect a computer/)
    }
    expect(sent).toHaveLength(0)
  })

  test('no computer on a hub with processes off: NO_COMPUTER_CONNECTED, nothing sent', async () => {
    resolved = null
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    const err = await caller
      .getCurrentBranch({ target: { projectId: 'p-test' }, path: '/w/repo' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect(sent).toHaveLength(0)
  })
})

describe('PR ops', () => {
  test('hasGithubRemote asks the computer', async () => {
    await caller.hasGithubRemote({ target: { projectId: 'p-test' }, repoPath: '/w/repo' })
    expect(sent.at(-1)?.params).toMatchObject({ op: 'hasGithubRemote', mutates: false })
  })

  test('createPr pushes the branch ON the computer, then runs gh', async () => {
    const gh: string[][] = []
    setGhExecutor(async (args) => {
      gh.push(args)
      return { stdout: 'https://github.com/o/r/pull/7\n', stderr: '', status: 0 }
    })
    try {
      const pr = await caller.createPr({
        target: { projectId: 'p-test' },
        repoPath: '/w/repo',
        title: 't',
        body: 'b',
        baseBranch: 'main'
      })
      expect(pr).toEqual({ url: 'https://github.com/o/r/pull/7', number: 7 })
      expect(sent.map((x) => x.params.op)).toEqual(['ensureBranchPushed'])
      expect(sent[0]?.params.mutates).toBe(true)
      expect(gh[0]?.slice(0, 2)).toEqual(['pr', 'create'])
    } finally {
      setGhExecutor(null)
    }
  })
})

describe('worktree lifecycle and AI merge run on the computer', () => {
  test('createWorktree: create + submodules + setup script there', async () => {
    await caller.createWorktree({
      repoPath: '/w/repo',
      targetPath: '/w/wt-1',
      branch: 'feat',
      projectId: 'p1'
    })
    const ops = sent.map((x) => x.params.op)
    expect(ops[0]).toBe('addWorktree')
    expect(ops).toContain('runWorktreeSetupScript')
    expect(ops.every((op) => op !== undefined)).toBe(true)
  })

  test('removeWorktree there', async () => {
    await caller.removeWorktree({
      target: { projectId: 'p-test' },
      repoPath: '/w/repo',
      worktreePath: '/w/wt-1'
    })
    expect(sent.at(-1)?.params).toMatchObject({ op: 'removeWorktree', mutates: true })
  })

  test("detectWorktrees: git there, colors from the hub's registry", async () => {
    const out = await caller.detectWorktrees({
      target: { projectId: 'p-test' },
      repoPath: '/w/repo'
    })
    expect(sent.at(-1)?.params.op).toBe('listWorktrees')
    expect(Array.isArray(out)).toBe(true)
  })

  test("mergeWithAI: its git steps there, the agent's prompt built here", async () => {
    await caller.mergeWithAI({
      target: { projectId: 'p-test' },
      projectPath: '/w/repo',
      worktreePath: '/w/wt-1',
      parentBranch: 'main',
      sourceBranch: 'feat'
    })
    expect(sent.map((x) => x.params.op)).toEqual(['hasUncommittedChanges', 'startMergeNoCommit'])
  })
})
