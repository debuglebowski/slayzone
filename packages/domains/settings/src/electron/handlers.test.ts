/**
 * Settings handler contract tests
 * Run with: npx tsx packages/domains/settings/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerSettingsHandlers } from './handlers.js'

const h = await createTestHarness()
registerSettingsHandlers(h.ipcMain as never, h.db)

describe('db:settings:get', () => {
  test('returns null for missing key', () => {
    expect(h.invoke('db:settings:get', 'nonexistent')).toBeNull()
  })
})

describe('db:settings:set', () => {
  test('inserts new setting', () => {
    h.invoke('db:settings:set', 'theme', 'dark')
    expect(h.invoke('db:settings:get', 'theme')).toBe('dark')
  })

  test('upserts existing setting', () => {
    h.invoke('db:settings:set', 'theme', 'light')
    expect(h.invoke('db:settings:get', 'theme')).toBe('light')
  })
})

describe('db:settings:getAll', () => {
  test('returns all settings as object', () => {
    h.invoke('db:settings:set', 'foo', 'bar')
    const all = h.invoke('db:settings:getAll') as Record<string, string>
    expect(all['foo']).toBe('bar')
    expect(all['theme']).toBe('light')
  })

  test('includes migration-seeded defaults', () => {
    const all = h.invoke('db:settings:getAll') as Record<string, string>
    expect(all['default_claude_flags']).toBe('--allow-dangerously-skip-permissions')
  })
})

h.cleanup()
console.log('\nDone')
