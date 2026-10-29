/**
 * Claude chat's spawn flags are owned by its pills (mode, model, effort), so a
 * task never gets the terminal mode's default flags copied into its
 * `claude-chat` provider_config entry (bug N2: the seeded
 * `--allow-dangerously-skip-permissions` beat the chat mode, so new chat tasks
 * ran in the CLI's `default` mode while the pill said Auto-accept). Terminal
 * modes keep their seeding. A template's own flags are still copied: they are
 * the user's extras.
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { createTaskOp } from './create.js'
import { createImportedTaskOp } from './create-imported.js'
import { updateTask } from './shared.js'

async function setup() {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, 'Proj', '#000', '/tmp/proj', JSON.stringify([]))
  h.db
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('default_terminal_mode', 'claude-chat') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run()
  return { h, projectId }
}

test('a new task gets no claude-chat flags; terminal modes keep their default flags', async () => {
  const { h, projectId } = await setup()
  const task = await createTaskOp(h.slayDb, { projectId, title: 'Chat task' }, {})
  expect(task?.terminal_mode).toBe('claude-chat')
  expect(task?.provider_config['claude-chat']?.flags).toBeUndefined()
  expect(task?.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
  h.cleanup()
})

test("a template's own claude-chat flags are kept (user extras)", async () => {
  const { h, projectId } = await setup()
  const templateId = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO task_templates (id, project_id, name, provider_config) VALUES (?, ?, ?, ?)'
    )
    .run(templateId, projectId, 'T', JSON.stringify({ 'claude-chat': { flags: '--add-dir ../x' } }))
  const task = await createTaskOp(h.slayDb, { projectId, title: 'From template', templateId }, {})
  expect(task?.provider_config['claude-chat']?.flags).toBe('--add-dir ../x')
  h.cleanup()
})

test('an imported task gets no claude-chat flags', async () => {
  const { h, projectId } = await setup()
  const task = await createImportedTaskOp(h.slayDb, {
    projectId,
    title: 'Imported',
    descriptionHtml: null,
    status: 'todo',
    priority: 3,
    assignee: null,
    externalUpdatedAt: new Date().toISOString()
  })
  expect(task?.provider_config['claude-chat']?.flags).toBeUndefined()
  expect(task?.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
  h.cleanup()
})

test('switching a task to claude-chat does not seed flags; switching to a terminal mode still does', async () => {
  const { h, projectId } = await setup()
  const task = await createTaskOp(h.slayDb, { projectId, title: 'Switcher' }, {})
  const toCode = await updateTask(h.slayDb, { id: task!.id, terminalMode: 'claude-code' })
  expect(toCode?.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
  const toChat = await updateTask(h.slayDb, { id: task!.id, terminalMode: 'claude-chat' })
  expect(toChat?.provider_config['claude-chat']?.flags).toBeUndefined()
  h.cleanup()
})
