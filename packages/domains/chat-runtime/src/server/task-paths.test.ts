/**
 * A task's worktree path and base dir live on its computer (robustness plan §9, P0;
 * Phase 7a, hub migration v210). The computer runs the writes (set, inherit from a
 * parent, clear on archive), keeps a newer write over an older one, takes the hub's
 * rows once (`task-path` handoff), answers reads, forgets a deleted task's row, and
 * names the roots a task or project scope confines paths to.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openChatStorage } from './storage'
import { createComputerTaskData } from './task-data'
import { createTaskPaths, scopeBounds, taskPathImport } from './task-paths'

const roots: string[] = []
const stores: Array<ReturnType<typeof openChatStorage>> = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function open() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slz-task-paths-')))
  roots.push(dir)
  const s = openChatStorage({ stateDir: dir, hubScope: 'hub' })
  stores.push(s)
  return s
}

describe('task paths on the computer', () => {
  test('set keeps unspecified fields, a stale write never wins', () => {
    const storage = open()
    const paths = createTaskPaths(storage)
    paths.handle({ op: 'set', taskId: 't', projectId: 'p', worktreePath: '/w/a', at: 10 })
    paths.handle({ op: 'set', taskId: 't', projectId: 'p', baseDir: '/b', at: 11 })
    expect(paths.get('t')).toEqual({
      taskId: 't',
      projectId: 'p',
      worktreePath: '/w/a',
      baseDir: '/b',
      at: 11
    })
    // Older than what is stored: ignored.
    paths.handle({ op: 'set', taskId: 't', projectId: 'p', worktreePath: '/w/old', at: 5 })
    expect(paths.get('t')?.worktreePath).toBe('/w/a')
    // Explicit null clears one field.
    paths.handle({ op: 'set', taskId: 't', projectId: 'p', worktreePath: null, at: 12 })
    expect(paths.get('t')).toMatchObject({ worktreePath: null, baseDir: '/b' })
  })

  test('byWorktree: the task whose worktree a folder is (usage attribution, §9 7c)', () => {
    const paths = createTaskPaths(open())
    paths.handle({ op: 'set', taskId: 'a', projectId: 'p', worktreePath: '/w/a', at: 1 })
    paths.handle({ op: 'set', taskId: 'b', projectId: 'p', worktreePath: '/w/shared', at: 1 })
    paths.handle({ op: 'set', taskId: 'c', projectId: 'p', worktreePath: '/w/shared', at: 1 })
    paths.handle({ op: 'set', taskId: 'd', projectId: 'p', baseDir: '/w/base', at: 1 })
    // A shared worktree goes to the task that held it first; a base dir is not a worktree.
    expect(paths.byWorktree(['/w/a', '/w/shared', '/w/base', '/nope'])).toEqual({
      '/w/a': 'a',
      '/w/shared': 'b'
    })
  })

  test("inherit copies the parent's paths on this computer", () => {
    const storage = open()
    const paths = createTaskPaths(storage)
    paths.handle({
      op: 'set',
      taskId: 'parent',
      projectId: 'p',
      worktreePath: '/w/x',
      baseDir: '/b',
      at: 1
    })
    expect(
      paths.handle({
        op: 'inherit',
        taskId: 'child',
        parentTaskId: 'parent',
        projectId: 'p',
        at: 2
      })
    ).toEqual({ inherited: true })
    expect(paths.get('child')).toMatchObject({ worktreePath: '/w/x', baseDir: '/b' })
    // A parent this computer does not hold: nothing copied, the caller is told.
    expect(
      paths.handle({ op: 'inherit', taskId: 'c2', parentTaskId: 'nope', projectId: 'p', at: 3 })
    ).toEqual({ inherited: false })
    expect(paths.get('c2')).toBeNull()
  })

  test('clear (archive) blanks both paths and fences older writes', () => {
    const storage = open()
    const paths = createTaskPaths(storage)
    paths.handle({
      op: 'set',
      taskId: 't',
      projectId: 'p',
      worktreePath: '/w',
      baseDir: '/b',
      at: 1
    })
    paths.handle({ op: 'clear', taskId: 't', at: 5 })
    expect(paths.get('t')).toMatchObject({ worktreePath: null, baseDir: null, at: 5 })
    paths.handle({ op: 'set', taskId: 't', projectId: 'p', worktreePath: '/w', at: 4 })
    expect(paths.get('t')?.worktreePath).toBeNull()
  })

  test('get answers many tasks; a deleted task writes nothing and is forgotten', () => {
    const storage = open()
    const paths = createTaskPaths(storage)
    paths.handle({ op: 'set', taskId: 'a', projectId: 'p', worktreePath: '/a', at: 1 })
    paths.handle({ op: 'set', taskId: 'b', projectId: 'p', baseDir: '/b', at: 1 })
    expect(paths.handle({ op: 'get', taskIds: ['a', 'b', 'c'] })).toEqual([
      { taskId: 'a', projectId: 'p', worktreePath: '/a', baseDir: null, at: 1 },
      { taskId: 'b', projectId: 'p', worktreePath: null, baseDir: '/b', at: 1 }
    ])
    storage.applyTaskLifecycle('a', 'deleted', 1)
    expect(paths.get('a')).toBeNull()
    paths.handle({ op: 'set', taskId: 'a', projectId: 'p', worktreePath: '/a2', at: 9 })
    expect(paths.get('a')).toBeNull()
  })

  test('release names the worktree and whether a live task shares it; a purged one waits for forget', () => {
    const storage = open()
    let now = 1000
    const paths = createTaskPaths(storage, () => now)
    paths.handle({ op: 'set', taskId: 'a', projectId: 'p', worktreePath: '/w/s', at: 1 })
    paths.handle({ op: 'set', taskId: 'b', projectId: 'p', worktreePath: '/w/s', at: 1 })
    paths.handle({ op: 'set', taskId: 'c', projectId: 'p', baseDir: '/c', at: 1 })
    // Shared only with a task the hub counts live.
    expect(paths.handle({ op: 'release', taskId: 'a', liveTaskIds: ['b'] })).toEqual({
      worktreePath: '/w/s',
      shared: true
    })
    expect(paths.handle({ op: 'release', taskId: 'a', liveTaskIds: ['c'] })).toEqual({
      worktreePath: '/w/s',
      shared: false
    })
    expect(paths.handle({ op: 'release', taskId: 'c', liveTaskIds: [] })).toEqual({
      worktreePath: null,
      shared: false
    })
    // Purged here: the path waits for the hub to remove the checkout.
    storage.applyTaskLifecycle('a', 'deleted', 1)
    expect(paths.get('a')).toBeNull()
    expect(paths.handle({ op: 'release', taskId: 'a', liveTaskIds: [] })).toEqual({
      worktreePath: '/w/s',
      shared: false
    })
    paths.handle({ op: 'forget', taskId: 'a' })
    expect(paths.handle({ op: 'release', taskId: 'a', liveTaskIds: [] })).toEqual({
      worktreePath: null,
      shared: false
    })
    // Never kept forever: an unclaimed release expires.
    storage.applyTaskLifecycle('b', 'deleted', 1)
    now += 31 * 24 * 60 * 60_000
    paths.handle({ op: 'forget', taskId: 'other' })
    expect(paths.handle({ op: 'release', taskId: 'b', liveTaskIds: [] })).toEqual({
      worktreePath: null,
      shared: false
    })
  })

  test('a staged inherit copies the parent row held here', () => {
    const storage = open()
    const paths = createTaskPaths(storage)
    paths.handle({ op: 'set', taskId: 'parent', projectId: 'p', worktreePath: '/w/p', at: 1 })
    const data = createComputerTaskData({
      storage,
      computerId: 'c1',
      imports: { 'task-path': taskPathImport },
      providerConfig: () => ({}),
      taskPath: paths.get
    })
    data.importBatch({
      kind: 'task-path',
      items: [
        { key: 'child', taskId: 'child', value: { projectId: 'p', inheritFrom: 'parent', at: 2 } }
      ]
    })
    expect(paths.get('child')).toMatchObject({ worktreePath: '/w/p', baseDir: null })
  })

  test('the hub hand-off is idempotent and keeps a newer local row', () => {
    const storage = open()
    const paths = createTaskPaths(storage)
    const data = createComputerTaskData({
      storage,
      computerId: 'c1',
      imports: { 'task-path': taskPathImport },
      providerConfig: () => ({}),
      taskPath: paths.get
    })
    const batch = {
      kind: 'task-path',
      items: [
        {
          key: 't',
          taskId: 't',
          value: { projectId: 'p', worktreePath: '/w', baseDir: null, at: 3 }
        }
      ]
    }
    expect(data.importBatch(batch).applied).toEqual(['t'])
    expect(data.importBatch(batch).applied).toEqual(['t'])
    expect(paths.get('t')).toMatchObject({ worktreePath: '/w', at: 3 })
    paths.handle({ op: 'set', taskId: 't', projectId: 'p', worktreePath: '/newer', at: 7 })
    data.importBatch(batch)
    expect(paths.get('t')?.worktreePath).toBe('/newer')
    expect(data.read('t', { kind: 'taskPath' })).toMatchObject({ worktreePath: '/newer' })
    // A relative path is refused: every stored path is absolute.
    expect(
      data.importBatch({
        kind: 'task-path',
        items: [
          {
            key: 'r',
            taskId: 'r',
            value: { projectId: 'p', worktreePath: 'rel', baseDir: null, at: 1 }
          }
        ]
      }).rejected
    ).toHaveLength(1)
  })

  test('scope bounds: own root (worktree, base dir, project folder), other tasks carved out', () => {
    const storage = open()
    const paths = createTaskPaths(storage)
    const folder = (id: string) => (id === 'p' ? '/proj' : null)
    paths.handle({
      op: 'set',
      taskId: 'w',
      projectId: 'p',
      worktreePath: '/proj/.wt/w',
      baseDir: '/b',
      at: 1
    })
    paths.handle({ op: 'set', taskId: 'b', projectId: 'p', baseDir: '/b', at: 1 })
    paths.handle({ op: 'set', taskId: 'n', projectId: 'p', at: 1 })
    const bounds = (scope: Parameters<typeof scopeBounds>[1]) => scopeBounds(paths, scope, folder)
    // Own roots (worktree, and the base dir the user chose too) + the project's
    // checkout it belongs to.
    expect(bounds({ kind: 'task', taskId: 'w', projectId: 'p' }).roots).toEqual([
      '/proj/.wt/w',
      '/b',
      '/proj'
    ])
    expect(bounds({ kind: 'task', taskId: 'b', projectId: 'p' }).roots).toEqual(['/b', '/proj'])
    // A task in its project's folder: every other task's WORKTREE (a separate
    // checkout) is carved out; another task's base dir is a plain folder of the
    // project, not carved out (S4) — but still foreign to a NEW root.
    paths.handle({ op: 'set', taskId: 'c', projectId: 'p', baseDir: '/proj/payments', at: 1 })
    const n = bounds({ kind: 'task', taskId: 'n', projectId: 'p' })
    expect(n.roots).toEqual(['/proj'])
    expect(n.excluded).toEqual(['/proj/.wt/w'])
    expect(n.foreign).toEqual(expect.arrayContaining(['/proj/.wt/w', '/b', '/proj/payments']))
    // No row here: the project the hub names, never another task's, never the computer's.
    expect(bounds({ kind: 'task', taskId: 'x', projectId: 'p' }).roots).toEqual(['/proj'])
    expect(bounds({ kind: 'task', taskId: 'x', projectId: null }).roots).toEqual([])
    // A project: its folder first, then every root of its tasks held here (B1).
    expect(bounds({ kind: 'project', projectId: 'p' })).toEqual({
      roots: ['/proj', '/proj/.wt/w', '/b', '/proj/payments'],
      excluded: [],
      foreign: []
    })
    expect(bounds({ kind: 'project', projectId: 'q' }).roots).toEqual([])
  })

  test("B1: a project scope covers its worktree bases and its tasks' roots, never another project's", () => {
    const storage = open()
    const paths = createTaskPaths(storage)
    const folders: Record<string, string> = { app: '/dev/app', other: '/dev/other' }
    const bounds = (projectId: string, bases = (_: string, f: string) => [`${f}-workspaces`]) =>
      scopeBounds(
        paths,
        { kind: 'project', projectId },
        (id) => folders[id] ?? null,
        () => Object.entries(folders).map(([projectId, path]) => ({ projectId, path })),
        bases
      )
    // Task worktrees of `app` in its default base, and one elsewhere (a configured base
    // that later changed); a task of `other` whose worktree landed in app's base dir.
    paths.handle({
      op: 'set',
      taskId: 'a1',
      projectId: 'app',
      worktreePath: '/dev/app-workspaces/feat',
      at: 1
    })
    paths.handle({ op: 'set', taskId: 'a2', projectId: 'app', worktreePath: '/wt/app/fix', at: 1 })
    paths.handle({
      op: 'set',
      taskId: 'o1',
      projectId: 'other',
      worktreePath: '/dev/app-workspaces/theirs',
      at: 1
    })
    const app = bounds('app')
    // Folder first (a project process with no cwd starts there), then the bases and
    // the project's tasks' roots.
    expect(app.roots).toEqual([
      '/dev/app',
      '/dev/app-workspaces',
      '/dev/app-workspaces/feat',
      '/wt/app/fix'
    ])
    // Another project's folder and task roots are carved out of the extra roots…
    expect(app.excluded).toEqual(
      expect.arrayContaining(['/dev/other', '/dev/app-workspaces/theirs'])
    )
    expect(app.foreign).toEqual(
      expect.arrayContaining(['/dev/other', '/dev/app-workspaces/theirs'])
    )
    expect(app.roots).not.toContain('/dev/app-workspaces/theirs')
    // …never inside the project's own folder (S5: a project nested in it stays the outer's).
    folders.web = '/dev/app/web'
    expect(bounds('app').excluded).not.toContain('/dev/app/web')
    // Not placed here: nothing, whatever its tasks hold.
    expect(bounds('ghost').roots).toEqual([])
    delete folders.app
    expect(bounds('app').roots).toEqual([])
  })
})
