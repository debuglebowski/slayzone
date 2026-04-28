/**
 * CLI automations command tests
 * Run with: ELECTRON_RUN_AS_NODE=1 electron --import tsx/esm packages/apps/cli/test/automations.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter } from './test-harness.js'

const h = await createTestHarness()
const db = createSlayDbAdapter(h.db)

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'AutoProj', '#000', '/tmp/auto')

function createAutomation(name: string, opts: { trigger?: string; actions?: string; enabled?: number } = {}) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const trigger = opts.trigger ?? JSON.stringify({ type: 'manual', params: {} })
  const actions = opts.actions ?? JSON.stringify([{ type: 'run_command', params: { command: 'echo hi' } }])
  const nextOrder = (h.db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM automations WHERE project_id = ?`
  ).get(projectId) as { n: number }).n
  h.db.prepare(
    `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, name, opts.enabled ?? 1, trigger, '[]', actions, nextOrder, now, now)
  return id
}

function getAutomation(id: string) {
  return h.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as Record<string, unknown>
}

describe('automations create', () => {
  test('creates with trigger + action', () => {
    const id = createAutomation('Auto1')
    const a = getAutomation(id)
    expect(a.name).toBe('Auto1')
    expect(a.enabled).toBe(1)
    const tc = JSON.parse(a.trigger_config as string)
    expect(tc.type).toBe('manual')
  })

  test('creates status_change trigger with params', () => {
    const trigger = JSON.stringify({ type: 'task_status_change', params: { toStatus: 'done' } })
    const id = createAutomation('StatusAuto', { trigger })
    const tc = JSON.parse((getAutomation(id)).trigger_config as string)
    expect(tc.type).toBe('task_status_change')
    expect(tc.params.toStatus).toBe('done')
  })

  test('auto-increments sort_order', () => {
    const id1 = createAutomation('S1')
    const id2 = createAutomation('S2')
    expect((getAutomation(id1)).sort_order < (getAutomation(id2) as Record<string, unknown>).sort_order).toBe(true)
  })
})

describe('automations toggle', () => {
  test('flips enabled 1→0', () => {
    const id = createAutomation('Toggle1', { enabled: 1 })
    h.db.prepare('UPDATE automations SET enabled = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    expect((getAutomation(id)).enabled).toBe(0)
  })

  test('flips enabled 0→1', () => {
    const id = createAutomation('Toggle2', { enabled: 0 })
    h.db.prepare('UPDATE automations SET enabled = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    expect((getAutomation(id)).enabled).toBe(1)
  })
})

describe('automations update', () => {
  test('updates name and description', () => {
    const id = createAutomation('OldName')
    h.db.prepare('UPDATE automations SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run('NewName', 'desc', new Date().toISOString(), id)
    const a = getAutomation(id)
    expect(a.name).toBe('NewName')
    expect(a.description).toBe('desc')
  })

  test('updates trigger_config', () => {
    const id = createAutomation('TrigUpdate')
    const newTrigger = JSON.stringify({ type: 'cron', params: { expression: '0 9 * * 1-5' } })
    h.db.prepare('UPDATE automations SET trigger_config = ?, updated_at = ? WHERE id = ?')
      .run(newTrigger, new Date().toISOString(), id)
    const tc = JSON.parse((getAutomation(id)).trigger_config as string)
    expect(tc.type).toBe('cron')
    expect(tc.params.expression).toBe('0 9 * * 1-5')
  })
})

describe('automations delete', () => {
  test('deletes by id', () => {
    const id = createAutomation('ToDelete')
    h.db.prepare('DELETE FROM automations WHERE id = ?').run(id)
    expect(getAutomation(id)).toBeUndefined()
  })
})

describe('automations list', () => {
  test('lists by project', () => {
    const rows = db.query<{ name: string }>(
      `SELECT * FROM automations WHERE project_id = :pid ORDER BY sort_order, created_at`,
      { ':pid': projectId }
    )
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('automations catchup_on_start', () => {
  test('default = 1 when not specified in INSERT', () => {
    const id = createAutomation('CatchupDefault')
    expect((getAutomation(id)).catchup_on_start).toBe(1)
  })

  test('explicit 0 persists', () => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    h.db.prepare(
      `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order, catchup_on_start, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, '[]', ?, 0, 0, ?, ?)`
    ).run(id, projectId, 'CatchupOff',
      JSON.stringify({ type: 'cron', params: { expression: '*/5 * * * *' } }),
      JSON.stringify([{ type: 'run_command', params: { command: 'echo' } }]),
      now, now)
    expect((getAutomation(id)).catchup_on_start).toBe(0)
  })

  test('toggle via UPDATE', () => {
    const id = createAutomation('CatchupToggle')
    h.db.prepare('UPDATE automations SET catchup_on_start = 0, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
    expect((getAutomation(id)).catchup_on_start).toBe(0)
    h.db.prepare('UPDATE automations SET catchup_on_start = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
    expect((getAutomation(id)).catchup_on_start).toBe(1)
  })
})

describe('automation_runs', () => {
  test('stores and queries runs', () => {
    const autoId = createAutomation('RunTest')
    const runId = crypto.randomUUID()
    h.db.prepare(
      `INSERT INTO automation_runs (id, automation_id, status, duration_ms, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(runId, autoId, 'success', 42, new Date().toISOString(), new Date().toISOString())
    const runs = db.query<{ status: string; duration_ms: number }>(
      `SELECT * FROM automation_runs WHERE automation_id = :aid ORDER BY started_at DESC LIMIT :limit`,
      { ':aid': autoId, ':limit': 10 }
    )
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('success')
    expect(runs[0].duration_ms).toBe(42)
  })
})

h.cleanup()
console.log('\nDone')
