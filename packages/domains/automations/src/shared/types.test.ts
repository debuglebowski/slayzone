/**
 * Shared type utility tests
 */
import { describe, expect, test } from 'vitest'
import { parseAutomationRow, type AutomationRow } from './types.js'

function makeRow(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: 'a1',
    project_id: 'p1',
    name: 'Test',
    description: null,
    enabled: 1,
    trigger_config: JSON.stringify({ type: 'manual', params: {} }),
    conditions: null,
    actions: JSON.stringify([{ type: 'run_command', params: { command: 'echo hi' } }]),
    run_count: 0,
    last_run_at: null,
    catchup_on_start: 0,
    sort_order: 0,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides
  }
}

describe('parseAutomationRow — enabled field', () => {
  test('enabled: 1 → true', () => {
    const result = parseAutomationRow(makeRow({ enabled: 1 }))
    expect(result.enabled).toBe(true)
  })

  test('enabled: 0 → false', () => {
    const result = parseAutomationRow(makeRow({ enabled: 0 }))
    expect(result.enabled).toBe(false)
  })
})

describe('parseAutomationRow — JSON parsing', () => {
  test('parses trigger_config JSON', () => {
    const result = parseAutomationRow(
      makeRow({ trigger_config: '{"type":"task_status_change","params":{"toStatus":"done"}}' })
    )
    expect(result.trigger_config.type).toBe('task_status_change')
    expect((result.trigger_config.params as { toStatus: string }).toStatus).toBe('done')
  })

  test('parses actions JSON', () => {
    const result = parseAutomationRow(
      makeRow({ actions: '[{"type":"run_command","params":{"command":"ls"}}]' })
    )
    expect(result.actions.length).toBe(1)
    expect(result.actions[0].type).toBe('run_command')
  })

  test('conditions null → empty array', () => {
    const result = parseAutomationRow(makeRow({ conditions: null }))
    expect(result.conditions.length).toBe(0)
  })

  test('parses conditions JSON array', () => {
    const result = parseAutomationRow(
      makeRow({
        conditions:
          '[{"type":"task_property","params":{"field":"status","operator":"equals","value":"done"}}]'
      })
    )
    expect(result.conditions.length).toBe(1)
    expect(result.conditions[0].type).toBe('task_property')
  })

  test('empty actions array parses correctly', () => {
    const result = parseAutomationRow(makeRow({ actions: '[]' }))
    expect(result.actions.length).toBe(0)
  })
})

describe('parseAutomationRow — passthrough fields', () => {
  test('preserves id, project_id, name, description', () => {
    const result = parseAutomationRow(
      makeRow({ id: 'xyz', project_id: 'p99', name: 'My Auto', description: 'desc' })
    )
    expect(result.id).toBe('xyz')
    expect(result.project_id).toBe('p99')
    expect(result.name).toBe('My Auto')
    expect(result.description).toBe('desc')
  })

  test('preserves run_count and last_run_at', () => {
    const result = parseAutomationRow(makeRow({ run_count: 42, last_run_at: '2026-03-01' }))
    expect(result.run_count).toBe(42)
    expect(result.last_run_at).toBe('2026-03-01')
  })

  test('preserves sort_order, created_at, updated_at', () => {
    const result = parseAutomationRow(
      makeRow({ sort_order: 5, created_at: '2026-01-01', updated_at: '2026-02-01' })
    )
    expect(result.sort_order).toBe(5)
    expect(result.created_at).toBe('2026-01-01')
    expect(result.updated_at).toBe('2026-02-01')
  })
})
