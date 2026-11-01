import { describe, expect, it } from 'vitest'
import { insertCreatedRow } from './insert-created-row'

describe('creation response racing a board refresh', () => {
  const existing = { id: 'existing', title: 'Test', status: 'todo' }
  const created = { id: 'created', title: 'Test', status: 'todo' }

  it.each(['start', 'end'] as const)('does not duplicate an already refreshed row (%s)', (at) => {
    const refreshed = { ...created, status: 'in_progress' }
    const rows = [existing, refreshed]
    // The subscription fetch completed before the create response reached its callback.
    expect(insertCreatedRow(rows, created, at)).toBe(rows)
    expect(rows.find((row) => row.id === created.id)?.status).toBe('in_progress')
  })

  it('appends a project when the create response arrives first', () => {
    expect(insertCreatedRow([existing], created, 'end')).toEqual([existing, created])
  })

  it('prepends a task without merging distinct IDs with the same title', () => {
    expect(insertCreatedRow([existing], created, 'start')).toEqual([created, existing])
  })

  it('handles repeated creation callbacks without moving the row', () => {
    const rows = insertCreatedRow([existing], created, 'end')
    expect(insertCreatedRow(rows, created, 'start')).toBe(rows)
  })
})
