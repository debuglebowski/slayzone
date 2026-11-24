/**
 * The git panel's two batched reads (`getGitSummary`, `getBranchGraph`). Each was a
 * chain of dependent requests (repo check → branch/remote/status → upstream; branch →
 * child branches → commit graph), so on a remote hub/computer the panel waited out
 * every hop's round trip in turn. A computer that answers them (`gitPanelReads`)
 * runs each chain itself: ONE hub → computer request. An older computer gets the
 * same answer assembled by the hub from the single ops it knows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { worktreesRouter } from './worktrees-router'
import { setWorktreesRouterDeps } from './worktrees-router-deps'
import { setGitOpTransport } from './git-op-routing'

const STATUS = { staged: 1, unstaged: 2, untracked: 3 }
const UPSTREAM = { ahead: 1, behind: 0 }
const GRAPH = { commits: [], branches: ['main', 'feat'], baseBranch: 'main' }
const sent: Array<{ op: string; input: Record<string, unknown> }> = []
let panelReads = true
let failOp: string | null = null
let isRepo = true

beforeAll(() => {
  setWorktreesRouterDeps({
    getWorkspace: () => ({ fs: {} as never, resolveComputer: async () => 'computer-1' }),
    shellOpenPath: async () => ''
  })
  setGitOpTransport({
    supports: (_id, feature) => feature === 'gitPanelReads' && panelReads,
    request: async (_computerId, params) => {
      const input = params.input as Record<string, unknown>
      sent.push({ op: params.op, input })
      if (params.op === failOp) throw new Error(`${params.op} failed`)
      switch (params.op) {
        case 'getGitSummary':
          return { kind: 'repo', computed: 'on the computer' }
        case 'getBranchGraph':
          return { branch: 'feat', graph: GRAPH, computed: 'on the computer' }
        case 'isGitRepo':
          return isRepo
        case 'getCurrentBranch':
          return input.path === '/w/wt' ? 'feat' : 'main'
        case 'getRemoteUrl':
          return 'git@example.com:o/r.git'
        case 'getStatusSummary':
          return STATUS
        case 'getAheadBehindUpstream':
          return UPSTREAM
        case 'resolveChildBranches':
          return { children: ['feat'], merged: ['old'] }
        case 'getResolvedCommitDag':
          return GRAPH
      }
      throw new Error(`unexpected op ${params.op}`)
    },
    watchStart: async () => undefined,
    watchStop: async () => undefined
  })
})
afterEach(() => {
  sent.length = 0
  panelReads = true
  failOp = null
  isRepo = true
})
afterAll(() => setGitOpTransport(null))

const db = {
  get: async (sql: string, params?: unknown[]) =>
    sql.includes('FROM projects') ? { id: params?.[0] } : { project_id: 'p1' },
  all: async () => [],
  prepare: () => ({ get: async () => undefined, all: async () => [] })
}
const caller = worktreesRouter.createCaller({ db: db as never, dataRoot: '' } as never)
const target = { taskId: 't1' }
const summaryInput = { path: '/w/repo', checkoutPath: '/w/wt', statusPath: '/w/wt', target }
const graphInput = { path: '/w/repo', limit: 50, showBranches: true, target }

describe('a computer that answers the panel reads', () => {
  test('the summary is one request', async () => {
    expect(await caller.getGitSummary(summaryInput)).toEqual({
      kind: 'repo',
      computed: 'on the computer'
    })
    expect(sent.map((s) => s.op)).toEqual(['getGitSummary'])
  })

  test('the branch graph is one request', async () => {
    expect(await caller.getBranchGraph(graphInput)).toEqual({
      branch: 'feat',
      graph: GRAPH,
      computed: 'on the computer'
    })
    expect(sent.map((s) => s.op)).toEqual(['getBranchGraph'])
  })

  test('a failed summary request reads as a failed repo check (as before)', async () => {
    failOp = 'getGitSummary'
    expect(await caller.getGitSummary(summaryInput)).toEqual({
      kind: 'checkFailed',
      message: 'getGitSummary failed'
    })
  })
})

describe('an older computer: the hub assembles the same answer', () => {
  test('summary: check, then the reads, then the upstream of the active branch', async () => {
    panelReads = false
    expect(await caller.getGitSummary(summaryInput)).toEqual({
      kind: 'repo',
      branch: 'main',
      remoteUrl: 'git@example.com:o/r.git',
      checkoutBranch: 'feat',
      status: STATUS,
      upstream: UPSTREAM
    })
    expect(sent.find((s) => s.op === 'getAheadBehindUpstream')?.input).toMatchObject({
      path: '/w/wt',
      branch: 'feat'
    })
    expect(sent.some((s) => s.op === 'getGitSummary')).toBe(false)
  })

  test('summary: not a repo answers notRepo (the overlapped reads are dropped)', async () => {
    panelReads = false
    isRepo = false
    expect(await caller.getGitSummary(summaryInput)).toEqual({ kind: 'notRepo' })
  })

  test('summary: the reads go out alongside the repo check (one round trip, not two)', async () => {
    panelReads = false
    await caller.getGitSummary(summaryInput)
    // All four reads were sent before the upstream read, which needs their answers.
    expect(
      sent
        .map((s) => s.op)
        .slice(0, 5)
        .sort()
    ).toEqual(
      [
        'getCurrentBranch',
        'getCurrentBranch',
        'getRemoteUrl',
        'getStatusSummary',
        'isGitRepo'
      ].sort()
    )
    expect(sent.at(-1)?.op).toBe('getAheadBehindUpstream')
  })

  test('summary: a failed repo check is its message', async () => {
    panelReads = false
    failOp = 'isGitRepo'
    expect(await caller.getGitSummary(summaryInput)).toEqual({
      kind: 'checkFailed',
      message: 'isGitRepo failed'
    })
  })

  test('summary: a failed read is readFailed, not a failed check', async () => {
    panelReads = false
    failOp = 'getStatusSummary'
    expect(await caller.getGitSummary(summaryInput)).toEqual({ kind: 'readFailed' })
  })

  test('summary: no checkout or status path reads neither, nor an upstream', async () => {
    panelReads = false
    expect(await caller.getGitSummary({ path: '/w/repo', target })).toEqual({
      kind: 'repo',
      branch: 'main',
      remoteUrl: 'git@example.com:o/r.git',
      checkoutBranch: null,
      status: null,
      upstream: null
    })
    expect(sent.map((s) => s.op).sort()).toEqual(
      ['getCurrentBranch', 'getRemoteUrl', 'isGitRepo'].sort()
    )
  })

  test('graph: branch, its children, then the graph of all of them', async () => {
    panelReads = false
    expect(await caller.getBranchGraph(graphInput)).toEqual({ branch: 'main', graph: GRAPH })
    expect(sent.map((s) => s.op)).toEqual([
      'getCurrentBranch',
      'resolveChildBranches',
      'getResolvedCommitDag'
    ])
    expect(sent[2].input).toMatchObject({
      path: '/w/repo',
      limit: 50,
      baseBranch: 'main',
      branches: ['main', 'feat', 'old']
    })
  })

  test('graph: an explicit base branch wins; showBranches off reads no children', async () => {
    panelReads = false
    await caller.getBranchGraph({ ...graphInput, baseBranch: 'dev', showBranches: false })
    expect(sent.map((s) => s.op)).toEqual(['getCurrentBranch', 'getResolvedCommitDag'])
    expect(sent[1].input).toMatchObject({ baseBranch: 'dev', branches: ['dev'] })
  })
})
