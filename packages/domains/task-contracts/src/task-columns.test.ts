import { describe, expect, it } from 'vitest'
import { decodeTaskColumns, encodeTaskColumns } from './task-columns'
import type { Task } from './types'

const t = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, status: 'todo', archived_at: null, ...extra }) as unknown as Task

describe('task columns', () => {
  it('round-trips rows exactly, nulls and nested values included', () => {
    const rows = [
      t('a', { panel_visibility: { terminal: true } }),
      t('b', { panel_visibility: null })
    ]
    const cols = encodeTaskColumns(rows)!
    expect(cols.keys).toEqual(['id', 'title', 'status', 'archived_at', 'panel_visibility'])
    expect(decodeTaskColumns(cols)).toEqual(rows)
  })

  it('names each key once (the point: fewer bytes than row objects)', () => {
    const rows = Array.from({ length: 50 }, (_, i) => t(`t${i}`))
    expect(JSON.stringify(encodeTaskColumns(rows)).length).toBeLessThan(
      JSON.stringify(rows).length * 0.7
    )
  })

  it('refuses rows whose key sets differ (absent ≠ null for a card row)', () => {
    expect(encodeTaskColumns([t('a'), { ...t('b'), extra: 1 } as unknown as Task])).toBeNull()
  })

  it('encodes no rows as no columns', () => {
    expect(decodeTaskColumns(encodeTaskColumns([])!)).toEqual([])
  })
})
