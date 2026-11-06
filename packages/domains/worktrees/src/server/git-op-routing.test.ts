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

// A hub that knows no checkout: no path names a target.
const noRows = { get: async () => undefined, all: async () => [] }
const noCheckouts = { ...noRows, prepare: () => noRows }
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

  test('no computer, on ANY hub: "connect a computer" — the hub never runs git itself', async () => {
    resolved = null
    for (const op of [
      () => caller.getCurrentBranch({ path: '/w/repo' }),
      () => caller.stageAll({ path: '/w/repo' }),
      () => caller.watchStart({ worktreePath: '/w/never' })
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
    const err = await caller.getCurrentBranch({ path: '/w/repo' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect(sent).toHaveLength(0)
  })
})

describe('PR ops', () => {
  test('hasGithubRemote asks the computer', async () => {
    await caller.hasGithubRemote({ repoPath: '/w/repo' })
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
    await caller.removeWorktree({ repoPath: '/w/repo', worktreePath: '/w/wt-1' })
    expect(sent.at(-1)?.params).toMatchObject({ op: 'removeWorktree', mutates: true })
  })

  test("detectWorktrees: git there, colors from the hub's registry", async () => {
    const out = await caller.detectWorktrees({ repoPath: '/w/repo' })
    expect(sent.at(-1)?.params.op).toBe('listWorktrees')
    expect(Array.isArray(out)).toBe(true)
  })

  test("mergeWithAI: its git steps there, the agent's prompt built here", async () => {
    await caller.mergeWithAI({
      projectPath: '/w/repo',
      worktreePath: '/w/wt-1',
      parentBranch: 'main',
      sourceBranch: 'feat'
    })
    expect(sent.map((x) => x.params.op)).toEqual(['hasUncommittedChanges', 'startMergeNoCommit'])
  })
})
