import { expect, test } from 'vitest'
import { validateReparent, type ReparentTaskRow } from './reparent-validation'

function makeLookup(rows: ReparentTaskRow[]): (id: string) => ReparentTaskRow | null {
  const map = new Map(rows.map((r) => [r.id, r]))
  return (id) => map.get(id) ?? null
}

// Self-parent
test('self-parent should fail', () => {
  const lookup = makeLookup([{ id: 'a', project_id: 'p', parent_id: null }])
  const r = validateReparent({ taskId: 'a', parentId: 'a', lookup })
  expect(r).toEqual({ ok: false, error: 'self' })
})

// Detach
test('detach should succeed', () => {
  const lookup = makeLookup([
    { id: 'a', project_id: 'p', parent_id: 'b' },
    { id: 'b', project_id: 'p', parent_id: null }
  ])
  const r = validateReparent({ taskId: 'a', parentId: null, lookup })
  expect(r).toEqual({ ok: true })
})

// Missing task
test('missing task', () => {
  const lookup = makeLookup([])
  const r = validateReparent({ taskId: 'x', parentId: 'y', lookup })
  expect(r).toEqual({ ok: false, error: 'missing-task' })
})

// Missing parent
test('missing parent', () => {
  const lookup = makeLookup([{ id: 'a', project_id: 'p', parent_id: null }])
  const r = validateReparent({ taskId: 'a', parentId: 'missing', lookup })
  expect(r).toEqual({ ok: false, error: 'missing-parent' })
})

// Archived parent
test('archived parent', () => {
  const lookup = makeLookup([
    { id: 'a', project_id: 'p', parent_id: null },
    { id: 'b', project_id: 'p', parent_id: null, archived_at: '2026-01-01' }
  ])
  const r = validateReparent({ taskId: 'a', parentId: 'b', lookup })
  expect(r).toEqual({ ok: false, error: 'archived-parent' })
})

// Cross-project
test('cross-project', () => {
  const lookup = makeLookup([
    { id: 'a', project_id: 'p1', parent_id: null },
    { id: 'b', project_id: 'p2', parent_id: null }
  ])
  const r = validateReparent({ taskId: 'a', parentId: 'b', lookup })
  expect(r).toEqual({ ok: false, error: 'cross-project' })
})

// Cycle: a -> b -> c, reparent a under c (walks c -> b -> a => cycle)
test('cycle detect', () => {
  const lookup = makeLookup([
    { id: 'a', project_id: 'p', parent_id: null },
    { id: 'b', project_id: 'p', parent_id: 'a' },
    { id: 'c', project_id: 'p', parent_id: 'b' }
  ])
  const r = validateReparent({ taskId: 'a', parentId: 'c', lookup })
  expect(r).toEqual({ ok: false, error: 'cycle' })
})

// Happy path: sibling reparent under another task
test('happy path reparent', () => {
  const lookup = makeLookup([
    { id: 'a', project_id: 'p', parent_id: null },
    { id: 'b', project_id: 'p', parent_id: null }
  ])
  const r = validateReparent({ taskId: 'a', parentId: 'b', lookup })
  expect(r).toEqual({ ok: true })
})

// Depth >1 allowed: grandparent -> parent, child reparented under parent
test('depth >1 allowed', () => {
  const lookup = makeLookup([
    { id: 'g', project_id: 'p', parent_id: null },
    { id: 'mid', project_id: 'p', parent_id: 'g' },
    { id: 'c', project_id: 'p', parent_id: null }
  ])
  const r = validateReparent({ taskId: 'c', parentId: 'mid', lookup })
  expect(r).toEqual({ ok: true })
})
