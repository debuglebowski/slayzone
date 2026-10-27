import { describe, test, expect } from 'vitest'
import { getSharedStatusColumns } from './columns'
import { DEFAULT_COLUMNS, type ColumnConfig } from './types'

const ids = (columns: ColumnConfig[]): string => columns.map((c) => c.id).join(',')

const custom: ColumnConfig[] = [
  { id: 'todo', label: 'To do', color: 'blue', position: 0, category: 'unstarted' },
  { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' },
  { id: 'done', label: 'Shipped', color: 'green', position: 2, category: 'completed' }
]
const disjoint: ColumnConfig[] = [
  { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
  { id: 'closed', label: 'Closed', color: 'green', position: 1, category: 'completed' }
]
// No completed column → fails validation → the project uses the defaults.
const invalid: ColumnConfig[] = [
  { id: 'doing', label: 'Doing', color: 'yellow', position: 0, category: 'started' }
]
const defaultIds = ids(DEFAULT_COLUMNS)

describe('one project: all of its statuses', () => {
  test('one project → its columns', () => {
    expect(ids(getSharedStatusColumns([custom]))).toBe('todo,doing,done')
  })

  test('one unconfigured project → defaults', () => {
    expect(ids(getSharedStatusColumns([null]))).toBe(defaultIds)
  })
})

describe('several projects: only statuses every one of them has', () => {
  test('two unconfigured projects → defaults', () => {
    expect(ids(getSharedStatusColumns([null, undefined]))).toBe(defaultIds)
  })

  test('defaults + custom → the ids both have', () => {
    expect(ids(getSharedStatusColumns([null, custom]))).toBe('todo,done')
  })

  test('custom + defaults → same ids, in the first project’s order', () => {
    expect(ids(getSharedStatusColumns([custom, null]))).toBe('todo,done')
  })

  test('labels come from the first project', () => {
    expect(getSharedStatusColumns([custom, null]).find((c) => c.id === 'done')?.label).toBe(
      'Shipped'
    )
  })

  test('no overlap → nothing shared', () => {
    expect(getSharedStatusColumns([null, disjoint])).toHaveLength(0)
  })
})

describe('same resolution as the backend: an invalid config means the defaults', () => {
  test('invalid config counts as the defaults', () => {
    expect(ids(getSharedStatusColumns([invalid, null]))).toBe(defaultIds)
  })
})

describe('nothing selected', () => {
  test('no projects → nothing shared', () => {
    expect(getSharedStatusColumns([])).toHaveLength(0)
  })
})
