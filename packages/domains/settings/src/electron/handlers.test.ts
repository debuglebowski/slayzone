/**
 * Settings handler contract tests
 * Run with: npx tsx packages/domains/settings/src/main/handlers.test.ts
 */
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../shared/test-utils/ipc-harness.js'
import { registerSettingsHandlers } from './handlers.js'
import { SettingsService } from '../server/service.js'

const h = await createTestHarness()
// Handlers share the app's warmed SettingsService instance so an IPC `set`
// writes through the same cache that synchronous getCached() readers see.
const settings = SettingsService.forDatabase(h.db)
await settings.warmCache(['terminal_idle_close_value'])
registerSettingsHandlers(h.ipcMain as never, settings)

// Awaited so each block's queued async tests finish before the next starts and
// before cleanup() closes the DB (the runner queues async tests off-stack).
await describe('db:settings:get', () => {
  test('returns null for missing key', async () => {
    expect(await h.invoke('db:settings:get', 'nonexistent')).toBeNull()
  })
})

await describe('db:settings:set', () => {
  test('inserts new setting', async () => {
    await h.invoke('db:settings:set', 'theme', 'dark')
    expect(await h.invoke('db:settings:get', 'theme')).toBe('dark')
  })

  test('upserts existing setting', async () => {
    await h.invoke('db:settings:set', 'theme', 'light')
    expect(await h.invoke('db:settings:get', 'theme')).toBe('light')
  })
})

await describe('db:settings:getAll', () => {
  test('returns all settings as object', async () => {
    await h.invoke('db:settings:set', 'foo', 'bar')
    const all = (await h.invoke('db:settings:getAll')) as Record<string, string>
    expect(all['foo']).toBe('bar')
    expect(all['theme']).toBe('light')
  })

  test('includes migration-seeded defaults', async () => {
    const all = (await h.invoke('db:settings:getAll')) as Record<string, string>
    expect(all['default_claude_flags']).toBe('--allow-dangerously-skip-permissions')
  })
})

await describe('warmed-cache coherency', () => {
  // Regression: idle-close timeout never propagated because the IPC set handler
  // wrote to a SEPARATE SettingsService instance, leaving the warmed getCached()
  // value the idle sweep reads permanently stale.
  test('IPC set updates the value warmed readers see via getCached', async () => {
    await h.invoke('db:settings:set', 'terminal_idle_close_value', '1800')
    expect(settings.getCached('terminal_idle_close_value')).toBe('1800')
  })

  test('forDatabase returns the one shared instance per DB (no cache fork)', () => {
    expect(SettingsService.forDatabase(h.db) === settings).toBeTruthy()
  })
})

h.cleanup()
console.log('\nDone')
