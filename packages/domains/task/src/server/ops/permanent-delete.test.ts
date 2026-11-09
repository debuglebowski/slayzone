import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness, type TestHarness } from '../../../../../shared/test-utils/ipc-harness'
import { archiveTaskOp } from './archive'
import { deleteTaskOp } from './delete'
import { deleteManyTasksOp } from './delete-many'
import { taskEvents } from '../events'
import { configureTaskRuntimeAdapters } from './shared'
import { deleteProject } from '@slayzone/projects/server'

const fixtures: TestHarness[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

async function fixture() {
  const h = await createTestHarness()
  fixtures.push(h)
  const root = h.tmpDir()
  configureTaskRuntimeAdapters({
    getDataRoot: () => root,
    killPtysByTaskId: () => {},
    removeTaskProcesses: () => {}
  })
  for (const owner of ['alice', 'bob']) {
    h.db
      .prepare('INSERT INTO projects(id,name,color,owner_user_id) VALUES(?,?,?,?)')
      .run(`project-${owner}`, owner, '#000000', owner)
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title) VALUES(?,?,?)')
      .run(`task-${owner}`, `project-${owner}`, `${owner} task`)
    const dir = join(root, 'artifacts', `task-${owner}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'original.txt'), `${owner} original, never saved as a version`)
  }
  return { h, root }
}

test('Delete immediately erases the selected task and its files, preserving another owner', async () => {
  const { h, root } = await fixture()
  await deleteTaskOp(h.slayDb, 'task-alice', {})
  expect(h.db.prepare('SELECT 1 FROM tasks WHERE id=?').get('task-alice')).toBeUndefined()
  expect(existsSync(join(root, 'artifacts', 'task-alice'))).toBe(false)
  expect(h.db.prepare('SELECT 1 FROM tasks WHERE id=?').get('task-bob')).toBeDefined()
  expect(readFileSync(join(root, 'artifacts', 'task-bob', 'original.txt'), 'utf8')).toBe(
    'bob original, never saved as a version'
  )
})

test('Archive preserves original files that have no saved version', async () => {
  const { h, root } = await fixture()
  await archiveTaskOp(h.slayDb, 'task-alice', {})
  expect(readFileSync(join(root, 'artifacts', 'task-alice', 'original.txt'), 'utf8')).toBe(
    'alice original, never saved as a version'
  )
  expect(h.db.prepare('SELECT archived_at FROM tasks WHERE id=?').get('task-alice')).toMatchObject({
    archived_at: expect.any(String)
  })
})

test('project deletion removes task directories instead of only cascading the database', async () => {
  const { h, root } = await fixture()
  await deleteProject(h.slayDb, 'project-alice', join(root, 'project-icons'))
  expect(existsSync(join(root, 'artifacts', 'task-alice'))).toBe(false)
  expect(readFileSync(join(root, 'artifacts', 'task-bob', 'original.txt'), 'utf8')).toBe(
    'bob original, never saved as a version'
  )
})

test('Delete keeps subtasks: re-parented, announced as updated, never erased', async () => {
  const { h } = await fixture()
  h.db
    .prepare(
      "INSERT INTO tasks(id,project_id,title,parent_id) VALUES('child','project-alice','c','task-alice')"
    )
    .run()
  h.db
    .prepare(
      "INSERT INTO tasks(id,project_id,title,parent_id) VALUES('second','project-alice','s','task-alice')"
    )
    .run()
  const updated: unknown[] = []
  const listener = (event: unknown) => updated.push(event)
  taskEvents.on('task:updated', listener)
  try {
    await deleteManyTasksOp(h.slayDb, ['task-alice', 'second'], {})
  } finally {
    taskEvents.off('task:updated', listener)
  }
  expect(h.db.prepare("SELECT parent_id FROM tasks WHERE id='child'").get()).toEqual({
    parent_id: null
  })
  expect(h.db.prepare("SELECT 1 FROM tasks WHERE id='second'").get()).toBeUndefined()
  expect(updated).toEqual([{ taskId: 'child', projectId: 'project-alice' }])
})

test('Deleting one parent announces its surviving subtask as updated', async () => {
  const { h } = await fixture()
  h.db
    .prepare(
      "INSERT INTO tasks(id,project_id,title,parent_id) VALUES('child','project-alice','c','task-alice')"
    )
    .run()
  const updated: unknown[] = []
  const listener = (event: unknown) => updated.push(event)
  taskEvents.on('task:updated', listener)
  try {
    await deleteTaskOp(h.slayDb, 'task-alice', {})
  } finally {
    taskEvents.off('task:updated', listener)
  }
  expect(h.db.prepare("SELECT parent_id FROM tasks WHERE id='child'").get()).toEqual({
    parent_id: null
  })
  expect(updated).toEqual([{ taskId: 'child', projectId: 'project-alice' }])
})
