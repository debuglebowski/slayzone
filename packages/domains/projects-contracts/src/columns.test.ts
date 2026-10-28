/**
 * Project column utility tests
 */
import { describe, expect, test } from 'vitest'
import { DEFAULT_COLUMNS, type ColumnConfig } from './types.js'
import {
  getDefaultStatus,
  getDoneStatus,
  isCompletedStatus,
  isKnownStatus,
  isTerminalStatus,
  normalizeStatusOrDefault,
  parseColumnsConfig,
  resolveColumns,
  resolveStatusId,
  validateColumns
} from './columns.js'

const customColumns: ColumnConfig[] = [
  { id: 'blocked', label: 'Blocked', color: 'red', position: 2, category: 'started' },
  { id: 'queue', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
  { id: 'closed', label: 'Closed', color: 'green', position: 4, category: 'completed' },
  { id: 'wontfix', label: 'Wontfix', color: 'slate', position: 5, category: 'canceled' }
]

describe('validateColumns', () => {
  test('sorts columns and normalizes positions', () => {
    const normalized = validateColumns(customColumns)
    expect(normalized).toEqual([
      { id: 'queue', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'blocked', label: 'Blocked', color: 'red', position: 1, category: 'started' },
      { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' },
      { id: 'wontfix', label: 'Wontfix', color: 'slate', position: 3, category: 'canceled' }
    ])
  })

  test('orders columns by workflow category before position', () => {
    const scrambled: ColumnConfig[] = [
      { id: 'doneish', label: 'Doneish', color: 'green', position: 0, category: 'completed' },
      { id: 'queue', label: 'Queue', color: 'gray', position: 99, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
      { id: 'backlog', label: 'Backlog', color: 'slate', position: 2, category: 'backlog' }
    ]

    const normalized = validateColumns(scrambled)
    expect(normalized.map((column) => column.id)).toEqual(['backlog', 'queue', 'doing', 'doneish'])
  })

  test('requires at least one completed column', () => {
    const invalid: ColumnConfig[] = [
      { id: 'queue', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
      { id: 'canceled', label: 'Canceled', color: 'slate', position: 2, category: 'canceled' }
    ]
    expect(() => validateColumns(invalid)).toThrow()
  })
})

describe('parseColumnsConfig/resolveColumns', () => {
  test('parses and validates JSON payloads', () => {
    const parsed = parseColumnsConfig(JSON.stringify(customColumns))
    expect(parsed?.map((column) => column.id)).toEqual(['queue', 'blocked', 'closed', 'wontfix'])
  })

  test('returns null for invalid JSON or invalid shape', () => {
    expect(parseColumnsConfig('{bad json')).toBeNull()
    expect(parseColumnsConfig('{"foo":"bar"}')).toBeNull()
  })

  test('falls back to defaults on invalid config', () => {
    const resolved = resolveColumns(parseColumnsConfig('{"foo":"bar"}'))
    expect(resolved).toEqual(DEFAULT_COLUMNS)
  })

  test('returns cloned defaults so callers cannot mutate shared constants', () => {
    const resolved = resolveColumns(null)
    expect(resolved).toEqual(DEFAULT_COLUMNS)
    expect(resolved === DEFAULT_COLUMNS).toBe(false)
    resolved[0].label = 'Mutated'
    expect(DEFAULT_COLUMNS[0].label).toBe('Inbox')
  })
})

describe('status helpers', () => {
  test('computes project default and done statuses', () => {
    expect(getDefaultStatus(customColumns)).toBe('queue')
    expect(getDoneStatus(customColumns)).toBe('closed')
  })

  test('handles terminal/completed semantics by category', () => {
    expect(isTerminalStatus('closed', customColumns)).toBe(true)
    expect(isTerminalStatus('wontfix', customColumns)).toBe(true)
    expect(isTerminalStatus('blocked', customColumns)).toBe(false)

    expect(isCompletedStatus('closed', customColumns)).toBe(true)
    expect(isCompletedStatus('wontfix', customColumns)).toBe(false)
  })

  test('normalizes unknown statuses to the project default', () => {
    expect(isKnownStatus('blocked', customColumns)).toBe(true)
    expect(isKnownStatus('not_real', customColumns)).toBe(false)
    expect(normalizeStatusOrDefault('not_real', customColumns)).toBe('queue')
    expect(normalizeStatusOrDefault('blocked', customColumns)).toBe('blocked')
  })
})

describe('resolveStatusId', () => {
  test('matches by exact ID', () => {
    expect(resolveStatusId('in_progress', null)).toBe('in_progress')
    expect(resolveStatusId('blocked', customColumns)).toBe('blocked')
  })

  test('matches by case-insensitive label', () => {
    expect(resolveStatusId('In Progress', null)).toBe('in_progress')
    expect(resolveStatusId('in progress', null)).toBe('in_progress')
    expect(resolveStatusId('IN PROGRESS', null)).toBe('in_progress')
    expect(resolveStatusId('Blocked', customColumns)).toBe('blocked')
  })

  test('matches by slugified label', () => {
    expect(resolveStatusId('in-progress', null)).toBe('in_progress')
    expect(resolveStatusId('In-Progress', null)).toBe('in_progress')
  })

  test('matches underscore input via slug', () => {
    const cols: ColumnConfig[] = [
      { id: 'status-1', label: 'Code Review', color: 'purple', position: 0, category: 'started' },
      { id: 'status-2', label: 'Done', color: 'green', position: 1, category: 'completed' }
    ]
    expect(resolveStatusId('code_review', cols)).toBe('status-1')
  })

  test('exact ID takes priority over label match', () => {
    const cols: ColumnConfig[] = [
      { id: 'my-status', label: 'My Status', color: 'blue', position: 0, category: 'unstarted' },
      { id: 'other', label: 'my-status', color: 'green', position: 1, category: 'completed' }
    ]
    expect(resolveStatusId('my-status', cols)).toBe('my-status')
  })

  test('returns null for unknown input', () => {
    expect(resolveStatusId('nonexistent', null)).toBeNull()
    expect(resolveStatusId('nope', customColumns)).toBeNull()
  })
})
