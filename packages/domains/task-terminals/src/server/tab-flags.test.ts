/**
 * Boot restore follows each task's project startup mode: the project's own value
 * (a `project_settings` override), else the hub's (plans/settings-by-scope.md).
 */
import { beforeEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { listAutoRestoreChatTabs, listAutoRestoreTaskIds } from './tab-flags.js'

const h = await createTestHarness()
const db = h.slayDb

async function seedRunningTask(projectId: string, taskId: string): Promise<void> {
  await db.run(`INSERT INTO projects (id, name, color) VALUES (?, ?, '#000')`, [
    projectId,
    projectId
  ])
  await db.run(`INSERT INTO tasks (id, project_id, title, status) VALUES (?, ?, 't', 'todo')`, [
    taskId,
    projectId
  ])
  await db.run(
    `INSERT INTO terminal_tabs (id, task_id, mode, is_main, position, agent_state)
     VALUES (?, ?, 'claude-chat', 1, 0, 'running')`,
    [taskId, taskId]
  )
}

beforeEach(async () => {
  await db.exec(
    'DELETE FROM terminal_tabs; DELETE FROM tasks; DELETE FROM project_settings; DELETE FROM projects'
  )
  await seedRunningTask('p-hub', 't-hub')
  await seedRunningTask('p-own', 't-own')
})

test('the hub mode applies to projects without their own', async () => {
  await db.run(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('terminal_agent_startup', 'auto')`
  )
  expect((await listAutoRestoreTaskIds(db)).sort()).toEqual(['t-hub', 't-own'])
})

test("a project's own manual mode keeps its agents waiting, others still restore", async () => {
  await db.run(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('terminal_agent_startup', 'auto')`
  )
  await db.run(
    `INSERT INTO project_settings (project_id, key, value) VALUES ('p-own', 'terminal_agent_startup', 'manual')`
  )
  expect(await listAutoRestoreTaskIds(db)).toEqual(['t-hub'])
  expect((await listAutoRestoreChatTabs(db, new Set())).map((t) => t.taskId)).toEqual(['t-hub'])
})

test("a project's own auto mode restores even when the hub is manual", async () => {
  await db.run(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('terminal_agent_startup', 'manual')`
  )
  await db.run(
    `INSERT INTO project_settings (project_id, key, value) VALUES ('p-own', 'terminal_agent_startup', 'auto')`
  )
  expect(await listAutoRestoreTaskIds(db)).toEqual(['t-own'])
})
