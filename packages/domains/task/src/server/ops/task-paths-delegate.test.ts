/**
 * A task's worktree path and base dir live only on the computer holding its folders
 * (robustness plan §9, P0; 7a, 7e — the hub keeps only `has_worktree` / `has_base_dir`).
 * A path the USER sets is written there first (`apply`): refused or away, the update
 * fails and the hub records nothing. Every other writer reports AFTER its flag write
 * — inherit (a subtask), clear (archive, one or many), a project change's clears — and
 * a delegate that fails never fails that write.
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import crypto from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { archiveManyTasksOp } from './archive-many.js'
import { archiveTaskOp } from './archive.js'
import { createTaskOp } from './create.js'
import {
  configureTaskRuntimeAdapters,
  setTaskPathsDelegate,
  type TaskPathChange,
  readTaskPaths,
  updateTask
} from './shared.js'
import { getTaskOp } from './get.js'
import { taskEvents } from '../events.js'

afterEach(() => setTaskPathsDelegate(null))

type Seen = { taskId: string; op: string; change: unknown; flags: unknown }

async function setup() {
  const h = await createTestHarness()
  const root = h.tmpDir()
  configureTaskRuntimeAdapters({
    getDataRoot: () => root,
    killPtysByTaskId: () => {},
    removeTaskProcesses: () => {},
    // No worktree is removed here (the computer's job; not under test).
    worktreeRootForTask: async () => null
  })
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, columns_config) VALUES (?, ?, ?, ?)')
    .run(projectId, 'Proj', '#000', JSON.stringify([]))
  const seen: Seen[] = []
  const flags = (taskId: string) =>
    h.db.prepare('SELECT has_worktree, has_base_dir FROM tasks WHERE id=?').get(taskId)
  const state = { away: false }
  setTaskPathsDelegate({
    async changed(taskId, change) {
      seen.push({ taskId, op: 'changed', change, flags: flags(taskId) })
    },
    async apply(taskId, patch) {
      if (state.away) throw new Error('computer away')
      seen.push({ taskId, op: 'apply', change: patch, flags: flags(taskId) })
      // As the hub's delegate: '' is unset; what it wrote is the answer.
      return Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [key, value === '' ? null : value])
      )
    },
    read: async () => ({}),
    release: async () => ({ worktreePath: null, shared: false, computerId: 'pc' }),
    forget: async () => {}
  })
  return { h, projectId, seen, state }
}

test('a user path is written on the computer FIRST; inherit and archive follow the flag write', async () => {
  const { h, projectId, seen } = await setup()
  try {
    const parent = (await createTaskOp(h.slayDb, { projectId, title: 'P' }, {}))!
    seen.length = 0
    const updated = await updateTask(h.slayDb, { id: parent.id, worktreePath: '/w/p' })
    // Applied before the hub recorded anything: the flag was still unset.
    expect(seen).toEqual([
      {
        taskId: parent.id,
        op: 'apply',
        change: { worktreePath: '/w/p' },
        flags: { has_worktree: 0, has_base_dir: 0 }
      }
    ])
    expect(updated?.has_worktree).toBe(true)
    const child = (await createTaskOp(
      h.slayDb,
      { projectId, title: 'C', parentId: parent.id },
      {}
    ))!
    expect(seen.at(-1)).toEqual({
      taskId: child.id,
      op: 'changed',
      change: { op: 'inherit', parentTaskId: parent.id },
      flags: { has_worktree: 1, has_base_dir: 0 }
    })
    seen.length = 0
    await archiveTaskOp(h.slayDb, parent.id, {})
    expect(seen.map((s) => [s.taskId, (s.change as TaskPathChange).op]).sort()).toEqual(
      [
        [parent.id, 'clear'],
        [child.id, 'clear']
      ].sort()
    )
    for (const s of seen) expect(s.flags).toEqual({ has_worktree: 0, has_base_dir: 0 })
    const other = (await createTaskOp(h.slayDb, { projectId, title: 'O' }, {}))!
    seen.length = 0
    await archiveManyTasksOp(h.slayDb, [other.id], {})
    expect(seen.map((s) => [s.taskId, s.change])).toEqual([[other.id, { op: 'clear' }]])
  } finally {
    h.cleanup()
  }
})

test('a user path with its computer away fails the update and records nothing', async () => {
  const { h, projectId, state } = await setup()
  try {
    const task = (await createTaskOp(h.slayDb, { projectId, title: 'T' }, {}))!
    state.away = true
    await expect(updateTask(h.slayDb, { id: task.id, baseDir: '/custom' })).rejects.toThrow(
      'computer away'
    )
    expect(h.db.prepare('SELECT has_base_dir FROM tasks WHERE id=?').get(task.id)).toEqual({
      has_base_dir: 0
    })
  } finally {
    h.cleanup()
  }
})

test('a title-only update does not touch paths; a failing hand-over never fails a clear', async () => {
  const { h, projectId, seen } = await setup()
  try {
    const task = (await createTaskOp(h.slayDb, { projectId, title: 'T' }, {}))!
    seen.length = 0
    await updateTask(h.slayDb, { id: task.id, title: 'Renamed' })
    expect(seen).toEqual([])
    await updateTask(h.slayDb, { id: task.id, baseDir: '/custom' })
    setTaskPathsDelegate({
      changed: () => Promise.reject(new Error('computer gone')),
      apply: () => Promise.reject(new Error('computer gone')),
      read: async () => ({}),
      release: () => Promise.reject(new Error('computer gone')),
      forget: async () => {}
    })
    const archived = await archiveTaskOp(h.slayDb, task.id, {})
    expect(archived?.has_base_dir).toBe(false)
  } finally {
    h.cleanup()
  }
})

test('B2: every path write tells clients (`task:paths-changed`); a title or status update does not', async () => {
  const { h, projectId } = await setup()
  const changed: string[] = []
  const onChanged = (e: { taskId: string }) => changed.push(e.taskId)
  taskEvents.on('task:paths-changed', onChanged)
  try {
    const parent = (await createTaskOp(h.slayDb, { projectId, title: 'P' }, {}))!
    changed.length = 0
    await updateTask(h.slayDb, { id: parent.id, title: 'Renamed', status: 'done' })
    expect(changed).toEqual([])
    // A user path (apply), an inherit, a clear (archive): each names its task, once.
    await updateTask(h.slayDb, { id: parent.id, baseDir: '/custom' })
    expect(changed).toEqual([parent.id])
    const child = (await createTaskOp(
      h.slayDb,
      { projectId, title: 'C', parentId: parent.id },
      {}
    ))!
    expect(changed).toEqual([parent.id, child.id])
    await archiveTaskOp(h.slayDb, child.id, {})
    expect(changed.slice(2)).toEqual([child.id])
  } finally {
    taskEvents.off('task:paths-changed', onChanged)
    h.cleanup()
  }
})

test('§9 7d/7e: a task row never carries a path out of the hub, only whether one is set', async () => {
  const { h, projectId } = await setup()
  try {
    const task = (await createTaskOp(h.slayDb, { projectId, title: 'T' }, {}))!
    expect(task).toMatchObject({ has_worktree: false, has_base_dir: false })
    const updated = (await updateTask(h.slayDb, {
      id: task.id,
      worktreePath: '/w/t',
      baseDir: '/b'
    }))!
    expect(updated).toMatchObject({ has_worktree: true, has_base_dir: true })
    for (const row of [updated, await getTaskOp(h.slayDb, task.id)]) {
      expect(row).not.toHaveProperty('worktree_path')
      expect(row).not.toHaveProperty('base_dir')
    }
    // No delegate (no computers): every task's paths are where nothing can read them.
    setTaskPathsDelegate(null)
    expect(await readTaskPaths([task.id])).toEqual({
      [task.id]: { state: 'offline', computerId: null }
    })
  } finally {
    h.cleanup()
  }
})

test('a subtask that inherits its parent’s folders takes the parent’s computer and holder (p10)', async () => {
  const { h, projectId } = await setup()
  try {
    h.db
      .prepare(
        `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
         VALUES ('bb', 'build-box', 'linux', '1', '[]', 0)`
      )
      .run()
    // A parent pinned to build-box whose worktree is there (as its computer recorded).
    const parent = (await createTaskOp(h.slayDb, { projectId, title: 'Pinned' }, {}))!
    h.db
      .prepare(
        "UPDATE tasks SET computer_id='bb', has_worktree=1, worktree_computer_id='bb' WHERE id=?"
      )
      .run(parent.id)
    const child = (await createTaskOp(
      h.slayDb,
      { projectId, title: 'Child', parentId: parent.id },
      {}
    ))!
    const row = (id: string) =>
      h.db
        .prepare('SELECT computer_id, worktree_computer_id, has_worktree FROM tasks WHERE id=?')
        .get(id)
    expect(row(child.id)).toEqual({
      computer_id: 'bb',
      worktree_computer_id: 'bb',
      has_worktree: 1
    })
    // Holder not recorded yet: the subtask mirrors that (nothing guessed). It resolves
    // like its parent: the copied pin.
    h.db.prepare('UPDATE tasks SET worktree_computer_id=NULL WHERE id=?').run(parent.id)
    const child2 = (await createTaskOp(
      h.slayDb,
      { projectId, title: 'Child 2', parentId: parent.id },
      {}
    ))!
    expect(row(child2.id)).toEqual({
      computer_id: 'bb',
      worktree_computer_id: null,
      has_worktree: 1
    })
    // The parent's holder was deleted: the subtask's folder is on that gone computer
    // too. It must not be recorded on a live computer that never had the folder (that
    // would lock the subtask to it: assertTaskMovable).
    h.db
      .prepare(
        `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
         VALUES ('gone', 'old-box', 'linux', '1', '[]', 0)`
      )
      .run()
    h.db.prepare("UPDATE tasks SET worktree_computer_id='gone' WHERE id=?").run(parent.id)
    h.db.prepare("DELETE FROM computers WHERE id='gone'").run()
    h.db
      .prepare(
        "INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at) VALUES('gone',NULL,'deleted',1)"
      )
      .run()
    const orphan = (await createTaskOp(
      h.slayDb,
      { projectId, title: 'Orphan', parentId: parent.id },
      {}
    ))!
    expect(row(orphan.id)).toEqual({
      computer_id: 'bb',
      worktree_computer_id: 'gone',
      has_worktree: 1
    })
    // No folder to inherit: the subtask keeps its own (no) pin.
    const plain = (await createTaskOp(h.slayDb, { projectId, title: 'Plain' }, {}))!
    h.db.prepare("UPDATE tasks SET computer_id='bb' WHERE id=?").run(plain.id)
    const child3 = (await createTaskOp(
      h.slayDb,
      { projectId, title: 'Child 3', parentId: plain.id },
      {}
    ))!
    expect(row(child3.id)).toEqual({
      computer_id: null,
      worktree_computer_id: null,
      has_worktree: 0
    })
  } finally {
    h.cleanup()
  }
})

test('a user path reaches the delegate as given: it alone normalizes, and the flags follow what it wrote', async () => {
  const { h, projectId, seen } = await setup()
  try {
    const task = (await createTaskOp(h.slayDb, { projectId, title: 'T' }, {}))!
    await updateTask(h.slayDb, { id: task.id, worktreePath: '/w/t', baseDir: '/b' })
    seen.length = 0
    const cleared = await updateTask(h.slayDb, { id: task.id, worktreePath: '' })
    expect(seen).toEqual([
      {
        taskId: task.id,
        op: 'apply',
        change: { worktreePath: '' },
        flags: { has_worktree: 1, has_base_dir: 1 }
      }
    ])
    expect(cleared?.has_worktree).toBe(false)
    expect(cleared?.has_base_dir).toBe(true)
  } finally {
    h.cleanup()
  }
})
