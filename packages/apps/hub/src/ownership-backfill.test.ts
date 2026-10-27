/**
 * The boot backfill (ownership-backfill.ts) against a REAL hub-auth and a real
 * migrated app DB: on a hub with login, unowned projects and the pre-login per-user
 * settings go to the first admin, nothing is lost, one audit line carries the
 * counts, and a second boot changes nothing. A hub without login is left alone.
 * The wiring into the boot itself is ownership-boot.test.ts.
 *
 * Native ABI: the app DB is better-sqlite3 built for Electron, so this runs under
 * Electron's node like hub-users.test.ts.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/ownership-backfill.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { afterAll, assert, expect, test } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubAuth, createHubUser, type HubAuth } from '@slayzone/hub-auth/server'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { createTestHarness, type TestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { backfillOwnership } from './ownership-backfill.js'

const tmpDirs: string[] = []
async function newAuth(): Promise<HubAuth> {
  const dir = mkdtempSync(join(tmpdir(), 'ownership-backfill-'))
  tmpDirs.push(dir)
  return createHubAuth({
    dbPath: join(dir, 'slayzone.auth.sqlite'),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'ownership-backfill-test-secret-at-least-32-chars'
  })
}

/** A hub that ran without login: unowned projects, one owned, and global settings. */
async function seededHarness(): Promise<TestHarness> {
  const h = await createTestHarness()
  const insert = h.db.prepare(
    'INSERT INTO projects (id, name, color, owner_user_id) VALUES (?, ?, ?, ?)'
  )
  insert.run('p-legacy-1', 'Legacy one', '#111111', null)
  insert.run('p-legacy-2', 'Legacy two', '#222222', null)
  insert.run('p-owned', 'Already owned', '#333333', 'someone-else')
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t1', 'p-legacy-1', 'T', 'todo', 3)`
    )
    .run()
  const set = h.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  set.run('viewState', '{"tabs":[{"type":"task","taskId":"t1","title":"T"}]}')
  set.run('panel_config', '{"webPanels":[]}')
  set.run('default_terminal_mode', 'claude-code')
  set.run('integration:credential:ref-1', 'plain:secret')
  return h
}

const owners = (h: TestHarness): Record<string, string | null> =>
  Object.fromEntries(
    (
      h.db.prepare('SELECT id, owner_user_id FROM projects ORDER BY id').all() as {
        id: string
        owner_user_id: string | null
      }[]
    ).map((r) => [r.id, r.owner_user_id])
  )
const settingKeys = (h: TestHarness): string[] =>
  (h.db.prepare('SELECT key FROM settings ORDER BY key').all() as { key: string }[]).map(
    (r) => r.key
  )
const userSettings = (h: TestHarness): { user_id: string; key: string; value: string }[] =>
  h.db.prepare('SELECT user_id, key, value FROM user_settings ORDER BY user_id, key').all() as {
    user_id: string
    key: string
    value: string
  }[]

/** Audit lines emitted while `fn` runs. */
async function captureAudit<T>(
  fn: () => Promise<T>
): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = []
  setSecurityLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>))
  try {
    return { result: await fn(), lines }
  } finally {
    setSecurityLogSink()
  }
}

test('login off (the desktop hub): nothing changes, not even with an admin present', async () => {
  const auth = await newAuth()
  await createHubUser(auth, { email: 'admin@example.com' })
  const h = await seededHarness()
  const before = { owners: owners(h), keys: settingKeys(h) }
  const { result, lines } = await captureAudit(() =>
    backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: false })
  )
  expect(result, 'skipped').toBe(null)
  expect(owners(h), 'owners untouched').toEqual(before.owners)
  expect(settingKeys(h), 'settings untouched').toEqual(before.keys)
  expect(userSettings(h), 'no per-user rows').toEqual([])
  expect(lines.length, 'no audit line').toBe(0)
})

