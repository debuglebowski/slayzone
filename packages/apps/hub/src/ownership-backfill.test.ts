/**
 * The boot backfill (ownership-backfill.ts) against a REAL hub-auth and a real
 * migrated app DB: on a hub with login, unowned projects and the pre-login per-user
 * settings go to the first admin, nothing is lost, one audit line carries the
 * counts, and a second boot changes nothing. A hub without login is left alone.
 * The wiring into the boot itself is ownership-boot.test.ts.
 *
 * Native ABI: the app DB is better-sqlite3 built for Electron, so this runs under
 * the Electron strict loader like hub-users.test.ts.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/ownership-backfill.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubAuth, createHubUser, type HubAuth } from '@slayzone/hub-auth/server'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { createTestHarness, type TestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { backfillOwnership } from './ownership-backfill.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

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

async function main(): Promise<void> {
  console.log('\nownership backfill (real hub-auth + app DB)')
  console.log('─'.repeat(44))

  await test('login off (the desktop hub): nothing changes, not even with an admin present', async () => {
    const auth = await newAuth()
    await createHubUser(auth, { email: 'admin@example.com' })
    const h = await seededHarness()
    const before = { owners: owners(h), keys: settingKeys(h) }
    const { result, lines } = await captureAudit(() =>
      backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: false })
    )
    assertEq(result, null, 'skipped')
    assertEq(owners(h), before.owners, 'owners untouched')
    assertEq(settingKeys(h), before.keys, 'settings untouched')
    assertEq(userSettings(h), [], 'no per-user rows')
    assertEq(lines.length, 0, 'no audit line')
  })

  await test('login on, no account yet: nothing assigned, nothing lost, logged', async () => {
    const auth = await newAuth()
    const h = await seededHarness()
    const logs: string[] = []
    const result = await backfillOwnership({
      db: h.slayDb,
      hubAuth: auth,
      requireLogin: true,
      log: (m) => logs.push(m)
    })
    assertEq(result, { ownerUserId: null, projects: 0, settings: 0 }, 'no admin → no owner')
    assertEq(owners(h)['p-legacy-1'], null, 'still unowned')
    assert(settingKeys(h).includes('viewState'), 'global viewState kept')
    assert(
      logs.some((l) => l.includes('2 project(s) have no owner')),
      `logged: ${JSON.stringify(logs)}`
    )
  })

  await test('login on: unowned projects + pre-login user settings → first admin, once', async () => {
    const auth = await newAuth()
    const admin = await createHubUser(auth, { email: 'first@example.com' })
    const other = await createHubUser(auth, { email: 'second@example.com' })
    assert(!('error' in admin) && !('error' in other), 'accounts created')
    assertEq([admin.role, other.role], ['admin', 'user'], 'the first account is the admin')
    const h = await seededHarness()

    const { result, lines } = await captureAudit(() =>
      backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: true })
    )
    assertEq(result, { ownerUserId: admin.id, projects: 2, settings: 2 }, 'counts')
    assertEq(
      owners(h),
      { 'p-legacy-1': admin.id, 'p-legacy-2': admin.id, 'p-owned': 'someone-else' },
      'unowned → admin; an owned project keeps its owner'
    )
    const nTasks = (h.db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n
    assertEq(nTasks, 1, 'tasks untouched')
    // Per-user keys moved; hub + internal keys stay global.
    assertEq(
      settingKeys(h).filter((k) => ['viewState', 'panel_config'].includes(k)),
      [],
      'per-user keys left the global table'
    )
    assert(settingKeys(h).includes('default_terminal_mode'), 'hub key stays global')
    assert(settingKeys(h).includes('integration:credential:ref-1'), 'credential stays global')
    assertEq(
      userSettings(h),
      [
        { user_id: admin.id, key: 'panel_config', value: '{"webPanels":[]}' },
        {
          user_id: admin.id,
          key: 'viewState',
          value: '{"tabs":[{"type":"task","taskId":"t1","title":"T"}]}'
        }
      ],
      'the admin adopted them, byte for byte'
    )

    assertEq(lines.length, 1, 'one audit line')
    const line = lines[0]!
    assertEq(line.event, 'project.owner.backfill', 'event')
    assertEq(line.outcome, 'success', 'outcome')
    assertEq(line.targetKind, 'user', 'target kind')
    assertEq(line.targetId, admin.id, 'target = the new owner')
    assertEq(line.detail, { projectCount: 2, settingCount: 2 }, 'counts in detail')

    // Second boot: nothing left, nothing logged.
    const again = await captureAudit(() =>
      backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: true })
    )
    assertEq(again.result, { ownerUserId: admin.id, projects: 0, settings: 0 }, 'idempotent')
    assertEq(again.lines.length, 0, 'no audit line when nothing changed')
  })

  await test('the first admin is the OLDEST enabled admin, not the newest', async () => {
    const auth = await newAuth()
    const first = await createHubUser(auth, { email: 'a@example.com' })
    await createHubUser(auth, { email: 'b@example.com', role: 'admin' })
    assert(!('error' in first), 'created')
    const h = await seededHarness()
    const result = await backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: true })
    assertEq(result?.ownerUserId, first.id, 'oldest admin')
  })

  await test("a key the admin already has keeps the admin's value (never clobbered)", async () => {
    const auth = await newAuth()
    const admin = await createHubUser(auth, { email: 'keep@example.com' })
    assert(!('error' in admin), 'created')
    const h = await seededHarness()
    h.db
      .prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'viewState', 'mine')`)
      .run(admin.id)
    await backfillOwnership({ db: h.slayDb, hubAuth: auth, requireLogin: true })
    const vs = userSettings(h).find((r) => r.key === 'viewState')
    assertEq(vs?.value, 'mine', "admin's own row kept")
    assert(!settingKeys(h).includes('viewState'), 'global copy gone (no stale purge input)')
  })

  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
