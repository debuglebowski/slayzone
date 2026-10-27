/**
 * Automation history integration tests
 */
import { afterAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { AutomationEngine } from './engine.js'
import { taskEvents } from '@slayzone/task/server'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'AutomationProject', '#000', '/tmp')
const taskId = crypto.randomUUID()
h.db
  .prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(taskId, projectId, 'Automation Task', 'todo', 3, 0)

type Listener = (...args: unknown[]) => void
const listeners = new Map<string, Listener[]>()
const ipcMain = {
  handle: h.ipcMain.handle.bind(h.ipcMain),
  on(channel: string, handler: Listener) {
    if (!listeners.has(channel)) listeners.set(channel, [])
    listeners.get(channel)!.push(handler)
    h.ipcMain.on(channel, handler as never)
  },
  emit(channel: string, ...args: unknown[]) {
    for (const handler of listeners.get(channel) ?? []) handler(...args)
  },
  handlers: h.ipcMain.handlers
}

// Engine runs on the async SlayzoneDb proxy (h.slayDb); fixtures + assertions read the
// same connection via raw h.db (as in engine.test.ts).
const engine = new AutomationEngine(h.slayDb, () => {})
engine.start(ipcMain as never)

function createAutomation(command: string): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(`
    INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order)
    VALUES (?, ?, ?, 1, ?, '[]', ?, 0)
  `)
    .run(
      id,
      projectId,
      'History automation',
      JSON.stringify({ type: 'task_status_change', params: { toStatus: 'done' } }),
      JSON.stringify([{ type: 'run_command', params: { command } }])
    )
  return id
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Waits for the automation's latest run to leave `running` (the engine executes it
 * asynchronously off the task event). A fixed sleep raced the shell spawn when this
 * file runs alongside other suites; the deadline keeps a stuck run a failure.
 */
async function settledRun(automationId: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const row = h.db
      .prepare(
        'SELECT status FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1'
      )
      .get(automationId) as { status: string } | undefined
    if ((row && row.status !== 'running') || Date.now() > deadline) return
    await sleep(25)
  }
}

describe('automation history', () => {
  test('successful run records action steps and a task timeline event', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('DELETE FROM automation_action_runs').run()
    h.db.prepare('DELETE FROM activity_events').run()

    const automationId = createAutomation('printf success')
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await settledRun(automationId)

    const run = h.db
      .prepare(
        'SELECT id, status FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1'
      )
      .get(automationId) as { id: string; status: string }
    expect(run.status).toBe('success')

    const actionRuns = h.db
      .prepare('SELECT status, command, output_tail FROM automation_action_runs WHERE run_id = ?')
      .all(run.id) as Array<{ status: string; command: string; output_tail: string | null }>
    expect(actionRuns).toHaveLength(1)
    expect(actionRuns[0].status).toBe('success')
    expect(actionRuns[0].command).toBe('printf success')
    expect(actionRuns[0].output_tail).toBe('success')

    const timelineEvent = h.db
      .prepare(
        "SELECT kind, entity_type, entity_id FROM activity_events WHERE task_id = ? AND kind = 'automation.run_succeeded'"
      )
      .get(taskId) as { kind: string; entity_type: string; entity_id: string }
    expect(timelineEvent.kind).toBe('automation.run_succeeded')
    expect(timelineEvent.entity_type).toBe('automation_run')
    expect(timelineEvent.entity_id).toBe(run.id)

    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('failed runs store truncated output tail', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('DELETE FROM automation_action_runs').run()
    h.db.prepare('DELETE FROM activity_events').run()

    const longOutputCommand =
      'i=0; while [ $i -lt 4505 ]; do printf a; i=$((i+1)); done; printf boom >&2; exit 1'
    const automationId = createAutomation(longOutputCommand)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await settledRun(automationId)

    const run = h.db
      .prepare(
        'SELECT id, status FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1'
      )
      .get(automationId) as { id: string; status: string }
    expect(run.status).toBe('error')

    const actionRun = h.db
      .prepare('SELECT status, error, output_tail FROM automation_action_runs WHERE run_id = ?')
      .get(run.id) as { status: string; error: string | null; output_tail: string | null }
    expect(actionRun.status).toBe('error')
    expect(actionRun.error).toBeTruthy()
    expect((actionRun.output_tail ?? '').length).toBeLessThanOrEqual(4000)
    expect(actionRun.output_tail ?? '').toMatch(/boom$/)

    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

afterAll(() => {
  engine.stop()
  h.cleanup()
})
