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
import { TypedEmitter } from '@slayzone/platform/events'
import { settingsRouter } from './settings.js'
import { setNotifyEvents, type NotifyEventMap } from '../app-deps.js'

const h = await createTestHarness()
const ctx = { db: h.slayDb, dataRoot: '' }
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

test('settings router: set tells every window which key changed (cross-window sync)', async () => {
  // A second window (secondary task window) learns of this window's settings writes
  // only through notify.onSettingsChanged — set must signal it, scoped to the key.
  const ev = new TypedEmitter<NotifyEventMap>()
  setNotifyEvents(ev)
  const seen: unknown[] = []
  ev.on('settings-changed', (change) => seen.push(change))
  await caller.set({ key: 'panel_config', value: '{"webPanels":[]}' })
  expect(seen).toEqual([{ keys: ['panel_config'] }])
})

test('settings router: forDatabase returns one shared instance per db (no cache fork)', () => {
  expect(SettingsService.forDatabase(ctx.db) === settings).toBeTruthy()
})

// --- Per user (T-16) --------------------------------------------------------
// A request that carries a user (a hub with login) gets its own copy of every
// per-user key and shares the hub's keys; a request without one (above, and the
// desktop app's hub) keeps the global table. The client sends nothing new.
const principal = (userId: string) => ({ userId, role: 'user' as const, scopes: ['full' as const] })
const callerA = settingsRouter.createCaller({
  db: h.slayDb,
  dataRoot: '',
  principal: principal('user-a')
})
const callerB = settingsRouter.createCaller({
  db: h.slayDb,
  dataRoot: '',
  principal: principal('user-b')
})

test('settings router: viewState is per user, and never falls back to the global row', async () => {
  await caller.set({ key: 'viewState', value: 'global-tabs' })
  expect(await callerA.get({ key: 'viewState' })).toBeNull()
  await callerA.set({ key: 'viewState', value: 'a-tabs' })
  await callerB.set({ key: 'viewState', value: 'b-tabs' })
  expect(await callerA.get({ key: 'viewState' })).toBe('a-tabs')
  expect(await callerB.get({ key: 'viewState' })).toBe('b-tabs')
  // The request without a user still sees (only) the global row.
  expect(await caller.get({ key: 'viewState' })).toBe('global-tabs')
  const rows = h.db
    .prepare(`SELECT user_id, value FROM user_settings WHERE key = 'viewState' ORDER BY user_id`)
    .all()
  expect(rows).toEqual([
    { user_id: 'user-a', value: 'a-tabs' },
    { user_id: 'user-b', value: 'b-tabs' }
  ])
})

test('settings router: hub keys are shared by every user and the global table', async () => {
  await callerA.set({ key: 'default_terminal_mode', value: 'codex' })
  expect(await callerB.get({ key: 'default_terminal_mode' })).toBe('codex')
  expect(await caller.get({ key: 'default_terminal_mode' })).toBe('codex')
  const n = h.db
    .prepare(`SELECT count(*) AS n FROM user_settings WHERE key = 'default_terminal_mode'`)
    .get() as { n: number }
  expect(n.n).toBe(0)
  // Write-through still reaches the warmed sync readers from a user's request.
  await callerB.set({ key: 'terminal_idle_close_value', value: '45' })
  expect(settings.getCached('terminal_idle_close_value')).toBe('45')
})

test("settings router: getAll for a user = hub keys + their own keys, never another user's", async () => {
  await callerA.set({ key: 'panel_config', value: 'a-panels' })
  const all = (await callerB.getAll()) as Record<string, string>
  expect(all['viewState']).toBe('b-tabs')
  expect(all['default_terminal_mode']).toBe('codex')
  expect('panel_config' in all).toBe(false)
  // Global per-user rows (the pre-login state) are not served to users either.
  expect('foo' in all).toBe(false)
  expect('theme' in all).toBe(false)
  expect(((await callerA.getAll()) as Record<string, string>)['panel_config']).toBe('a-panels')
})

test('settings router: integration credentials are never served or written, to anyone', async () => {
  h.db
    .prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run('integration:credential:ref-1', 'plain:ghp_secret')
  for (const c of [caller, callerA]) {
    expect(await c.get({ key: 'integration:credential:ref-1' })).toBeNull()
    const all = (await c.getAll()) as Record<string, string>
    expect(Object.keys(all).some((k) => k.startsWith('integration:credential:'))).toBe(false)
    let threw = false
    try {
      await c.set({ key: 'integration:credential:ref-1', value: 'plain:evil' })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  }
  const row = h.db
    .prepare(`SELECT value FROM settings WHERE key = 'integration:credential:ref-1'`)
    .get() as { value: string }
  expect(row.value).toBe('plain:ghp_secret')
})
