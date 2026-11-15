/**
 * Paged git text through the hub (`worktrees.readGitText`): a computer that answers
 * bounded reads gets the op itself; an older computer gets the whole-text op it
 * knows (`getFileDiff`, `getUntrackedFileDiff`, `getStashDiff`), answered as one
 * last page — the panel has one code path. `getFileDiffsPage` only ever follows a
 * paged snapshot (a new computer) and goes straight through.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { worktreesRouter } from './worktrees-router'
import { setWorktreesRouterDeps } from './worktrees-router-deps'
import { setGitOpTransport } from './git-op-routing'

const sent: Array<{ op: string; input: unknown }> = []
let bounded = true

beforeAll(() => {
  setWorktreesRouterDeps({
    getWorkspace: () => ({ fs: {} as never, resolveComputer: async () => 'computer-1' }),
    shellOpenPath: async () => ''
  })
  setGitOpTransport({
    supports: (_id, feature) => feature === 'boundedReads' && bounded,
    request: async (_computerId, params) => {
      sent.push({ op: params.op, input: params.input })
      if (params.op === 'readGitText') return { text: 'page', cursor: 'c:1', totalBytes: 99 }
      if (params.op === 'getFileDiffsPage') return { diffs: {}, deferred: [], large: [] }
      return 'whole ✓'
    },
    watchStart: async () => undefined,
    watchStop: async () => undefined
  })
})
afterEach(() => {
  sent.length = 0
  bounded = true
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

describe('a computer that answers bounded reads', () => {
  test('readGitText and getFileDiffsPage go to it as git.op requests', async () => {
    const page = await caller.readGitText({
      repoPath: '/w/r',
      kind: 'fileDiff',
      filePath: 'a.txt',
      staged: false,
      cursor: null,
      target
    })
    expect(page).toEqual({ text: 'page', cursor: 'c:1', totalBytes: 99 })
    await caller.getFileDiffsPage({
      repoPath: '/w/r',
      kind: 'staged',
      filePaths: ['a.txt'],
      target
    })
    expect(sent.map((s) => s.op)).toEqual(['readGitText', 'getFileDiffsPage'])
  })
})

describe('an older computer (no boundedReads)', () => {
  test.each([
    [
      { kind: 'fileDiff' as const, filePath: 'a.txt', staged: true, opts: { contextLines: '3' } },
      {
        op: 'getFileDiff',
        input: { repoPath: '/w/r', filePath: 'a.txt', staged: true, opts: { contextLines: '3' } }
      }
    ],
    [
      { kind: 'untrackedDiff' as const, filePath: 'n.txt' },
      { op: 'getUntrackedFileDiff', input: { repoPath: '/w/r', filePath: 'n.txt' } }
    ],
    [
      { kind: 'stashDiff' as const, index: 2 },
      { op: 'getStashDiff', input: { repoPath: '/w/r', index: 2 } }
    ]
  ])('%o is its whole-text op, answered as one last page', async (source, expected) => {
    bounded = false
    const page = await caller.readGitText({ repoPath: '/w/r', cursor: null, target, ...source })
    expect(sent).toEqual([expected])
    expect(page).toEqual({
      text: 'whole ✓',
      cursor: null,
      totalBytes: Buffer.byteLength('whole ✓')
    })
  })

  test('a range file diff or a cursor cannot be served by it: a clear error', async () => {
    bounded = false
    await expect(
      caller.readGitText({
        repoPath: '/w/r',
        kind: 'rangeFileDiff',
        filePath: 'a.txt',
        fromSha: 'abcd',
        toSha: 'abce',
        cursor: null,
        target
      })
    ).rejects.toThrow(/update/)
    await expect(
      caller.readGitText({ repoPath: '/w/r', kind: 'stashDiff', index: 0, cursor: 'x:1', target })
    ).rejects.toThrow(/GIT_TEXT_EXPIRED/)
  })
})
