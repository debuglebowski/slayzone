/**
 * Automation history integration tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ../../../../shared/test-utils/loader.ts src/main/history.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { AutomationEngine } from './engine.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'AutomationProject', '#000', '/tmp')
const taskId = crypto.randomUUID()
h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)').run(taskId, projectId, 'Automation Task', 'todo', 3, 0)

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
  handlers: h.ipcMain.handlers,
}

const engine = new AutomationEngine(h.db, () => {})
engine.start(ipcMain as never)

function createAutomation(command: string): string {
  const id = crypto.randomUUID()
  h.db.prepare(`
    INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order)
    VALUES (?, ?, ?, 1, ?, '[]', ?, 0)
  `).run(
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

await describe('automation history', () => {
  test('successful run records action steps and a task timeline event', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('DELETE FROM automation_action_runs').run()
    h.db.prepare('DELETE FROM activity_events').run()

    const automationId = createAutomation('printf success')
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    ipcMain.emit('db:tasks:update:done', null, taskId, { oldStatus: 'todo' })
    await sleep(200)

    const run = h.db.prepare('SELECT id, status FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1').get(automationId) as { id: string; status: string }
    expect(run.status).toBe('success')

    const actionRuns = h.db.prepare('SELECT status, command, output_tail FROM automation_action_runs WHERE run_id = ?').all(run.id) as Array<{ status: string; command: string; output_tail: string | null }>
    expect(actionRuns).toHaveLength(1)
    expect(actionRuns[0].status).toBe('success')
    expect(actionRuns[0].command).toBe('printf success')
    expect(actionRuns[0].output_tail).toBe('success')

    const timelineEvent = h.db.prepare("SELECT kind, entity_type, entity_id FROM activity_events WHERE task_id = ? AND kind = 'automation.run_succeeded'").get(taskId) as { kind: string; entity_type: string; entity_id: string }
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

    const longOutputCommand = "i=0; while [ $i -lt 4505 ]; do printf a; i=$((i+1)); done; printf boom >&2; exit 1"
    const automationId = createAutomation(longOutputCommand)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    ipcMain.emit('db:tasks:update:done', null, taskId, { oldStatus: 'todo' })
    await sleep(200)

    const run = h.db.prepare('SELECT id, status FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1').get(automationId) as { id: string; status: string }
    expect(run.status).toBe('error')

    const actionRun = h.db.prepare('SELECT status, error, output_tail FROM automation_action_runs WHERE run_id = ?').get(run.id) as { status: string; error: string | null; output_tail: string | null }
    expect(actionRun.status).toBe('error')
    expect(Boolean(actionRun.error)).toBe(true)
    expect((actionRun.output_tail ?? '').length <= 4000).toBe(true)
    expect((actionRun.output_tail ?? '').endsWith('boom')).toBe(true)

    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

engine.stop()
h.cleanup()
process.exit(process.exitCode ?? 0)
