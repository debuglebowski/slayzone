/**
 * `searchTasksOp`: the hub-side task search — title and description, archived
 * tasks included (a board may not hold them), deleted ones never. Every term
 * must match; title hits rank above description-only hits.
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { isFullTaskRow } from '@slayzone/task-contracts'
import { searchTasksOp } from './search.js'

async function setup() {
  const h = await createTestHarness()
  const project = (name: string) => {
    const id = crypto.randomUUID()
    h.db
      .prepare('INSERT INTO projects (id, name, color, columns_config) VALUES (?, ?, ?, ?)')
      .run(id, name, '#000', JSON.stringify([]))
    return id
  }
  const p1 = project('One')
  const p2 = project('Two')
  const task = (projectId: string, title: string, extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID()
    const cols = {
      id,
      project_id: projectId,
      title,
      status: 'todo',
      priority: 3,
      order: 0,
      ...extra
    }
    const keys = Object.keys(cols)
    h.db
      .prepare(
        `INSERT INTO tasks (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`
      )
      .run(...Object.values(cols))
    return id
  }
  return { h, p1, p2, task }
}

const ids = (r: { tasks: { id: string }[] }) => r.tasks.map((t) => t.id)

test('matches title and description, case-insensitive; title hits first', async () => {
  const s = await setup()
  const inDesc = s.task(s.p1, 'Something else', {
    description: 'fix the Hub freeze',
    updated_at: '2026-01-03'
  })
  const inTitle = s.task(s.p1, 'Hub freeze report', { updated_at: '2026-01-01' })
  s.task(s.p1, 'Unrelated')
  const r = await searchTasksOp(s.h.slayDb, { query: 'hub FREEZE' })
  expect(ids(r)).toEqual([inTitle, inDesc])
  s.h.cleanup()
})

test('every term must match (in title or description)', async () => {
  const s = await setup()
  const both = s.task(s.p1, 'Hub traffic', { description: 'board reload' })
  s.task(s.p1, 'Hub only')
  expect(ids(await searchTasksOp(s.h.slayDb, { query: 'hub reload' }))).toEqual([both])
  s.h.cleanup()
})

test('archived tasks are found; deleted ones never', async () => {
  const s = await setup()
  const archived = s.task(s.p1, 'Old needle', { archived_at: '2026-01-01' })
  s.task(s.p1, 'Gone needle', { deleted_at: '2026-01-01' })
  expect(ids(await searchTasksOp(s.h.slayDb, { query: 'needle' }))).toEqual([archived])
  s.h.cleanup()
})

test('LIKE wildcards in the query are literal', async () => {
  const s = await setup()
  const pct = s.task(s.p1, '100% done')
  s.task(s.p1, '100 done')
  expect(ids(await searchTasksOp(s.h.slayDb, { query: '100%' }))).toEqual([pct])
  s.h.cleanup()
})

test('scoped to a project, and to the caller’s projects; limit applies after both', async () => {
  const s = await setup()
  const a = s.task(s.p1, 'needle a')
  const b = s.task(s.p2, 'needle b')
  expect(ids(await searchTasksOp(s.h.slayDb, { query: 'needle', projectId: s.p2 }))).toEqual([b])
  expect(ids(await searchTasksOp(s.h.slayDb, { query: 'needle', limit: 1 }, [s.p1]))).toEqual([a])
  expect(ids(await searchTasksOp(s.h.slayDb, { query: 'needle' }, []))).toEqual([])
  s.h.cleanup()
})

test('answers card rows and says whether there were more', async () => {
  const s = await setup()
  for (let i = 0; i < 3; i++) s.task(s.p1, `needle ${i}`, { description: 'body' })
  const r = await searchTasksOp(s.h.slayDb, { query: 'needle', limit: 2 })
  expect(r.tasks).toHaveLength(2)
  expect(r.hasMore).toBe(true)
  expect(isFullTaskRow(r.tasks[0]!)).toBe(false)
  expect(await searchTasksOp(s.h.slayDb, { query: '   ' })).toEqual({ tasks: [], hasMore: false })
  s.h.cleanup()
})
