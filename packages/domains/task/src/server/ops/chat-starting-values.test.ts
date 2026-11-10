/**
 * Chat settings live only on the chat's computer (robustness plan §9, decision 2).
 * A template only gives a new chat its starting values: they are seeded into the
 * task at creation, and the computer takes them when the chat first starts. A
 * template applied to a task whose chat a computer already owns changes that chat's
 * settings ON the computer (the delegate), and the hub keeps no copy.
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import crypto from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { createTaskOp } from './create.js'
import { setChatSettingsDelegate, updateTask } from './shared.js'

const settings = {
  chatMode: 'plan',
  chatModel: 'opus',
  chatEffort: 'high',
  chatCollaboration: 'plan' as const,
  chatFastMode: true
}

afterEach(() => setChatSettingsDelegate(null))

async function setup() {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, 'Proj', '#000', '/tmp/proj', JSON.stringify([]))
  const templateId = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO task_templates (id, project_id, name, agent_id, provider_config) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      templateId,
      projectId,
      'T',
      'claude-chat',
      JSON.stringify({ 'claude-chat': { flags: '--x', ...settings, chatConversationId: 'never' } })
    )
  return { h, projectId, templateId }
}

test("a new task gets its template's chat starting values (never a session id)", async () => {
  const { h, projectId, templateId } = await setup()
  try {
    const task = await createTaskOp(h.slayDb, { projectId, title: 'T', templateId }, {})
    expect(task?.provider_config['claude-chat']).toEqual({ flags: '--x', ...settings })
  } finally {
    h.cleanup()
  }
})

test('applying a template to a computer-owned chat changes it on the computer, not on the hub', async () => {
  const { h, projectId } = await setup()
  try {
    const task = await createTaskOp(h.slayDb, { projectId, title: 'T' }, {})
    const applied: unknown[] = []
    setChatSettingsDelegate({
      ownedModes: async (taskId) => (taskId === task!.id ? new Set(['claude-chat']) : new Set()),
      apply: async (taskId, mode, values) => {
        applied.push([taskId, mode, values])
      }
    })
    const updated = await updateTask(h.slayDb, {
      id: task!.id,
      providerConfig: {
        'claude-chat': { flags: '--y', ...settings, chatConversationId: 'x' },
        'codex-chat': { chatModel: 'seed' }
      }
    })
    expect(updated?.provider_config['claude-chat']).toEqual({ flags: '--y' })
    // No chat of that mode on a computer yet: a starting value.
    expect(updated?.provider_config['codex-chat']).toMatchObject({ chatModel: 'seed' })
    // The session id is never a setting a template carries over.
    expect(applied).toEqual([[task!.id, 'claude-chat', settings]])
  } finally {
    h.cleanup()
  }
})
