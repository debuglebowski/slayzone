/**
 * Every write that changes what a client shows for a task tells the other clients:
 * `notify.onTasksChanged` naming the tasks (`TasksChange`). These mutations used to
 * emit nothing, so a change made on one client (desktop, phone, web) only appeared on
 * another after an unrelated refresh:
 *
 *   task       reorder, reorderPinned (the rows that moved), addBlocker, removeBlocker,
 *              setBlockers
 *   tags       setForTask (the task); create, update, delete, reorder (a full board reload:
 *              a project's tags show on every card and filter)
 *   artifacts  every write that changes `artifacts.getByTask` / `foldersGetByTask` —
 *              the per-task queries clients refresh on this very signal
 *
 * Through the real `appRouter`, wired as the hub wires it: the task router's
 * `onMutation` is the notify bus (composition.ts `setTaskDeps`), the tags and
 * artifacts seams are api's (`domain-router-deps.ts`). Each write's own signal is read
 * off the bus; the last block checks the subscription a client holds merges a burst.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/task-change-signals.test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { beforeEach, describe, expect, test } from 'vitest'
import { TypedEmitter } from '@slayzone/platform/events'
import type { TasksChange } from '@slayzone/task-contracts'
import { setTaskDeps, taskOps } from '@slayzone/task/server'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { appRouter } from '../router'
import { setNotifyEvents, type NotifyEventMap } from '../app-deps'

const h = await createTestHarness()
const dataRoot = mkdtempSync(join(tmpdir(), 'task-change-signals-'))
const notifyEvents = new TypedEmitter<NotifyEventMap>()
setNotifyEvents(notifyEvents)
// As composition.ts: task ops signal on the notify bus.
setTaskDeps({ ops: taskOps, onMutation: (change) => notifyEvents.emit('tasks-changed', change) })

const caller = appRouter.createCaller({ db: h.slayDb, dataRoot } as never)

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
function seedTask(title: string): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, title, 'inbox', 3, 0)
  return id
}
const [a, b, c] = [seedTask('A'), seedTask('B'), seedTask('C')]

/** Every `tasks-changed` signal, in order; `null` = one that named no tasks. */
let signals: Array<string[] | null> = []
notifyEvents.on('tasks-changed', (change?: TasksChange) => {
  signals.push(change ? [...change.taskIds].sort() : null)
})
beforeEach(() => {
  signals = []
})
const sorted = (...ids: string[]): string[] => [...ids].sort()

describe('task: order and blockers', () => {
  test('reorder names the rows whose order changed', async () => {
    // Every seeded row sits at order 0: c keeps its place, a and b move.
    await caller.task.reorder({ taskIds: [c, a, b] })
    expect(signals).toEqual([sorted(a, b)])
    signals = []
    await caller.task.reorder({ taskIds: [a, c, b] })
    expect(signals).toEqual([sorted(a, c)])
    signals = []
    // Nothing moved, nothing to patch.
    await caller.task.reorder({ taskIds: [a, c, b] })
    expect(signals).toEqual([])
  })

  test('reorderPinned names the rows it pinned or moved', async () => {
    await caller.task.reorderPinned({ taskIds: [b, a] })
    expect(signals).toEqual([sorted(a, b)])
    signals = []
    await caller.task.reorderPinned({ taskIds: [b, a, c] })
    expect(signals).toEqual([[c]])
  })

  test('addBlocker / removeBlocker name the blocked task and its blocker', async () => {
    await caller.task.addBlocker({ taskId: a, blockerTaskId: b })
    expect(signals).toEqual([sorted(a, b)])
    signals = []
    await caller.task.removeBlocker({ taskId: a, blockerTaskId: b })
    expect(signals).toEqual([sorted(a, b)])
  })

  test('setBlockers names the task, the blockers it lost and the ones it gained', async () => {
    await caller.task.addBlocker({ taskId: a, blockerTaskId: b })
    signals = []
    await caller.task.setBlockers({ taskId: a, blockerTaskIds: [c] })
    expect(signals).toEqual([sorted(a, b, c)])
    expect(await caller.task.getBlockers({ taskId: a })).toHaveLength(1)
    signals = []
    await caller.task.setBlockers({ taskId: a, blockerTaskIds: [] })
    expect(signals).toEqual([sorted(a, c)])
  })
})

describe('tags', () => {
  test('setForTask names the task', async () => {
    const tag = await caller.tags.create({ name: 'bug', projectId })
    signals = []
    await caller.tags.setForTask({ taskId: a, tagIds: [tag.id] })
    expect(signals).toEqual([[a]])
  })

  test('create, update, delete and reorder each reload the whole board', async () => {
    const tag = await caller.tags.create({ name: 'feature', projectId, color: '#111111' })
    expect(signals).toEqual([null])
    const other = await caller.tags.create({ name: 'chore', projectId, color: '#222222' })
    signals = []
    await caller.tags.update({ id: tag.id, name: 'feat' })
    expect(signals).toEqual([null])
    signals = []
    await caller.tags.reorder({ tagIds: [other.id, tag.id] })
    expect(signals).toEqual([null])
    signals = []
    await caller.tags.delete({ id: other.id })
    expect(signals).toEqual([null])
  })
})

