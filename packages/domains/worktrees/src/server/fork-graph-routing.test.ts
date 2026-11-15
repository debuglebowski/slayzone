/**
 * The fork graph and commits-since through the hub (FU1 S4). Against a computer
 * that answers bounded reads, the hub reads the commits in pages
 * (`getCommitsSincePage`) and builds the WHOLE graph itself — the same graph, the
 * same counts — so no computer reply carries an unbounded commit list. An older
 * computer gets the whole-answer ops it knows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { CommitInfo } from '../shared/types'
import { worktreesRouter } from './worktrees-router'
import { setWorktreesRouterDeps } from './worktrees-router-deps'
import { setGitOpTransport } from './git-op-routing'
import { resolveForkGraph } from './fork-graph'

const commit = (n: number, side: string): CommitInfo => ({
  hash: `${side}${n}`.padEnd(40, '0'),
  shortHash: `${side}${n}`,
  message: `${side} ${n}`,
  author: 'T',
  relativeDate: 'now'
})
const BASE = Array.from({ length: 5 }, (_, n) => commit(n, 'b'))
const FEATURE = Array.from({ length: 3 }, (_, n) => commit(n, 'f'))
const PRE = [commit(0, 'p')]
const sent: Array<{ op: string; input: Record<string, unknown> }> = []
let bounded = true
let mergeBase: string | null = 'm'.repeat(40)

beforeAll(() => {
  setWorktreesRouterDeps({
    getWorkspace: () => ({ fs: {} as never, resolveComputer: async () => 'computer-1' }),
    shellOpenPath: async () => ''
  })
  setGitOpTransport({
    supports: (_id, feature) => feature === 'boundedReads' && bounded,
    request: async (_computerId, params) => {
      const input = params.input as Record<string, unknown>
      sent.push({ op: params.op, input })
      if (params.op === 'getMergeBase') return mergeBase
      if (params.op === 'getCommitsBeforeRef') return PRE
      if (params.op === 'getCommitsSincePage') {
        const list = input.path === '/w/repo' ? BASE : FEATURE
        const at = input.cursor === null ? 0 : Number(input.cursor)
        const items = list.slice(at, at + 2)
        return { items, nextCursor: at + 2 < list.length ? String(at + 2) : null }
      }
      return { whole: params.op }
    },
    watchStart: async () => undefined,
    watchStop: async () => undefined
  })
})
afterEach(() => {
  sent.length = 0
  bounded = true
  mergeBase = 'm'.repeat(40)
})
afterAll(() => setGitOpTransport(null))

const db = {
  get: async (sql: string, params?: unknown[]) =>
    sql.includes('FROM projects') ? { id: params?.[0] } : { project_id: 'p1' },
  all: async () => [],
  prepare: () => ({ get: async () => undefined, all: async () => [] })
}
const caller = worktreesRouter.createCaller({ db: db as never, dataRoot: '' } as never)
const input = {
  targetPath: '/w/wt',
  repoPath: '/w/repo',
  activeBranch: 'feat',
  compareBranch: 'main',
  activeBranchLabel: 'feat',
  compareBranchLabel: 'main',
  target: { taskId: 't1' }
}

describe('a bounded computer: the hub builds the whole graph from pages', () => {
  test('same graph and counts; commits read in pages; no whole-graph op', async () => {
    const r = await caller.getResolvedForkGraph(input)
    expect(r).toEqual({
      graph: resolveForkGraph({
        baseBranchCommits: BASE,
        baseBranchName: 'main',
        featureBranchCommits: FEATURE,
        featureBranchName: 'feat',
        forkPoint: mergeBase!,
        preForkCommits: PRE
      }),
      forkPoint: mergeBase,
      featureCount: 3,
      baseCount: 5
    })
    const ops = sent.map((s) => s.op)
    expect(ops).not.toContain('getResolvedForkGraph')
    expect(ops.filter((o) => o === 'getCommitsSincePage').length).toBe(5) // 3 + 2 pages
    expect(sent.find((s) => s.op === 'getMergeBase')?.input).toEqual({
      path: '/w/repo',
      branch1: 'feat',
      branch2: 'main'
    })
  })

  test('the upstream graph is the fork graph against <branch>@{upstream}, built the same way', async () => {
    const r = await caller.getResolvedUpstreamGraph({
      repoPath: '/w/repo',
      branch: 'feat',
      target: { taskId: 't1' }
    })
    expect(sent.map((s) => s.op)).not.toContain('getResolvedUpstreamGraph')
    expect(sent.find((s) => s.op === 'getMergeBase')?.input).toEqual({
      path: '/w/repo',
      branch1: 'feat',
      branch2: 'feat@{upstream}'
    })
    expect(r?.graph.baseBranch).toBe('origin/feat')
  })

  test('no merge base: null, as the whole op answers', async () => {
    mergeBase = null
    expect(await caller.getResolvedForkGraph(input)).toBeNull()
  })

  test('getCommitsSince keeps its whole answer, read in pages', async () => {
    const all = await caller.getCommitsSince({
      path: '/w/repo',
      sinceRef: 'x',
      branch: 'main',
      target: { taskId: 't1' }
    })
    expect(all).toEqual(BASE)
    expect(sent.map((s) => s.op)).toEqual([
      'getCommitsSincePage',
      'getCommitsSincePage',
      'getCommitsSincePage'
    ])
  })
})

describe('an older computer', () => {
  test('gets the whole-answer ops', async () => {
    bounded = false
    expect(await caller.getResolvedForkGraph(input)).toEqual({ whole: 'getResolvedForkGraph' })
    expect(
      await caller.getCommitsSince({
        path: '/w/repo',
        sinceRef: 'x',
        branch: 'main',
        target: { taskId: 't1' }
      })
    ).toEqual({ whole: 'getCommitsSince' })
  })
})
