/**
 * projects router contract tests — exercise the procedures via tRPC `createCaller`
 * against the in-memory harness DB. Ports the coverage from the legacy projects
 * IPC-handler test (domains/projects/src/electron/handlers.test.ts): CRUD, column
 * reindex + status remap, linear state-mapping reconciliation, reorder, and the
 * task_automation_config CRUD + stale-reference cleanup.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { projectsRouter } from './projects.js'

const h = await createTestHarness()
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-projects-')) }
const caller = projectsRouter.createCaller(ctx)

const didThrow = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

test('projects router: create defaults / path / columns reindex / sort_order at end', async () => {
  const alpha = await caller.create({ name: 'Alpha', color: '#ff0000' })
  expect(alpha.name).toBe('Alpha')
  expect(alpha.color).toBe('#ff0000')
  expect(alpha.path).toBeNull()
  expect(alpha.id).toBeTruthy()

  const beta = await caller.create({ name: 'Beta', color: '#0000ff', path: '/tmp/beta' })
  expect(beta.path).toBe('/tmp/beta')

  const cols = await caller.create({
    name: 'Columns Project',
    color: '#aabbcc',
    columnsConfig: [
      { id: 'queue', label: 'Queue', color: 'gray', position: 2, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 3, category: 'started' },
      { id: 'closed', label: 'Closed', color: 'green', position: 9, category: 'completed' }
    ]
  })
  expect(cols.columns_config).toEqual([
    { id: 'queue', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
    { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
    { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' }
  ])

  const all = await caller.list()
  const last = all[all.length - 1]
  const zeta = await caller.create({ name: 'Zeta', color: '#123456' })
  expect(zeta.sort_order).toBe(last.sort_order + 1)
})

test('projects router: list ordered by sort_order (non-decreasing)', async () => {
  const all = await caller.list()
  for (let i = 1; i < all.length; i++) {
    expect(all[i].sort_order).toBeGreaterThanOrEqual(all[i - 1].sort_order)
  }
})

test('projects router: update name / path / autoCreateWorktree set + null / no-op', async () => {
  const all = await caller.list()
  expect((await caller.update({ id: all[0].id, name: 'Gamma' })).name).toBe('Gamma')
  expect((await caller.update({ id: all[1].id, path: '/tmp/new' })).path).toBe('/tmp/new')
  expect(
    (await caller.update({ id: all[0].id, autoCreateWorktreeOnTaskCreate: true }))
      .auto_create_worktree_on_task_create
  ).toBe(1)
  expect(
    (await caller.update({ id: all[0].id, autoCreateWorktreeOnTaskCreate: null }))
      .auto_create_worktree_on_task_create
  ).toBeNull()
  const gamma = (await caller.list()).find((p) => p.name === 'Gamma')!
  expect((await caller.update({ id: gamma.id })).name).toBe('Gamma')
})

test('projects router: columns update remaps task status; null resets to inbox', async () => {
  const project = (await caller.list()).find((p) => p.name === 'Columns Project')!
  const taskId = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, 'Needs remap', 'doing', 3, 0)`
    )
    .run(taskId, project.id)

  const updated = await caller.update({
    id: project.id,
    columnsConfig: [
      { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
      { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
    ]
  })
  expect(updated.columns_config).toEqual([
    { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
    { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
  ])
  expect(
    (h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status
  ).toBe('todo')

  const stale = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, 'Custom', 'custom_status', 3, 0)`
    )
    .run(stale, project.id)
  expect((await caller.update({ id: project.id, columnsConfig: null })).columns_config).toBeNull()
  expect(
    (h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(stale) as { status: string }).status
  ).toBe('inbox')
})

test('projects router: reconciles linear state mappings on columns change', async () => {
  // integration_* tables exist via migrations now (with real FKs), so seed a
  // connection row to satisfy integration_project_mappings.connection_id FK.
  const project = (await caller.list()).find((p) => p.name === 'Columns Project')!
  const connId = 'conn-1'
  h.db
    .prepare(
      `INSERT OR REPLACE INTO integration_connections (id, provider, credential_ref) VALUES (?, 'linear', 'cred-ref')`
    )
    .run(connId)
  const mappingId = crypto.randomUUID()
  h.db
    .prepare(
      `INSERT OR REPLACE INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key, external_project_id, sync_mode) VALUES (?, ?, 'linear', ?, 'team-1', 'ENG', NULL, 'two_way')`
    )
    .run(mappingId, project.id, connId)
  h.db
    .prepare(
      `INSERT OR REPLACE INTO integration_state_mappings (id, provider, project_mapping_id, local_status, state_id, state_type) VALUES (?, 'linear', ?, 'todo_old', 'st-unstarted', 'unstarted'), (?, 'linear', ?, 'done_old', 'st-completed', 'completed')`
    )
    .run(crypto.randomUUID(), mappingId, crypto.randomUUID(), mappingId)

  await caller.update({
    id: project.id,
    columnsConfig: [
      { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'shipped', label: 'Shipped', color: 'green', position: 1, category: 'completed' }
    ]
  })
  const rows = h.db
    .prepare(
      `SELECT local_status, state_id, state_type FROM integration_state_mappings WHERE provider = 'linear' AND project_mapping_id = ? ORDER BY local_status`
    )
    .all(mappingId) as Array<{ local_status: string; state_id: string; state_type: string }>
  expect(rows).toEqual([
    { local_status: 'queued', state_id: 'st-unstarted', state_type: 'unstarted' },
    { local_status: 'shipped', state_id: 'st-completed', state_type: 'completed' }
  ])
})

test('projects router: delete true/false', async () => {
  const temp = await caller.create({ name: 'Temp', color: '#000000' })
  expect(await caller.delete({ id: temp.id })).toBe(true)
  expect(await caller.delete({ id: 'nope' })).toBe(false)
})

test('projects router: reorder reverse / partial throws / empty no-op', async () => {
  const before = await caller.list()
  const reversed = [...before].reverse().map((p) => p.id)
  await caller.reorder({ projectIds: reversed })
  const after = await caller.list()
  expect(after.map((p) => p.id)).toEqual(reversed)
  expect(after[0].sort_order).toBe(0)
  expect(after[1].sort_order).toBe(1)

  expect(await didThrow(() => caller.reorder({ projectIds: [before[0].id] }))).toBe(true)

  const beforeEmpty = await caller.list()
  await caller.reorder({ projectIds: [] })
  expect((await caller.list()).map((p) => p.id)).toEqual(beforeEmpty.map((p) => p.id))
})

test('projects router: first project gets sort_order 0', async () => {
  for (const p of await caller.list()) await caller.delete({ id: p.id })
  expect((await caller.create({ name: 'First', color: '#111111' })).sort_order).toBe(0)
})

test('projects router: task_automation_config null default / set / both / clear / round-trip / no-op preserve', async () => {
  expect(
    (await caller.create({ name: 'AutoDefault', color: '#000000' })).task_automation_config
  ).toBeNull()

  const set = await caller.create({ name: 'AutoSet', color: '#111111' })
  expect(
    (
      await caller.update({
        id: set.id,
        taskAutomationConfig: { on_terminal_active: 'in_progress', on_terminal_idle: null }
      })
    ).task_automation_config
  ).toEqual({ on_terminal_active: 'in_progress', on_terminal_idle: null })

  const both = await caller.create({ name: 'AutoBoth', color: '#222222' })
  const bothUpdated = await caller.update({
    id: both.id,
    taskAutomationConfig: { on_terminal_active: 'in_progress', on_terminal_idle: 'review' }
  })
  expect(bothUpdated.task_automation_config.on_terminal_active).toBe('in_progress')
  expect(bothUpdated.task_automation_config.on_terminal_idle).toBe('review')

  const clear = await caller.create({ name: 'AutoClear', color: '#333333' })
  await caller.update({
    id: clear.id,
    taskAutomationConfig: { on_terminal_active: 'todo', on_terminal_idle: null }
  })
  expect(
    (await caller.update({ id: clear.id, taskAutomationConfig: null })).task_automation_config
  ).toBeNull()

  const rt = await caller.create({ name: 'AutoRoundTrip', color: '#444444' })
  await caller.update({
    id: rt.id,
    taskAutomationConfig: { on_terminal_active: 'doing', on_terminal_idle: 'review' }
  })
  expect((await caller.list()).find((p) => p.id === rt.id)!.task_automation_config).toEqual({
    on_terminal_active: 'doing',
    on_terminal_idle: 'review'
  })

  const pre = await caller.create({ name: 'AutoPreserve', color: '#555555' })
  await caller.update({
    id: pre.id,
    taskAutomationConfig: { on_terminal_active: 'todo', on_terminal_idle: null }
  })
  expect((await caller.update({ id: pre.id })).task_automation_config).toEqual({
    on_terminal_active: 'todo',
    on_terminal_idle: null
  })
})

test('projects router: task_automation_config stale-reference cleanup', async () => {
  const startCols = [
    { id: 'doing', label: 'Doing', color: 'blue', position: 0, category: 'started' },
    { id: 'review', label: 'Review', color: 'purple', position: 1, category: 'started' },
    { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' }
  ]
  const dropToTodoDone = [
    { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
    { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
  ]

  // active cleared when 'doing' removed
  const a = await caller.create({ name: 'StaleActive', color: '#660000', columnsConfig: startCols })
  await caller.update({ id: a.id, taskAutomationConfig: { on_terminal_active: 'doing', on_terminal_idle: null } })
  expect(
    (await caller.update({ id: a.id, columnsConfig: dropToTodoDone })).task_automation_config
      .on_terminal_active
  ).toBeNull()

  // idle cleared when 'review' removed
  const b = await caller.create({ name: 'StaleIdle', color: '#770000', columnsConfig: startCols })
  await caller.update({ id: b.id, taskAutomationConfig: { on_terminal_active: null, on_terminal_idle: 'review' } })
  expect(
    (
      await caller.update({
        id: b.id,
        columnsConfig: [
          { id: 'doing', label: 'Doing', color: 'blue', position: 0, category: 'started' },
          { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
        ]
      })
    ).task_automation_config.on_terminal_idle
  ).toBeNull()

  // both cleared
  const c = await caller.create({ name: 'StaleBoth', color: '#880000', columnsConfig: startCols })
  await caller.update({ id: c.id, taskAutomationConfig: { on_terminal_active: 'doing', on_terminal_idle: 'review' } })
  const cUpdated = await caller.update({ id: c.id, columnsConfig: dropToTodoDone })
  expect(cUpdated.task_automation_config.on_terminal_active).toBeNull()
  expect(cUpdated.task_automation_config.on_terminal_idle).toBeNull()

  // partial: keep valid 'todo', drop 'doing'
  const d = await caller.create({
    name: 'StalePartial',
    color: '#990000',
    columnsConfig: [
      { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' },
      { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' }
    ]
  })
  await caller.update({ id: d.id, taskAutomationConfig: { on_terminal_active: 'todo', on_terminal_idle: 'doing' } })
  const dUpdated = await caller.update({ id: d.id, columnsConfig: dropToTodoDone })
  expect(dUpdated.task_automation_config.on_terminal_active).toBe('todo')
  expect(dUpdated.task_automation_config.on_terminal_idle).toBeNull()

  // no config → no error, stays null
  const e = await caller.create({ name: 'StaleNull', color: '#aa0000', columnsConfig: dropToTodoDone })
  expect(
    (
      await caller.update({
        id: e.id,
        columnsConfig: [
          { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
          { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
        ]
      })
    ).task_automation_config
  ).toBeNull()

  // keep referenced statuses (only label changes) → config preserved
  const f = await caller.create({
    name: 'StaleKeep',
    color: '#bb0000',
    columnsConfig: [
      { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' },
      { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' }
    ]
  })
  await caller.update({ id: f.id, taskAutomationConfig: { on_terminal_active: 'doing', on_terminal_idle: 'todo' } })
  const fUpdated = await caller.update({
    id: f.id,
    columnsConfig: [
      { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' },
      { id: 'done', label: 'Shipped', color: 'green', position: 2, category: 'completed' }
    ]
  })
  expect(fUpdated.task_automation_config.on_terminal_active).toBe('doing')
  expect(fUpdated.task_automation_config.on_terminal_idle).toBe('todo')
})