describe('artifacts', () => {
  const create = (title: string, content = 'x') =>
    caller.artifacts.create({ taskId: b, title, content } as never)

  test('create, delete and reorder name the task', async () => {
    const one = await create('one.md')
    const two = await create('two.md')
    expect(signals).toEqual([[b], [b]])
    signals = []
    await caller.artifacts.reorder([two!.id, one!.id])
    expect(signals).toEqual([[b]])
    signals = []
    expect(await caller.artifacts.delete({ id: one!.id })).toBe(true)
    expect(signals).toEqual([[b]])
  })

  test('a delete or reorder of nothing signals nothing', async () => {
    expect(await caller.artifacts.delete({ id: 'missing' })).toBe(false)
    await caller.artifacts.reorder([])
    expect(signals).toEqual([])
  })

  test('update signals when the listed row changed, not for a content-only autosave', async () => {
    const art = await create('notes.md', 'v1')
    signals = []
    // The editor's autosave: same row in `getByTask` (the working copy is not in it,
    // and an unnamed tip version is mutated in place). The file watcher covers it.
    await caller.artifacts.update({ id: art!.id, content: 'v2', mutateVersion: true } as never)
    expect(signals).toEqual([])
    await caller.artifacts.update({ id: art!.id, title: 'renamed.md' } as never)
    expect(signals).toEqual([[b]])
  })

  test('uploads and pastes name the task they land in', async () => {
    const src = join(dataRoot, 'src')
    mkdirSync(join(src, 'dir'), { recursive: true })
    writeFileSync(join(src, 'file.txt'), 'hello')
    writeFileSync(join(src, 'dir', 'inner.txt'), 'inner')

    await caller.artifacts.uploadBlob({ taskId: b, title: 'blob.bin', bytes: new Uint8Array([1]) })
    await caller.artifacts.upload({ taskId: b, sourcePath: join(src, 'file.txt') })
    await caller.artifacts.uploadDir({
      taskId: b,
      dirPath: join(src, 'dir'),
      parentFolderId: null
    })
    await caller.artifacts.pasteFiles({
      sourcePaths: [join(src, 'file.txt')],
      destTaskId: c,
      destFolderId: null
    })
    expect(signals).toEqual([[b], [b], [b], [c]])
  })

  test('versions that move the current pointer name the task', async () => {
    const art = await create('versioned.md', 'one')
    await caller.artifacts.update({ id: art!.id, content: 'two', mutateVersion: false } as never)
    signals = []
    await caller.artifacts.versionsCreate({ artifactId: art!.id, name: 'kept' })
    expect(signals).toEqual([[b]])
    signals = []
    await caller.artifacts.versionsSetCurrent({ artifactId: art!.id, versionRef: 1 })
    expect(signals).toEqual([[b]])
  })

  test('folder writes name the task', async () => {
    const f1 = await caller.artifacts.foldersCreate({ taskId: b, name: 'F1' } as never)
    const f2 = await caller.artifacts.foldersGetOrCreateByName({ taskId: b, name: 'F2' })
    await caller.artifacts.foldersUpdate({ id: f1!.id, name: 'F1b' } as never)
    await caller.artifacts.foldersReorder({ parentId: null, folderIds: [f2!.id, f1!.id] })
    await caller.artifacts.foldersDelete({ id: f2!.id })
    expect(signals).toEqual([[b], [b], [b], [b], [b]])
  })
})

describe('the client subscription', () => {
  test('a drag (moved row + its column order) reaches a client as a merged burst, not one refetch per write', async () => {
    const got: Array<string[] | null> = []
    const obs = (await caller.notify.onTasksChanged()) as unknown as {
      subscribe: (o: { next: (v: { taskIds: string[] | null }) => void }) => {
        unsubscribe: () => void
      }
    }
    const sub = obs.subscribe({ next: (v) => got.push(v.taskIds ? [...v.taskIds].sort() : null) })
    // The desktop's drop: `task.update` for the moved row, then `task.reorder` for
    // its column, back to back.
    await caller.task.update({ id: a, title: 'A moved' } as never)
    await caller.task.reorder({ taskIds: [b, a, c] })
    await caller.task.addBlocker({ taskId: c, blockerTaskId: b })
    await new Promise((r) => setTimeout(r, 300))
    sub.unsubscribe()
    // The first signal of a quiet period at once, the rest merged into one.
    expect(got).toEqual([[a], sorted(a, b, c)])
  })
})