test('login on, no account yet: nothing assigned, nothing lost, logged', async () => {
  const auth = await newAuth()
  const h = await seededHarness()
  const logs: string[] = []
  const result = await backfillOwnership({
    db: h.slayDb,
    hubAuth: auth,
    requireLogin: true,
    log: (m) => logs.push(m)
  })
  expect(result, 'no admin → no owner').toEqual({ ownerUserId: null, projects: 0, settings: 0 })
  expect(owners(h)['p-legacy-1'], 'still unowned').toBe(null)
  expect(settingKeys(h), 'global viewState kept').toContain('viewState')
  expect(
    logs.some((l) => l.includes('2 project(s) have no owner')),
    `logged: ${JSON.stringify(logs)}`
  ).toBe(true)
})

test('login on: unowned projects + pre-login user settings → first admin, once', async () => {
  const auth = await newAuth()
  const admin = await createHubUser(auth, { email: 'first@example.com' })
  const other = await createHubUser(auth, { email: 'second@example.com' })
  assert(!('error' in admin) && !('error' in other), 'accounts created')
  expect([admin.role, other.role], 'the first account is the admin').toEqual(['admin', 'user'])
  const h = await seededHarness()

  const { result, lines } = await captureAudit(() =>
    backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: true })
  )
  expect(result, 'counts').toEqual({ ownerUserId: admin.id, projects: 2, settings: 2 })
  expect(owners(h), 'unowned → admin; an owned project keeps its owner').toEqual({
    'p-legacy-1': admin.id,
    'p-legacy-2': admin.id,
    'p-owned': 'someone-else'
  })
  const nTasks = (h.db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n
  expect(nTasks, 'tasks untouched').toBe(1)
  // Per-user keys moved; hub + internal keys stay global.
  expect(
    settingKeys(h).filter((k) => ['viewState', 'panel_config'].includes(k)),
    'per-user keys left the global table'
  ).toEqual([])
  expect(settingKeys(h), 'hub key stays global').toContain('default_terminal_mode')
  expect(settingKeys(h), 'credential stays global').toContain('integration:credential:ref-1')
  expect(userSettings(h), 'the admin adopted them, byte for byte').toEqual([
    { user_id: admin.id, key: 'panel_config', value: '{"webPanels":[]}' },
    {
      user_id: admin.id,
      key: 'viewState',
      value: '{"tabs":[{"type":"task","taskId":"t1","title":"T"}]}'
    }
  ])

  expect(lines.length, 'one audit line').toBe(1)
  const line = lines[0]!
  expect(line.event, 'event').toBe('project.owner.backfill')
  expect(line.outcome, 'outcome').toBe('success')
  expect(line.targetKind, 'target kind').toBe('user')
  expect(line.targetId, 'target = the new owner').toEqual(admin.id)
  expect(line.detail, 'counts in detail').toEqual({ projectCount: 2, settingCount: 2 })

  // Second boot: nothing left, nothing logged.
  const again = await captureAudit(() =>
    backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: true })
  )
  expect(again.result, 'idempotent').toEqual({ ownerUserId: admin.id, projects: 0, settings: 0 })
  expect(again.lines.length, 'no audit line when nothing changed').toBe(0)
})

test('the first admin is the OLDEST enabled admin, not the newest', async () => {
  const auth = await newAuth()
  const first = await createHubUser(auth, { email: 'a@example.com' })
  await createHubUser(auth, { email: 'b@example.com', role: 'admin' })
  assert(!('error' in first), 'created')
  const h = await seededHarness()
  const result = await backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: true })
  expect(result?.ownerUserId, 'oldest admin').toEqual(first.id)
})

test("a key the admin already has keeps the admin's value (never clobbered)", async () => {
  const auth = await newAuth()
  const admin = await createHubUser(auth, { email: 'keep@example.com' })
  assert(!('error' in admin), 'created')
  const h = await seededHarness()
  h.db
    .prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'viewState', 'mine')`)
    .run(admin.id)
  await backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: true })
  const vs = userSettings(h).find((r) => r.key === 'viewState')
  expect(vs?.value, "admin's own row kept").toBe('mine')
  expect(settingKeys(h), 'global copy gone (no stale purge input)').not.toContain('viewState')
})

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})
