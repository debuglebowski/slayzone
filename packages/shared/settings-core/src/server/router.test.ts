/**
 * settings router contract tests — exercise the get/set/getAll procedures via
 * tRPC `createCaller` against the in-memory harness DB. Ports the coverage from
 * the legacy settings IPC-handler test
 * (domains/settings/src/electron/handlers.test.ts), including the warmed-cache
 * coherency regression. Theme procs are Electron nativeTheme-backed (host deps)
 * and were not covered by the handler test — out of scope here.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { test, expect } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { SettingsService } from './service.js'
import { settingsRouter } from './router.js'
import { setSettingsHostDeps, type SettingsChange } from './settings-host-deps.js'

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
  const seen: SettingsChange[] = []
  const unwired = () => {
    throw new Error('theme not wired in this test')
  }
  setSettingsHostDeps({
    themeGetEffective: unwired,
    themeGetSource: unwired,
    themeSet: unwired,
    onSettingsWritten: (change) => seen.push(change)
  })
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
  await callerA.set({ key: 'default_agent_id', value: 'codex' })
  expect(await callerB.get({ key: 'default_agent_id' })).toBe('codex')
  expect(await caller.get({ key: 'default_agent_id' })).toBe('codex')
  const n = h.db
    .prepare(`SELECT count(*) AS n FROM user_settings WHERE key = 'default_agent_id'`)
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
  expect(all['default_agent_id']).toBe('codex')
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

// --- Project overrides (plans/settings-by-scope.md, phase 3) ---

await h.slayDb.run(`INSERT INTO projects (id, name, color) VALUES ('p-ovr', 'Override', '#000')`)

test('settings router: a project override wins over the hub value, clearing restores it', async () => {
  await caller.set({ key: 'default_agent_id', value: 'claude-code' })
  expect(await caller.effective({ key: 'default_agent_id', projectId: 'p-ovr' })).toEqual({
    value: 'claude-code',
    source: 'hub'
  })
  await caller.setProjectOverride({ projectId: 'p-ovr', key: 'default_agent_id', value: 'codex' })
  expect(await caller.effective({ key: 'default_agent_id', projectId: 'p-ovr' })).toEqual({
    value: 'codex',
    source: 'project'
  })
  // The hub itself is untouched.
  expect(await caller.effective({ key: 'default_agent_id' })).toEqual({
    value: 'claude-code',
    source: 'hub'
  })
  expect(await caller.projectOverrides({ projectId: 'p-ovr' })).toEqual({
    default_agent_id: 'codex'
  })
  expect(await caller.overridesOfKey({ key: 'default_agent_id' })).toEqual([
    { projectId: 'p-ovr', value: 'codex' }
  ])
  await caller.clearProjectOverride({ projectId: 'p-ovr', key: 'default_agent_id' })
  expect(await caller.effective({ key: 'default_agent_id', projectId: 'p-ovr' })).toEqual({
    value: 'claude-code',
    source: 'hub'
  })
})

test('settings router: chat defaults per provider are overridable; other keys are not', async () => {
  await caller.setProjectOverride({
    projectId: 'p-ovr',
    key: 'chat_default_mode:claude-code',
    value: 'plan'
  })
  expect(
    (await caller.effective({ key: 'chat_default_mode:claude-code', projectId: 'p-ovr' })).source
  ).toBe('project')
  await expect(
    caller.setProjectOverride({ projectId: 'p-ovr', key: 'terminal_font_size', value: '20' })
  ).rejects.toThrow(/cannot override/)
})

test('settings router: effective resolves a task to its project', async () => {
  await h.slayDb.run(`INSERT INTO projects (id, name, color) VALUES ('p-task', 'T', '#000')`)
  await h.slayDb.run(
    `INSERT INTO tasks (id, project_id, title, status) VALUES ('t-ovr', 'p-task', 'x', 'todo')`
  )
  await caller.setProjectOverride({
    projectId: 'p-task',
    key: 'terminal_agent_startup',
    value: 'instant'
  })
  expect(await caller.effective({ key: 'terminal_agent_startup', taskId: 't-ovr' })).toEqual({
    value: 'instant',
    source: 'project'
  })
})

test('settings router: an unset key reports the built-in default', async () => {
  expect(await caller.effective({ key: 'chat_default_effort:codex', projectId: 'p-ovr' })).toEqual({
    value: null,
    source: 'default'
  })
})

test('settings router: deleting a project drops its overrides', async () => {
  await caller.setProjectOverride({
    projectId: 'p-ovr',
    key: 'terminal_agent_startup',
    value: 'manual'
  })
  await h.slayDb.run(`DELETE FROM projects WHERE id = 'p-ovr'`)
  expect(await h.slayDb.all(`SELECT * FROM project_settings WHERE project_id = 'p-ovr'`)).toEqual(
    []
  )
})

test('settings router: effective serves hub keys only', async () => {
  await expect(caller.effective({ key: 'integration:credential:x' })).rejects.toThrow(
    /not a hub setting/
  )
  await expect(caller.effective({ key: 'viewState' })).rejects.toThrow(/not a hub setting/)
})

test('settings router: a hub lock ignores project values and refuses new ones', async () => {
  await h.slayDb.run(
    `INSERT OR IGNORE INTO projects (id, name, color) VALUES ('p-lock', 'L', '#000')`
  )
  await caller.set({ key: 'default_agent_id', value: 'claude-code' })
  await caller.setProjectOverride({ projectId: 'p-lock', key: 'default_agent_id', value: 'codex' })
  await caller.set({ key: 'policy_lock:default_agent_id', value: '1' })
  expect(await caller.effective({ key: 'default_agent_id', projectId: 'p-lock' })).toEqual({
    value: 'claude-code',
    source: 'hub',
    locked: true
  })
  await expect(
    caller.setProjectOverride({ projectId: 'p-lock', key: 'default_agent_id', value: 'gemini' })
  ).rejects.toThrow(/locked by the hub/)
  await caller.set({ key: 'policy_lock:default_agent_id', value: '0' })
  expect(await caller.effective({ key: 'default_agent_id', projectId: 'p-lock' })).toEqual({
    value: 'codex',
    source: 'project'
  })
})
