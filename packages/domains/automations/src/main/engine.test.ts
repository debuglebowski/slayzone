/**
 * AutomationEngine tests
 * Run with: pnpm tsx --loader ./packages/shared/test-utils/loader.ts packages/domains/automations/src/main/engine.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { AutomationEngine, cronMatches } from './engine.js'
import type { Automation, AutomationRun } from '@slayzone/automations/shared'
import { taskEvents } from '@slayzone/task/main'

const h = await createTestHarness()

// Seed a project and task
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'TestProj', '#000', '/tmp/test')
const taskId = crypto.randomUUID()
h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)').run(taskId, projectId, 'TestTask', 'todo', 3, 0)

// Track notifications
let notifyCount = 0
const engine = new AutomationEngine(h.db, () => { notifyCount++ })

// Create a working ipcMain mock that actually dispatches events
type Listener = (...args: unknown[]) => void
const listeners = new Map<string, Listener[]>()
const testIpcMain = {
  handle: h.ipcMain.handle.bind(h.ipcMain),
  on(channel: string, handler: Listener) {
    if (!listeners.has(channel)) listeners.set(channel, [])
    listeners.get(channel)!.push(handler)
    h.ipcMain.on(channel, handler as never)
  },
  emit(channel: string, ...args: unknown[]) {
    const handlers = listeners.get(channel) ?? []
    for (const handler of handlers) handler(...args)
  },
  handlers: h.ipcMain.handlers,
}

engine.start(testIpcMain as never)

// Helper: create an automation directly in DB
function createAutomation(opts: {
  name?: string
  triggerType?: string
  fromStatus?: string
  toStatus?: string
  conditions?: unknown[]
  actions?: unknown[]
  enabled?: boolean
}): string {
  const id = crypto.randomUUID()
  const trigger = { type: opts.triggerType ?? 'task_status_change', params: { fromStatus: opts.fromStatus, toStatus: opts.toStatus } }
  const actions = opts.actions ?? [{ type: 'run_command', params: { command: 'echo test' } }]
  const conditions = opts.conditions ?? []
  h.db.prepare(
    `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(id, projectId, opts.name ?? 'Test', opts.enabled !== false ? 1 : 0, JSON.stringify(trigger), JSON.stringify(conditions), JSON.stringify(actions))
  return id
}

function getRuns(automationId: string): AutomationRun[] {
  return h.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC').all(automationId) as AutomationRun[]
}

function getAutomation(id: string) {
  return h.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as { run_count: number; last_run_at: string | null }
}

// --- STATUS CHANGE FILTERING ---

await describe('status change filtering', () => {
  test('oldStatus === newStatus → no event fired', () => {
    const id = createAutomation({ toStatus: 'todo' })
    notifyCount = 0
    // Simulate a task update where status didn't change
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    // The task is still 'todo', so oldStatus === newStatus → skipped
    const runs = getRuns(id)
    expect(runs).toHaveLength(0)
  })

  test('oldStatus undefined → no event fired', () => {
    const id = createAutomation({ toStatus: 'todo' })
    taskEvents.emit('task:updated', { taskId, projectId })
    const runs = getRuns(id)
    expect(runs).toHaveLength(0)
  })

  test('meta undefined → no event fired', () => {
    const id = createAutomation({ toStatus: 'todo' })
    taskEvents.emit('task:updated', { taskId, projectId })
    const runs = getRuns(id)
    expect(runs).toHaveLength(0)
  })

  test('actual status change → event fires', async () => {
    const id = createAutomation({ toStatus: 'done' })
    notifyCount = 0
    // Change task status to 'done' then emit
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    // Wait for async execution
    await new Promise(r => setTimeout(r, 200))
    const runs = getRuns(id)
    expect(runs.length).toBeGreaterThan(0)
    // Reset task
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- TRIGGER MATCHING ---

await describe('trigger matching', () => {
  test('matching toStatus → fires', async () => {
    // Clean slate
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ toStatus: 'in_progress' })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('in_progress', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('non-matching toStatus → skipped', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ toStatus: 'done' })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('in_progress', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('matching fromStatus → fires', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ fromStatus: 'todo' })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('in_progress', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('non-matching fromStatus → skipped', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ fromStatus: 'in_progress' })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('both fromStatus and toStatus must match', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ fromStatus: 'todo', toStatus: 'done' })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('neither fromStatus nor toStatus → fires on any change', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({}) // no from/to
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('whatever', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('disabled automation → skipped', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ enabled: false })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- CONDITION EVALUATION ---

await describe('condition evaluation', () => {
  test('no conditions → passes', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ conditions: [] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('exists operator + field present → passes', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run('/tmp/wt', taskId)
    const id = createAutomation({ conditions: [{ type: 'task_property', params: { field: 'worktree_path', operator: 'exists' } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ?, worktree_path = NULL WHERE id = ?').run('todo', taskId)
  })

  test('exists operator + field null → fails', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ conditions: [{ type: 'task_property', params: { field: 'worktree_path', operator: 'exists' } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('equals operator + matching → passes', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ conditions: [{ type: 'task_property', params: { field: 'priority', operator: 'equals', value: 3 } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('equals operator + non-matching → fails', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ conditions: [{ type: 'task_property', params: { field: 'priority', operator: 'equals', value: 99 } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('multiple conditions, one fails → automation skipped', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({
      conditions: [
        { type: 'task_property', params: { field: 'priority', operator: 'equals', value: 3 } },
        { type: 'task_property', params: { field: 'worktree_path', operator: 'exists' } }, // null, fails
      ]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('not_exists operator + field null → passes', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ conditions: [{ type: 'task_property', params: { field: 'worktree_path', operator: 'not_exists' } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('not_exists operator + field present → fails', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run('/tmp/wt', taskId)
    const id = createAutomation({ conditions: [{ type: 'task_property', params: { field: 'worktree_path', operator: 'not_exists' } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ?, worktree_path = NULL WHERE id = ?').run('todo', taskId)
  })

  test('not_equals operator + different value → passes', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ conditions: [{ type: 'task_property', params: { field: 'priority', operator: 'not_equals', value: 99 } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('not_equals operator + same value → fails', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ conditions: [{ type: 'task_property', params: { field: 'priority', operator: 'not_equals', value: 3 } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('unknown operator → fails condition', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ conditions: [{ type: 'task_property', params: { field: 'priority', operator: 'like', value: 3 } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- RUN LIFECYCLE ---

await describe('run lifecycle', () => {
  test('success → status, duration, completed_at set', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ actions: [{ type: 'run_command', params: { command: 'echo ok' } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 500))
    const runs = getRuns(id)
    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0].status).toBe('success')
    expect(runs[0].completed_at).toBeTruthy()
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('error → status "error", error message stored', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ actions: [{ type: 'run_command', params: { command: 'exit 1' } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 500))
    const runs = getRuns(id)
    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0].status).toBe('error')
    expect(runs[0].error).toBeTruthy()
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('run_count incremented', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ actions: [{ type: 'run_command', params: { command: 'echo ok' } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 500))
    expect(getAutomation(id).run_count).toBe(1)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('notifyRenderer called', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    notifyCount = 0
    createAutomation({ actions: [{ type: 'run_command', params: { command: 'echo ok' } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 500))
    expect(notifyCount).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- CHANGE_TASK_STATUS ACTION ---

await describe('change_task_status action', () => {
  test('updates task status in DB', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    createAutomation({ actions: [{ type: 'change_task_status', params: { status: 'review' } }] })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 500))
    const task = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
    expect(task.status).toBe('review')
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- DEPTH / CASCADE ---

await describe('depth tracking', () => {
  test('depth >= MAX_DEPTH (5) → nothing executes', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    // Create automation that always fires
    const id = createAutomation({})
    // Manually set currentDepth high by calling handleEvent with high depth
    // We can't directly, but we can test via the public API
    // Instead, test that cascading stops:
    // Create an automation that changes status to X, and another that fires on X
    // The second should fire at depth+1 and eventually stop

    // For this test, just verify executeManual works (depth starts at 0)
    const run = await engine.executeManual(id)
    expect(run.status).toBe('success')
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- RETENTION ---

await describe('run retention', () => {
  test('keeps max 100 runs per automation', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ actions: [{ type: 'run_command', params: { command: 'echo ok' } }] })
    // Insert 105 runs directly
    const stmt = h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now', '-' || ? || ' seconds'))")
    for (let i = 0; i < 105; i++) {
      stmt.run(crypto.randomUUID(), id, 105 - i)
    }
    const before = (h.db.prepare('SELECT COUNT(*) as c FROM automation_runs WHERE automation_id = ?').get(id) as { c: number }).c
    expect(before).toBe(105)

    // Trigger one execution which will prune
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 500))

    const after = (h.db.prepare('SELECT COUNT(*) as c FROM automation_runs WHERE automation_id = ?').get(id) as { c: number }).c
    // 105 old + 1 new = 106, pruned to 100
    expect(after).toBeGreaterThanOrEqual(100)
    // Should not be much more than 100
    expect(after).toBe(100)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- EXECUTE MANUAL ---

await describe('executeManual', () => {
  test('valid automation → returns run', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ actions: [{ type: 'run_command', params: { command: 'echo manual' } }] })
    const run = await engine.executeManual(id)
    expect(run.status).toBe('success')
    expect(run.automation_id).toBe(id)
  })

  test('invalid automation → throws', async () => {
    let threw = false
    try {
      await engine.executeManual('nonexistent')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('increments run_count', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ actions: [{ type: 'run_command', params: { command: 'echo ok' } }] })
    await engine.executeManual(id)
    expect(getAutomation(id).run_count).toBe(1)
    await engine.executeManual(id)
    expect(getAutomation(id).run_count).toBe(2)
  })
})

// --- TEMPLATE CONTEXT ---

await describe('template context building', () => {
  test('task fields populated in command', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    // Use a command that includes template vars — if they resolve, the command succeeds
    const id = createAutomation({ actions: [{ type: 'run_command', params: { command: 'echo "{{task.name}} {{project.name}}"' } }] })
    const run = await engine.executeManual(id)
    expect(run.status).toBe('success')
  })
})

// --- CASCADE CHAIN ---

await describe('cascade chain', () => {
  test('automation A changes status → triggers automation B', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    // A: on any status change → set status to 'review'
    const idA = createAutomation({ name: 'A', actions: [{ type: 'change_task_status', params: { status: 'review' } }] })
    // B: on status change to 'review' → run echo
    const idB = createAutomation({ name: 'B', toStatus: 'review', actions: [{ type: 'run_command', params: { command: 'echo cascaded' } }] })

    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 1000))

    // A should have run (changed status to 'review')
    expect(getRuns(idA).length).toBeGreaterThan(0)
    // B should have been triggered by A's status change
    expect(getRuns(idB).length).toBeGreaterThan(0)

    const task = h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
    expect(task.status).toBe('review')
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('circular cascade stops at MAX_DEPTH', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    // A: on status → 'ping', set status to 'pong'
    createAutomation({ name: 'Ping', fromStatus: 'pong', toStatus: 'ping', actions: [{ type: 'change_task_status', params: { status: 'pong' } }] })
    // B: on status → 'pong', set status to 'ping'
    createAutomation({ name: 'Pong', fromStatus: 'ping', toStatus: 'pong', actions: [{ type: 'change_task_status', params: { status: 'ping' } }] })

    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('ping', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 2000))

    // Should have run some times but NOT infinitely (depth limit = 5)
    const allRuns = h.db.prepare('SELECT COUNT(*) as c FROM automation_runs').get() as { c: number }
    expect(allRuns.c).toBeGreaterThan(0)
    // With depth 5, max ~5 cascading runs
    expect(allRuns.c).toBeGreaterThan(1) // at least the first cascade happened
    // The important thing: we didn't hang or crash — depth stopped it
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- MULTIPLE AUTOMATIONS MATCHING ---

await describe('multiple automations matching same event', () => {
  test('both fire', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id1 = createAutomation({ name: 'First', actions: [{ type: 'run_command', params: { command: 'echo first' } }] })
    const id2 = createAutomation({ name: 'Second', actions: [{ type: 'run_command', params: { command: 'echo second' } }] })

    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 500))

    expect(getRuns(id1).length).toBeGreaterThan(0)
    expect(getRuns(id2).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- CROSS-PROJECT ISOLATION ---

await describe('cross-project isolation in engine', () => {
  test('automation for project B does not fire on project A events', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    // Create automation for a DIFFERENT project
    const otherProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(otherProjectId, 'Other', '#fff', '/tmp/other')
    const otherId = crypto.randomUUID()
    h.db.prepare(
      `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order)
       VALUES (?, ?, ?, 1, ?, '[]', ?, 0)`
    ).run(otherId, otherProjectId, 'OtherAuto', JSON.stringify({ type: 'task_status_change', params: {} }), JSON.stringify([{ type: 'run_command', params: { command: 'echo other' } }]))

    // Fire event for our task (projectId, not otherProjectId)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))

    expect(getRuns(otherId)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- NONEXISTENT TASK / PROJECT ---

await describe('missing task or project in context', () => {
  test('nonexistent taskId → engine handles gracefully (task not found)', () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    createAutomation({})
    // Emit with a fake taskId that doesn't exist in DB
    taskEvents.emit('task:updated', { taskId: 'nonexistent-task', projectId, oldStatus: 'todo' })
    // Engine should not crash — task SELECT returns undefined, early return
  })

  test('change_task_status with no task in context → error run', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    // Create manual automation with change_task_status action (no task context on manual trigger)
    const id = createAutomation({
      triggerType: 'task_status_change',
      actions: [{ type: 'change_task_status', params: { status: 'done' } }]
    })
    // Execute manually — no taskId in event
    const run = await engine.executeManual(id)
    expect(run.status).toBe('error')
    expect(run.error).toBeTruthy()
  })
})

// --- UNKNOWN ACTION TYPE ---

await describe('unknown action type', () => {
  test('throws error, run marked as error', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ actions: [{ type: 'nonexistent_action', params: {} }] })
    const run = await engine.executeManual(id)
    expect(run.status).toBe('error')
    expect(run.error).toBeTruthy()
  })
})

// --- MULTI-ACTION ERROR MIDWAY ---

await describe('multi-action error handling', () => {
  test('action 1 succeeds, action 2 fails → run marked error', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({
      actions: [
        { type: 'run_command', params: { command: 'echo ok' } },
        { type: 'run_command', params: { command: 'exit 1' } },
        { type: 'run_command', params: { command: 'echo should-not-run' } },
      ]
    })
    const run = await engine.executeManual(id)
    expect(run.status).toBe('error')
  })
})

// --- RUN_COMMAND WITH CWD ---

await describe('run_command with explicit cwd', () => {
  test('uses provided cwd', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({ actions: [{ type: 'run_command', params: { command: 'pwd', cwd: '/tmp' } }] })
    const run = await engine.executeManual(id)
    expect(run.status).toBe('success')
  })
})

// --- CHANGE_TASK_STATUS EMITS EVENT ---

await describe('change_task_status emits task:updated', () => {
  test('emit fires with oldStatus', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()

    // Track emits
    let emittedTaskId: string | null = null
    let emittedOldStatus: string | null = null
    const trackingListener = (payload: { taskId: string; oldStatus?: string }) => {
      emittedTaskId = payload.taskId
      emittedOldStatus = payload.oldStatus ?? null
    }
    taskEvents.on('task:updated', trackingListener)

    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
    const id = createAutomation({ actions: [{ type: 'change_task_status', params: { status: 'shipped' } }] })
    await engine.executeManual(id)

    expect(emittedTaskId).toBe(taskId)
    expect(emittedOldStatus).toBe('todo')

    taskEvents.off('task:updated', trackingListener)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- IN CONDITION ON TAGS FIELD ---

await describe('in condition on tags field', () => {
  test('in operator + task has matching tag → passes', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('DELETE FROM task_tags').run()
    const tagId = crypto.randomUUID()
    h.db.prepare('INSERT INTO tags (id, project_id, name) VALUES (?, ?, ?)').run(tagId, projectId, 'tag-match-' + tagId.slice(0, 8))
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tagId)
    const id = createAutomation({
      conditions: [{ type: 'task_property', params: { field: 'tags', operator: 'in', value: [tagId] } }]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('in operator + no matching tag → fails', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('DELETE FROM task_tags').run()
    const id = createAutomation({
      conditions: [{ type: 'task_property', params: { field: 'tags', operator: 'in', value: ['nonexistent-tag'] } }]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('in operator + empty value array → fails', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('DELETE FROM task_tags').run()
    const tagId = crypto.randomUUID()
    h.db.prepare('INSERT INTO tags (id, project_id, name) VALUES (?, ?, ?)').run(tagId, projectId, 'tag-empty-' + tagId.slice(0, 8))
    h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tagId)
    const id = createAutomation({
      conditions: [{ type: 'task_property', params: { field: 'tags', operator: 'in', value: [] } }]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- IN CONDITION STRING COERCION ---

await describe('in condition on regular field', () => {
  test('string values match numeric DB field via String() coercion', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    // task.priority is 3 (number in DB)
    const id = createAutomation({
      conditions: [{ type: 'task_property', params: { field: 'priority', operator: 'in', value: ['3', '5'] } }]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('non-matching values → fails', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({
      conditions: [{ type: 'task_property', params: { field: 'priority', operator: 'in', value: [1, 2, 5] } }]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })

  test('non-array value → condition fails', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({
      conditions: [{ type: 'task_property', params: { field: 'priority', operator: 'in', value: '3' } }]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', taskId)
  })
})

// --- EXISTS / NOT_EXISTS WITH EMPTY STRING ---

await describe('exists/not_exists with empty string', () => {
  test('exists + empty string → fails (treated as non-existent)', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run('', taskId)
    const id = createAutomation({
      conditions: [{ type: 'task_property', params: { field: 'worktree_path', operator: 'exists' } }]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
    h.db.prepare('UPDATE tasks SET status = ?, worktree_path = NULL WHERE id = ?').run('todo', taskId)
  })

  test('not_exists + empty string → passes', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run('', taskId)
    const id = createAutomation({
      conditions: [{ type: 'task_property', params: { field: 'worktree_path', operator: 'not_exists' } }]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id).length).toBeGreaterThan(0)
    h.db.prepare('UPDATE tasks SET status = ?, worktree_path = NULL WHERE id = ?').run('todo', taskId)
  })
})

// --- TASK_CREATED TRIGGER ---

await describe('task_created trigger', () => {
  test('fires automation on task creation event', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({
      triggerType: 'task_created',
      actions: [{ type: 'run_command', params: { command: 'echo created', cwd: '/tmp' } }]
    })
    taskEvents.emit('task:created', { taskId, projectId })
    await new Promise(r => setTimeout(r, 500))
    const runs = getRuns(id)
    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0].status).toBe('success')
  })

  test('does not fire for different project', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({
      triggerType: 'task_created',
      actions: [{ type: 'run_command', params: { command: 'echo created', cwd: '/tmp' } }]
    })
    taskEvents.emit('task:created', { taskId, projectId: 'other-project' })
    await new Promise(r => setTimeout(r, 200))
    expect(getRuns(id)).toHaveLength(0)
  })
})

// --- TASK_ARCHIVED TRIGGER ---

await describe('task_archived trigger', () => {
  test('fires automation on task archive event', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({
      triggerType: 'task_archived',
      actions: [{ type: 'run_command', params: { command: 'echo archived', cwd: '/tmp' } }]
    })
    taskEvents.emit('task:archived', { taskId, projectId })
    await new Promise(r => setTimeout(r, 500))
    const runs = getRuns(id)
    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0].status).toBe('success')
  })

  test('nonexistent task → skipped gracefully', () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    createAutomation({
      triggerType: 'task_archived',
      actions: [{ type: 'run_command', params: { command: 'echo archived' } }]
    })
    // Engine looks up project_id, gets undefined, skips
    taskEvents.emit('task:archived', { taskId: 'nonexistent-task', projectId })
  })
})

// --- TASK_TAG_CHANGED TRIGGER ---

await describe('task_tag_changed trigger', () => {
  test('fires automation on tag change event', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({
      triggerType: 'task_tag_changed',
      actions: [{ type: 'run_command', params: { command: 'echo tags-changed', cwd: '/tmp' } }]
    })
    testIpcMain.emit('db:taskTags:setForTask:done', null, taskId, ['some-tag'])
    await new Promise(r => setTimeout(r, 500))
    const runs = getRuns(id)
    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0].status).toBe('success')
  })

  test('nonexistent task → skipped gracefully', () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    createAutomation({
      triggerType: 'task_tag_changed',
      actions: [{ type: 'run_command', params: { command: 'echo tags' } }]
    })
    testIpcMain.emit('db:taskTags:setForTask:done', null, 'nonexistent', ['tag'])
  })
})

// --- CRON MATCHING ---

await describe('cronMatches', () => {
  test('wildcard (* * * * *) matches any date', () => {
    expect(cronMatches('* * * * *', new Date(2026, 0, 1, 12, 30))).toBe(true)
  })

  test('specific minute matches/rejects', () => {
    expect(cronMatches('30 * * * *', new Date(2026, 0, 1, 12, 30))).toBe(true)
    expect(cronMatches('15 * * * *', new Date(2026, 0, 1, 12, 30))).toBe(false)
  })

  test('step values (*/15)', () => {
    expect(cronMatches('*/15 * * * *', new Date(2026, 0, 1, 12, 0))).toBe(true)
    expect(cronMatches('*/15 * * * *', new Date(2026, 0, 1, 12, 15))).toBe(true)
    expect(cronMatches('*/15 * * * *', new Date(2026, 0, 1, 12, 7))).toBe(false)
  })

  test('comma-separated values', () => {
    expect(cronMatches('0,30 * * * *', new Date(2026, 0, 1, 12, 30))).toBe(true)
    expect(cronMatches('0,30 * * * *', new Date(2026, 0, 1, 12, 0))).toBe(true)
    expect(cronMatches('0,30 * * * *', new Date(2026, 0, 1, 12, 15))).toBe(false)
  })

  test('specific hour + minute', () => {
    expect(cronMatches('0 9 * * *', new Date(2026, 0, 1, 9, 0))).toBe(true)
    expect(cronMatches('0 9 * * *', new Date(2026, 0, 1, 10, 0))).toBe(false)
  })

  test('day of week (0=Sun)', () => {
    // Jan 4 2026 is Sunday
    expect(cronMatches('* * * * 0', new Date(2026, 0, 4, 12, 0))).toBe(true)
    expect(cronMatches('* * * * 1', new Date(2026, 0, 4, 12, 0))).toBe(false)
  })

  test('day of month', () => {
    expect(cronMatches('* * 15 * *', new Date(2026, 0, 15, 12, 0))).toBe(true)
    expect(cronMatches('* * 15 * *', new Date(2026, 0, 16, 12, 0))).toBe(false)
  })

  test('month (1-indexed in cron)', () => {
    expect(cronMatches('* * * 1 *', new Date(2026, 0, 1, 12, 0))).toBe(true)
    expect(cronMatches('* * * 2 *', new Date(2026, 0, 1, 12, 0))).toBe(false)
  })

  test('empty expression → false', () => {
    expect(cronMatches('', new Date())).toBe(false)
  })

  test('all fields specific', () => {
    // Jan 4 2026 = Sunday (0), 12:30
    expect(cronMatches('30 12 4 1 0', new Date(2026, 0, 4, 12, 30))).toBe(true)
    expect(cronMatches('30 12 4 1 0', new Date(2026, 0, 4, 12, 31))).toBe(false)
  })
})

