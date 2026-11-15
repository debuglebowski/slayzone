/**
 * The copy dialog's lazy ignored-file tree through the hub (`worktrees.openIgnoredTree`
 * / `listIgnoredTree` / `matchIgnoredTree`):
 *  - a computer that answers bounded reads (`boundedReads`) gets the three ops as
 *    `git.op` requests — every reply one bounded page;
 *  - an older computer gets the whole-tree op it knows (`getIgnoredFileTree`) once;
 *    the hub holds that tree's index under a `hub:` id and answers the pages
 *    itself, so the dialog has one code path. A hub-held id is bound to the scope
 *    and repo that opened it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { IgnoredFileNode } from '../shared/types'
import { worktreesRouter } from './worktrees-router'
import { setWorktreesRouterDeps } from './worktrees-router-deps'
import { setGitOpTransport } from './git-op-routing'

const sent: Array<{ op: string; input: unknown }> = []
let bounded = true

const file = (path: string, size = 0): IgnoredFileNode => ({
  name: path.split('/').pop()!,
  path,
  isDirectory: false,
  size,
  fileCount: 1,
  children: []
})
const OLD_TREE: IgnoredFileNode[] = [
  {
    name: 'node_modules',
    path: 'node_modules',
    isDirectory: true,
    size: 0,
    fileCount: 2,
    children: [file('node_modules/a.js'), file('node_modules/.env')]
  },
  file('.env', 7)
]

beforeAll(() => {
  setWorktreesRouterDeps({
    getWorkspace: () => ({ fs: {} as never, resolveComputer: async () => 'computer-1' }),
    shellOpenPath: async () => ''
  })
  setGitOpTransport({
    supports: (computerId, feature) =>
      computerId === 'computer-1' && feature === 'boundedReads' && bounded,
    request: async (_computerId, params) => {
      sent.push({ op: params.op, input: params.input })
      if (params.op === 'getIgnoredFileTree') return OLD_TREE
      if (params.op === 'openIgnoredTree')
        return { treeId: 'c-tree', totalFiles: 0, root: { items: [], nextCursor: null } }
      return { items: [], nextCursor: null }
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
    sql.includes('FROM projects')
      ? { id: params?.[0] }
      : params?.[0] === 't1' || params?.[0] === 't2'
        ? { project_id: 'p1' }
        : undefined,
  all: async () => [],
  prepare: () => ({ get: async () => undefined, all: async () => [] })
}
const caller = worktreesRouter.createCaller({ db: db as never, dataRoot: '' } as never)
const target = { taskId: 't1' }

describe('a computer that answers bounded reads', () => {
  test('gets the three ops as git.op requests', async () => {
    const opened = await caller.openIgnoredTree({ repoPath: '/w/repo', target })
    expect(opened.treeId).toBe('c-tree')
    await caller.listIgnoredTree({
      repoPath: '/w/repo',
      treeId: 'c-tree',
      dir: 'a',
      cursor: null,
      target
    })
    await caller.matchIgnoredTree({
      repoPath: '/w/repo',
      treeId: 'c-tree',
      globs: ['.env'],
      cursor: '5',
      target
    })
    expect(sent).toEqual([
      { op: 'openIgnoredTree', input: { repoPath: '/w/repo' } },
      {
        op: 'listIgnoredTree',
        input: { repoPath: '/w/repo', treeId: 'c-tree', dir: 'a', cursor: null }
      },
      {
        op: 'matchIgnoredTree',
        input: { repoPath: '/w/repo', treeId: 'c-tree', globs: ['.env'], cursor: '5' }
      }
    ])
  })
})

describe('an older computer (no boundedReads)', () => {
  test('one whole-tree request; the hub answers every page from its index', async () => {
    bounded = false
    const opened = await caller.openIgnoredTree({ repoPath: '/w/repo', target })
    expect(sent).toEqual([{ op: 'getIgnoredFileTree', input: { repoPath: '/w/repo' } }])
    expect(opened.treeId.startsWith('hub:')).toBe(true)
    expect(opened.totalFiles).toBe(3)
    expect(opened.root.items.map((e) => [e.path, e.fileCount, e.size])).toEqual([
      ['node_modules', 2, 0],
      ['.env', 1, 7]
    ])
    sent.length = 0
    const page = await caller.listIgnoredTree({
      repoPath: '/w/repo',
      treeId: opened.treeId,
      dir: 'node_modules',
      cursor: null,
      target
    })
    expect(page.items.map((e) => e.path)).toEqual(['node_modules/.env', 'node_modules/a.js'])
    const sel = await caller.matchIgnoredTree({
      repoPath: '/w/repo',
      treeId: opened.treeId,
      globs: ['.env'],
      cursor: null,
      target
    })
    expect(sel.items.map((m) => m.path)).toEqual(['.env', 'node_modules/.env'])
    expect(sent).toEqual([])
  })

  test('a hub-held id answers only its own scope and repo', async () => {
    bounded = false
    const { treeId } = await caller.openIgnoredTree({ repoPath: '/w/repo', target })
    await expect(
      caller.listIgnoredTree({ repoPath: '/w/other', treeId, dir: '', cursor: null, target })
    ).rejects.toThrow(/IGNORED_TREE_EXPIRED/)
    await expect(
      caller.listIgnoredTree({
        repoPath: '/w/repo',
        treeId,
        dir: '',
        cursor: null,
        target: { taskId: 't2' }
      })
    ).rejects.toThrow(/IGNORED_TREE_EXPIRED/)
  })
})
