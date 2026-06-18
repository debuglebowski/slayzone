/**
 * settings router contract tests — exercise the get/set/getAll procedures via
 * tRPC `createCaller` against the in-memory harness DB. Ports the coverage from
 * the legacy settings IPC-handler test
 * (domains/settings/src/electron/handlers.test.ts), including the warmed-cache
 * coherency regression. Theme procs are Electron nativeTheme-backed (AppDeps)
 * and were not covered by the handler test — out of scope here.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { SettingsService } from '@slayzone/settings/server'
import { settingsRouter } from './settings.js'

const h = await createTestHarness()
const ctx = { db: h.slayDb }
// Same singleton (keyed by ctx.db) the router resolves via forDatabase — warm it
// so getCached() readers (the idle-close sweep) observe write-through sets.
const settings = SettingsService.forDatabase(ctx.db)
await settings.warmCache(['terminal_idle_close_value'])
const caller = settingsRouter.createCaller(ctx)

test('settings router: get returns null for missing key', async () => {
  expect(await caller.get({ key: 'nonexistent' })).toBeNull()
})

test('settings router: set inserts then upserts', async () => {
  await caller.set({ key: 'theme', value: 'dark' })
  expect(await caller.get({ key: 'theme' })).toBe('dark')
  await caller.set({ key: 'theme', value: 'light' })
  expect(await caller.get({ key: 'theme' })).toBe('light')
})

test('settings router: getAll returns object incl. migration-seeded defaults', async () => {
  await caller.set({ key: 'foo', value: 'bar' })
  const all = (await caller.getAll()) as Record<string, string>
  expect(all['foo']).toBe('bar')
  expect(all['theme']).toBe('light')
  expect(all['default_claude_flags']).toBe('--allow-dangerously-skip-permissions')
})

test('settings router: set updates the value warmed getCached() readers see', async () => {
  await caller.set({ key: 'terminal_idle_close_value', value: '1800' })
  expect(settings.getCached('terminal_idle_close_value')).toBe('1800')
})

test('settings router: forDatabase returns one shared instance per db (no cache fork)', () => {
  expect(SettingsService.forDatabase(ctx.db) === settings).toBeTruthy()
})
