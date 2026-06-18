/**
 * automations router contract tests — exercise the procedures via tRPC
 * `createCaller` against the harness DB, with a mock engine injected on ctx for
 * runManual. Ports the coverage from the legacy automations IPC-handler test
 * (domains/automations/src/electron/handlers.test.ts). The onChanged subscription
 * is exercised by the existing chat/agent-turns subscription tests' idiom and is
 * not re-covered here (the handler test did not cover it).
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { automationsRouter } from './automations.js'
import type { Automation, AutomationRun } from '@slayzone/automations/shared'

const h = await createTestHarness()

const manualCalls: string[] = []
const mockEngine = {
  async executeManual(id: string) {
    manualCalls.push(id)
    return {
      id: 'run-1',
      automation_id: id,
      trigger_event: null,
      status: 'success',
      error: null,
      duration_ms: 10,
      started_at: '',
      completed_at: ''
    }
  }
}

const ctx = { db: h.slayDb, automationEngine: mockEngine }
const caller = automationsRouter.createCaller(ctx as never)

const projectId = crypto.randomUUID()
const projectId2 = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P1', '#000', '/tmp/p1')
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId2, 'P2', '#111', '/tmp/p2')

const triggerConfig = { type: 'task_status_change', params: { toStatus: 'done' } }
const actions = [{ type: 'run_command', params: { command: 'echo hi' } }]
const mk = (extra: Record<string, unknown>): Promise<Automation> =>
  caller.create({ project_id: projectId, trigger_config: triggerConfig, actions, ...extra } as never) as Promise<Automation>

test('automations router: create required fields + defaults + per-project sort_order + provided desc/conditions', async () => {
  const a = await mk({ name: 'Auto 1' })
  expect(a.name).toBe('Auto 1')
  expect(a.project_id).toBe(projectId)
  expect(a.enabled).toBe(true)
  expect(a.trigger_config.type).toBe('task_status_change')
  expect(a.actions).toHaveLength(1)
  expect(a.id).toBeTruthy()
  expect(a.description).toBeNull()
  expect(a.conditions).toHaveLength(0)

  await mk({ name: 'Auto 2' })
  await mk({ name: 'Auto 3' })
  const all = await caller.getByProject({ projectId })
  expect(all[0].sort_order).toBe(0)
  expect(all[1].sort_order).toBe(1)
  expect(all[2].sort_order).toBe(2)

  const p2 = (await caller.create({
    project_id: projectId2,
    name: 'P2 Auto',
    trigger_config: triggerConfig,
    actions
  } as never)) as Automation
  expect(p2.sort_order).toBe(0)

  const described = await mk({ name: 'Described', description: 'A desc' })
  expect(described.description).toBe('A desc')

  const conditional = await mk({
    name: 'Conditional',
    conditions: [{ type: 'task_property', params: { field: 'status', operator: 'equals', value: 'done' } }]
  })
  expect(conditional.conditions).toHaveLength(1)
  expect(conditional.conditions[0].type).toBe('task_property')
})

test('automations router: getByProject filter / isolation / empty / ordered', async () => {
  const p1 = await caller.getByProject({ projectId })
  expect(p1.length).toBeGreaterThan(0)
  for (const a of p1) expect(a.project_id).toBe(projectId)
  for (const a of await caller.getByProject({ projectId: projectId2 })) expect(a.project_id).toBe(projectId2)
  expect(await caller.getByProject({ projectId: 'nonexistent' })).toHaveLength(0)
  for (let i = 1; i < p1.length; i++) expect(p1[i].sort_order).toBeGreaterThanOrEqual(p1[i - 1].sort_order)
})

test('automations router: get by id / null for missing', async () => {
  const all = await caller.getByProject({ projectId })
  const a = await caller.get({ id: all[0].id })
  expect(a!.id).toBe(all[0].id)
  expect(await caller.get({ id: 'nonexistent' })).toBeNull()
})

test('automations router: update name / enabled / trigger / multi / no-op / conditions / sort_order', async () => {
  const all = await caller.getByProject({ projectId })
  const id = all[0].id
  const renamed = (await caller.update({ id, name: 'Renamed' } as never)) as Automation
  expect(renamed.name).toBe('Renamed')
  expect(renamed.trigger_config.type).toBe(all[0].trigger_config.type)

  expect(((await caller.update({ id, enabled: false } as never)) as Automation).enabled).toBe(false)
  expect(((await caller.update({ id, enabled: true } as never)) as Automation).enabled).toBe(true)

  expect(
    ((await caller.update({ id, trigger_config: { type: 'manual', params: {} } } as never)) as Automation)
      .trigger_config.type
  ).toBe('manual')

  const multi = (await caller.update({
    id,
    name: 'Multi',
    description: 'New desc',
    actions: [{ type: 'change_task_status', params: { status: 'done' } }]
  } as never)) as Automation
  expect(multi.name).toBe('Multi')
  expect(multi.description).toBe('New desc')
  expect(multi.actions[0].type).toBe('change_task_status')

  expect(((await caller.update({ id } as never)) as Automation).name).toBe('Multi')

  const cond = (await caller.update({
    id,
    conditions: [{ type: 'task_property', params: { field: 'worktree_path', operator: 'exists' } }]
  } as never)) as Automation
  expect(cond.conditions).toHaveLength(1)
  expect(cond.conditions[0].params.field).toBe('worktree_path')

  expect(((await caller.update({ id, sort_order: 99 } as never)) as Automation).sort_order).toBe(99)
  await caller.update({ id, sort_order: 0 } as never)
})

test('automations router: delete true/false + CASCADE runs', async () => {
  const a = await mk({ name: 'ToDelete' })
  expect(await caller.delete({ id: a.id })).toBe(true)
  expect(await caller.delete({ id: 'nonexistent' })).toBe(false)

  const withRuns = await mk({ name: 'WithRuns' })
  h.db
    .prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))")
    .run('run-x', withRuns.id)
  expect(h.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').all(withRuns.id)).toHaveLength(1)
  await caller.delete({ id: withRuns.id })
  expect(h.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').all(withRuns.id)).toHaveLength(0)
})

test('automations router: toggle on/off', async () => {
  const all = await caller.getByProject({ projectId })
  expect(((await caller.toggle({ id: all[0].id, enabled: false })) as Automation).enabled).toBe(false)
  expect(((await caller.toggle({ id: all[0].id, enabled: true })) as Automation).enabled).toBe(true)
})

test('automations router: reorder reverse + empty no-op', async () => {
  const all = await caller.getByProject({ projectId })
  const reversed = [...all].reverse().map((a) => a.id)
  await caller.reorder({ ids: reversed })
  const after = await caller.getByProject({ projectId })
  expect(after[0].id).toBe(reversed[0])
  expect(after[after.length - 1].id).toBe(reversed[reversed.length - 1])

  const before = await caller.getByProject({ projectId })
  await caller.reorder({ ids: [] })
  expect(await caller.getByProject({ projectId })).toHaveLength(before.length)
})

test('automations router: getRuns array / DESC order / custom limit / default 50', async () => {
  const base = await caller.getByProject({ projectId })
  expect(Array.isArray(await caller.getRuns({ automationId: base[0].id }))).toBe(true)

  const ordered = await mk({ name: 'RunTest' })
  h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', '2026-01-01')").run('r1', ordered.id)
  h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'error', '2026-01-02')").run('r2', ordered.id)
  const runs = (await caller.getRuns({ automationId: ordered.id })) as AutomationRun[]
  expect(runs).toHaveLength(2)
  expect(runs[0].id).toBe('r2')
  expect(runs[1].id).toBe('r1')

  const limited = await mk({ name: 'LimitTest' })
  for (let i = 0; i < 5; i++)
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run(`lim-${i}`, limited.id)
  expect(await caller.getRuns({ automationId: limited.id, limit: 2 })).toHaveLength(2)

  const def = await mk({ name: 'DefaultLimitTest' })
  for (let i = 0; i < 60; i++)
    h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run(`dl-${i}`, def.id)
  expect(await caller.getRuns({ automationId: def.id })).toHaveLength(50)
})

test('automations router: clearRuns clears own / isolates others', async () => {
  const a = await mk({ name: 'ClearTest' })
  h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('cr-1', a.id)
  h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('cr-2', a.id)
  await caller.clearRuns({ automationId: a.id })
  expect(await caller.getRuns({ automationId: a.id })).toHaveLength(0)

  const a1 = await mk({ name: 'Clear1' })
  const a2 = await mk({ name: 'Clear2' })
  h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('iso-1', a1.id)
  h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('iso-2', a2.id)
  await caller.clearRuns({ automationId: a1.id })
  expect(await caller.getRuns({ automationId: a1.id })).toHaveLength(0)
  expect(await caller.getRuns({ automationId: a2.id })).toHaveLength(1)
})

test('automations router: runManual delegates to engine.executeManual', async () => {
  const a = await mk({ name: 'ManualTest', trigger_config: { type: 'manual', params: {} } })
  manualCalls.length = 0
  await caller.runManual({ id: a.id })
  expect(manualCalls).toHaveLength(1)
  expect(manualCalls[0]).toBe(a.id)
})

test('automations router: reorder duplicate IDs → last occurrence wins', async () => {
  const all = await caller.getByProject({ projectId })
  if (all.length < 2) return
  await caller.reorder({ ids: [all[0].id, all[0].id, all[1].id] })
  expect(((await caller.get({ id: all[0].id })) as Automation).sort_order).toBe(1)
  expect(((await caller.get({ id: all[1].id })) as Automation).sort_order).toBe(2)
})

test('automations router: getRuns limit=0 → empty (SQL LIMIT 0)', async () => {
  const a = await mk({ name: 'Limit0Test' })
  h.db.prepare("INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, 'success', datetime('now'))").run('lz-1', a.id)
  expect(await caller.getRuns({ automationId: a.id, limit: 0 })).toHaveLength(0)
})

test('automations router: deleting project cascades to its automations', async () => {
  const tempProjId = crypto.randomUUID()
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(tempProjId, 'TempProj', '#000', '/tmp/tp')
  const a = (await caller.create({ project_id: tempProjId, name: 'CascadeTest', trigger_config: triggerConfig, actions } as never)) as Automation
  expect(a.id).toBeTruthy()
  h.db.prepare('DELETE FROM projects WHERE id = ?').run(tempProjId)
  expect(await caller.get({ id: a.id })).toBeNull()
})
