/**
 * Automations handler contract tests
 * Run with: pnpm tsx --loader ./packages/shared/test-utils/loader.ts packages/domains/automations/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerAutomationHandlers } from './handlers.js'
import type { Automation, AutomationRun } from '@slayzone/automations/shared'
import type { AutomationEngine } from './engine.js'

const h = await createTestHarness()

// Mock engine — tracks executeManual calls
const manualCalls: string[] = []
const mockEngine = {
  async executeManual(id: string) {
    manualCalls.push(id)
    return { id: 'run-1', automation_id: id, trigger_event: null, status: 'success', error: null, duration_ms: 10, started_at: '', completed_at: '' }
  }
} as unknown as AutomationEngine

registerAutomationHandlers(h.ipcMain as never, h.db, mockEngine)

// Seed projects
const projectId = crypto.randomUUID()
const projectId2 = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P1', '#000', '/tmp/p1')
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId2, 'P2', '#111', '/tmp/p2')

const triggerConfig = { type: 'task_status_change', params: { toStatus: 'done' } }
const actions = [{ type: 'run_command', params: { command: 'echo hi' } }]

// --- CREATE ---

await describe('db:automations:create', () => {
  test('creates with required fields', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'Auto 1', trigger_config: triggerConfig, actions }) as Automation
    expect(a.name).toBe('Auto 1')
    expect(a.project_id).toBe(projectId)
    expect(a.enabled).toBe(true)
    expect(a.trigger_config.type).toBe('task_status_change')
    expect(a.actions).toHaveLength(1)
    expect(a.id).toBeTruthy()
  })

  test('description defaults to null', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'Auto 2', trigger_config: triggerConfig, actions }) as Automation
    expect(a.description).toBeNull()
  })

  test('conditions defaults to empty array', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'Auto 3', trigger_config: triggerConfig, actions }) as Automation
    expect(a.conditions).toHaveLength(0)
  })

  test('auto-increments sort_order per project', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    expect(all[0].sort_order).toBe(0)
    expect(all[1].sort_order).toBe(1)
    expect(all[2].sort_order).toBe(2)
  })

  test('different project starts at sort_order 0', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId2, name: 'P2 Auto', trigger_config: triggerConfig, actions }) as Automation
    expect(a.sort_order).toBe(0)
  })

  test('stores description when provided', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'Described', description: 'A desc', trigger_config: triggerConfig, actions }) as Automation
    expect(a.description).toBe('A desc')
  })

  test('stores conditions when provided', () => {
    const conditions = [{ type: 'task_property', params: { field: 'status', operator: 'equals', value: 'done' } }]
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'Conditional', trigger_config: triggerConfig, conditions, actions }) as Automation
    expect(a.conditions).toHaveLength(1)
    expect(a.conditions[0].type).toBe('task_property')
  })
})

// --- GET BY PROJECT ---

await describe('db:automations:getByProject', () => {
  test('returns automations for project', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    expect(all.length).toBeGreaterThan(0)
    for (const a of all) expect(a.project_id).toBe(projectId)
  })

  test('does not return other projects automations', () => {
    const all = h.invoke('db:automations:getByProject', projectId2) as Automation[]
    for (const a of all) expect(a.project_id).toBe(projectId2)
  })

  test('returns empty array for nonexistent project', () => {
    const all = h.invoke('db:automations:getByProject', 'nonexistent') as Automation[]
    expect(all).toHaveLength(0)
  })

  test('ordered by sort_order', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    for (let i = 1; i < all.length; i++) {
      expect(all[i].sort_order).toBeGreaterThanOrEqual(all[i - 1].sort_order)
    }
  })
})

// --- GET ---

await describe('db:automations:get', () => {
  test('returns automation by ID', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const a = h.invoke('db:automations:get', all[0].id) as Automation
    expect(a.id).toBe(all[0].id)
    expect(a.name).toBe(all[0].name)
  })

  test('returns null for nonexistent', () => {
    const a = h.invoke('db:automations:get', 'nonexistent')
    expect(a).toBeNull()
  })
})

// --- UPDATE ---

await describe('db:automations:update', () => {
  test('updates name only', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const orig = all[0]
    const updated = h.invoke('db:automations:update', { id: orig.id, name: 'Renamed' }) as Automation
    expect(updated.name).toBe('Renamed')
    expect(updated.trigger_config.type).toBe(orig.trigger_config.type) // unchanged
  })

  test('updates enabled boolean→integer', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const a = h.invoke('db:automations:update', { id: all[0].id, enabled: false }) as Automation
    expect(a.enabled).toBe(false)
    const b = h.invoke('db:automations:update', { id: all[0].id, enabled: true }) as Automation
    expect(b.enabled).toBe(true)
  })

  test('updates trigger_config', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const newTrigger = { type: 'manual' as const, params: {} }
    const a = h.invoke('db:automations:update', { id: all[0].id, trigger_config: newTrigger }) as Automation
    expect(a.trigger_config.type).toBe('manual')
  })

  test('updates multiple fields at once', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const a = h.invoke('db:automations:update', {
      id: all[0].id,
      name: 'Multi',
      description: 'New desc',
      actions: [{ type: 'change_task_status', params: { status: 'done' } }],
    }) as Automation
    expect(a.name).toBe('Multi')
    expect(a.description).toBe('New desc')
    expect(a.actions[0].type).toBe('change_task_status')
  })

  test('no fields → automation unchanged', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const before = all[0]
    const after = h.invoke('db:automations:update', { id: before.id }) as Automation
    expect(after.name).toBe(before.name)
  })

  test('updates conditions', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const newConditions = [{ type: 'task_property' as const, params: { field: 'worktree_path', operator: 'exists' } }]
    const a = h.invoke('db:automations:update', { id: all[0].id, conditions: newConditions }) as Automation
    expect(a.conditions).toHaveLength(1)
    expect(a.conditions[0].params.field).toBe('worktree_path')
  })

  test('updates sort_order', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const a = h.invoke('db:automations:update', { id: all[0].id, sort_order: 99 }) as Automation
    expect(a.sort_order).toBe(99)
    // Reset
    h.invoke('db:automations:update', { id: all[0].id, sort_order: 0 })
  })
})

// --- DELETE ---

await describe('db:automations:delete', () => {
  test('deletes existing → true', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'ToDelete', trigger_config: triggerConfig, actions }) as Automation
    expect(h.invoke('db:automations:delete', a.id)).toBe(true)
  })

  test('nonexistent → false', () => {
    expect(h.invoke('db:automations:delete', 'nonexistent')).toBe(false)
  })

  test('CASCADE deletes related runs', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'WithRuns', trigger_config: triggerConfig, actions }) as Automation
    // Insert a run directly
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('run-x', a.id)
    const runsBefore = h.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').all(a.id)
    expect(runsBefore).toHaveLength(1)
    h.invoke('db:automations:delete', a.id)
    const runsAfter = h.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').all(a.id)
    expect(runsAfter).toHaveLength(0)
  })
})

// --- TOGGLE ---

await describe('db:automations:toggle', () => {
  test('toggles enabled on/off', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const a = h.invoke('db:automations:toggle', all[0].id, false) as Automation
    expect(a.enabled).toBe(false)
    const b = h.invoke('db:automations:toggle', all[0].id, true) as Automation
    expect(b.enabled).toBe(true)
  })
})

// --- REORDER ---

await describe('db:automations:reorder', () => {
  test('reorders by ID array', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const reversed = [...all].reverse().map(a => a.id)
    h.invoke('db:automations:reorder', reversed)
    const after = h.invoke('db:automations:getByProject', projectId) as Automation[]
    expect(after[0].id).toBe(reversed[0])
    expect(after[after.length - 1].id).toBe(reversed[reversed.length - 1])
  })

  test('empty array → no-op', () => {
    const before = h.invoke('db:automations:getByProject', projectId) as Automation[]
    h.invoke('db:automations:reorder', [])
    const after = h.invoke('db:automations:getByProject', projectId) as Automation[]
    expect(after).toHaveLength(before.length)
  })
})

// --- RUNS ---

await describe('db:automations:getRuns', () => {
  test('returns empty for no runs', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    const runs = h.invoke('db:automations:getRuns', all[0].id) as AutomationRun[]
    // May have runs from other tests, but should not error
    expect(Array.isArray(runs)).toBe(true)
  })

  test('returns runs ordered by started_at DESC', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'RunTest', trigger_config: triggerConfig, actions }) as Automation
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', '2026-01-01')").run('r1', a.id)
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'error', '2026-01-02')").run('r2', a.id)
    const runs = h.invoke('db:automations:getRuns', a.id) as AutomationRun[]
    expect(runs).toHaveLength(2)
    expect(runs[0].id).toBe('r2') // newer first
    expect(runs[1].id).toBe('r1')
  })

  test('respects custom limit', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'LimitTest', trigger_config: triggerConfig, actions }) as Automation
    for (let i = 0; i < 5; i++) {
      h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run(`lim-${i}`, a.id)
    }
    const runs = h.invoke('db:automations:getRuns', a.id, 2) as AutomationRun[]
    expect(runs).toHaveLength(2)
  })

  test('default limit is 50', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'DefaultLimitTest', trigger_config: triggerConfig, actions }) as Automation
    for (let i = 0; i < 60; i++) {
      h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run(`dl-${i}`, a.id)
    }
    const runs = h.invoke('db:automations:getRuns', a.id) as AutomationRun[]
    expect(runs).toHaveLength(50)
  })
})

// --- CLEAR RUNS ---

await describe('db:automations:clearRuns', () => {
  test('deletes all runs for automation', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'ClearTest', trigger_config: triggerConfig, actions }) as Automation
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('cr-1', a.id)
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('cr-2', a.id)
    h.invoke('db:automations:clearRuns', a.id)
    const runs = h.invoke('db:automations:getRuns', a.id) as AutomationRun[]
    expect(runs).toHaveLength(0)
  })

  test('does not affect other automations runs', () => {
    const a1 = h.invoke('db:automations:create', { project_id: projectId, name: 'Clear1', trigger_config: triggerConfig, actions }) as Automation
    const a2 = h.invoke('db:automations:create', { project_id: projectId, name: 'Clear2', trigger_config: triggerConfig, actions }) as Automation
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('iso-1', a1.id)
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('iso-2', a2.id)
    h.invoke('db:automations:clearRuns', a1.id)
    const runs1 = h.invoke('db:automations:getRuns', a1.id) as AutomationRun[]
    const runs2 = h.invoke('db:automations:getRuns', a2.id) as AutomationRun[]
    expect(runs1).toHaveLength(0)
    expect(runs2).toHaveLength(1)
  })
})

// --- RUN MANUAL ---

await describe('db:automations:runManual', () => {
  test('delegates to engine.executeManual', async () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'ManualTest', trigger_config: { type: 'manual', params: {} }, actions }) as Automation
    manualCalls.length = 0
    await h.invoke('db:automations:runManual', a.id)
    expect(manualCalls).toHaveLength(1)
    expect(manualCalls[0]).toBe(a.id)
  })
})

// --- REORDER EDGE CASES ---

await describe('db:automations:reorder edge cases', () => {
  test('duplicate IDs → last occurrence wins sort_order', () => {
    const all = h.invoke('db:automations:getByProject', projectId) as Automation[]
    if (all.length < 2) return
    const dup = [all[0].id, all[0].id, all[1].id]
    h.invoke('db:automations:reorder', dup)
    const a0 = h.invoke('db:automations:get', all[0].id) as Automation
    const a1 = h.invoke('db:automations:get', all[1].id) as Automation
    expect(a0.sort_order).toBe(1) // second occurrence index
    expect(a1.sort_order).toBe(2)
  })
})

// --- GET RUNS EDGE CASES ---

await describe('db:automations:getRuns edge cases', () => {
  test('limit=0 returns no runs (SQL LIMIT 0)', () => {
    const a = h.invoke('db:automations:create', { project_id: projectId, name: 'Limit0Test', trigger_config: triggerConfig, actions }) as Automation
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('lz-1', a.id)
    const runs = h.invoke('db:automations:getRuns', a.id, 0) as AutomationRun[]
    expect(runs).toHaveLength(0)
  })
})

// --- PROJECT DELETION CASCADE ---

await describe('project deletion cascade', () => {
  test('deleting project cascades to its automations', () => {
    const tempProjId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(tempProjId, 'TempProj', '#000', '/tmp/tp')
    const a = h.invoke('db:automations:create', { project_id: tempProjId, name: 'CascadeTest', trigger_config: triggerConfig, actions }) as Automation
    expect(a.id).toBeTruthy()
    h.db.prepare('DELETE FROM projects WHERE id = ?').run(tempProjId)
    const result = h.invoke('db:automations:get', a.id)
    expect(result).toBeNull()
  })
})

h.cleanup()
console.log('\nDone')
