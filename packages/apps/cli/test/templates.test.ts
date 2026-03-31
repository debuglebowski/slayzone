/**
 * CLI templates command tests
 * Run with: ELECTRON_RUN_AS_NODE=1 electron --import tsx/esm packages/apps/cli/test/templates.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter } from './test-harness.js'

const h = await createTestHarness()
const db = createSlayDbAdapter(h.db)

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'TplProj', '#000')

function createTemplate(name: string, opts: Record<string, unknown> = {}) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const nextOrder = (h.db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM task_templates WHERE project_id = ?`
  ).get(projectId) as { n: number }).n
  h.db.prepare(
    `INSERT INTO task_templates (id, project_id, name, description, terminal_mode, default_status, default_priority, is_default, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, name, opts.description ?? null, opts.terminal_mode ?? null,
    opts.default_status ?? null, opts.default_priority ?? null,
    opts.is_default ? 1 : 0, nextOrder, now, now)
  return id
}

function getTemplate(id: string) {
  return h.db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id) as Record<string, unknown>
}

describe('templates create', () => {
  test('creates with minimal fields', () => {
    const id = createTemplate('Basic')
    const t = getTemplate(id)
    expect(t.name).toBe('Basic')
    expect(t.is_default).toBe(0)
    expect(t.sort_order).toBe(0)
  })

  test('creates with --default clears other defaults', () => {
    const id1 = createTemplate('Default1', { is_default: true })
    expect((getTemplate(id1)).is_default).toBe(1)
    // Simulate CLI: clear existing default then create new
    h.db.prepare('UPDATE task_templates SET is_default = 0 WHERE project_id = ? AND is_default = 1').run(projectId)
    const id2 = createTemplate('Default2', { is_default: true })
    expect((getTemplate(id1)).is_default).toBe(0)
    expect((getTemplate(id2)).is_default).toBe(1)
  })

  test('stores terminal_mode and priority', () => {
    const id = createTemplate('Full', { terminal_mode: 'codex', default_priority: 1, default_status: 'todo' })
    const t = getTemplate(id)
    expect(t.terminal_mode).toBe('codex')
    expect(t.default_priority).toBe(1)
    expect(t.default_status).toBe('todo')
  })
})

describe('templates update', () => {
  test('updates name only', () => {
    const id = createTemplate('Old')
    h.db.prepare('UPDATE task_templates SET name = ?, updated_at = ? WHERE id = ?').run('New', new Date().toISOString(), id)
    expect((getTemplate(id)).name).toBe('New')
  })

  test('updates multiple fields', () => {
    const id = createTemplate('Multi')
    h.db.prepare('UPDATE task_templates SET terminal_mode = ?, default_priority = ?, updated_at = ? WHERE id = ?')
      .run('gemini', 2, new Date().toISOString(), id)
    const t = getTemplate(id)
    expect(t.terminal_mode).toBe('gemini')
    expect(t.default_priority).toBe(2)
  })
})

describe('templates list', () => {
  test('lists by project ordered by sort_order', () => {
    const templates = db.query<{ name: string; sort_order: number }>(
      `SELECT name, sort_order FROM task_templates WHERE project_id = :pid ORDER BY sort_order ASC, created_at ASC`,
      { ':pid': projectId }
    )
    expect(templates.length).toBeGreaterThan(0)
    // sort_order should be ascending
    for (let i = 1; i < templates.length; i++) {
      expect(templates[i].sort_order).toBeGreaterThanOrEqual(templates[i - 1].sort_order)
    }
  })
})

describe('templates delete', () => {
  test('deletes by id', () => {
    const id = createTemplate('ToDelete')
    h.db.prepare('DELETE FROM task_templates WHERE id = ?').run(id)
    expect(getTemplate(id)).toBeUndefined()
  })
})

h.cleanup()
console.log('\nDone')