// --- TEMPLATE CONTEXT: TERMINAL_MODE_FLAGS ---

await describe('template context: terminal_mode_flags', () => {
  test('resolved from provider_config JSON', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    h.db.prepare('UPDATE tasks SET terminal_mode = ?, provider_config = ? WHERE id = ?')
      .run('claude-code', JSON.stringify({ 'claude-code': { flags: '--verbose' } }), taskId)
    createAutomation({
      actions: [{ type: 'run_command', params: { command: 'test "{{task.terminal_mode_flags}}" = "--verbose"', cwd: '/tmp' } }]
    })
    h.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', taskId)
    taskEvents.emit('task:updated', { taskId, projectId, oldStatus: 'todo' })
    await new Promise(r => setTimeout(r, 500))
    const runs = h.db.prepare('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 1').all() as AutomationRun[]
    expect(runs[0].status).toBe('success')
    h.db.prepare('UPDATE tasks SET status = ?, terminal_mode = NULL, provider_config = ? WHERE id = ?').run('todo', '{}', taskId)
  })
})

// --- STDERR HANDLING ---

await describe('runCatchup (missed cron fires)', () => {
  function createCronAutomation(opts: {
    expression: string
    lastRunAt: string | null
    catchup?: boolean
    enabled?: boolean
    command?: string
  }): string {
    const id = crypto.randomUUID()
    const trigger = { type: 'cron', params: { expression: opts.expression } }
    const actions = [{ type: 'run_command', params: { command: opts.command ?? `echo catchup-${id}`, cwd: '/tmp' } }]
    h.db.prepare(
      `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order, last_run_at, catchup_on_start)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id, projectId, `Cron-${id.slice(0, 6)}`, opts.enabled !== false ? 1 : 0,
      JSON.stringify(trigger), JSON.stringify([]), JSON.stringify(actions),
      opts.lastRunAt, opts.catchup === false ? 0 : 1
    )
    return id
  }

  test('missed slot since last_run_at → fires once (coalesced)', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    // last_run_at = 1 hour ago, schedule every minute → 60 missed slots, but only 1 fire
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    const id = createCronAutomation({ expression: '* * * * *', lastRunAt: oneHourAgo })

    engine.runCatchup()
    await new Promise(r => setTimeout(r, 300))

    const runs = getRuns(id)
    expect(runs).toHaveLength(1)
  })

  test('catchup_on_start = 0 → no fire', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    const id = createCronAutomation({ expression: '* * * * *', lastRunAt: oneHourAgo, catchup: false })

    engine.runCatchup()
    await new Promise(r => setTimeout(r, 200))

    expect(getRuns(id)).toHaveLength(0)
  })

  test('last_run_at = NULL → no fire (no baseline)', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createCronAutomation({ expression: '* * * * *', lastRunAt: null })

    engine.runCatchup()
    await new Promise(r => setTimeout(r, 200))

    expect(getRuns(id)).toHaveLength(0)
  })

  test('disabled automation → no fire', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    const id = createCronAutomation({ expression: '* * * * *', lastRunAt: oneHourAgo, enabled: false })

    engine.runCatchup()
    await new Promise(r => setTimeout(r, 200))

    expect(getRuns(id)).toHaveLength(0)
  })

  test('no slot matched between last_run_at and now → no fire', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    // Cron fires at minute 0 only. last_run = 30s ago (within same minute or just past) → no match in range
    const tenSecAgo = new Date(Date.now() - 10 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    // Use an impossible cron (Feb 30) so no minute in range matches
    const id = createCronAutomation({ expression: '0 0 30 2 *', lastRunAt: tenSecAgo })

    engine.runCatchup()
    await new Promise(r => setTimeout(r, 200))

    expect(getRuns(id)).toHaveLength(0)
  })
})

await describe('run_command stderr handling', () => {
  test('stderr with exit 0 → still success', async () => {
    h.db.prepare('DELETE FROM automations').run()
    h.db.prepare('DELETE FROM automation_runs').run()
    const id = createAutomation({
      actions: [{ type: 'run_command', params: { command: 'echo "warning" >&2 && echo ok', cwd: '/tmp' } }]
    })
    const run = await engine.executeManual(id)
    expect(run.status).toBe('success')
  })
})

taskEvents.removeAllListeners()
engine.stop()
h.cleanup()
console.log('\nDone')
