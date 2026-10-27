/**
 * The hub's `hubUsers` capability (hub-users.ts) against a REAL hub-auth and a real
 * migrated app DB: disabling an account revokes BOTH credential classes — its
 * better-auth sessions (hub-auth) and its scoped web sessions (`web_sessions`, app
 * DB) — keeps every row, and blocks the web login; enabling restores sign-in.
 *
 * Native ABI: the app DB is better-sqlite3 built for Electron, so this runs under
 * vitest on Electron's node, like hub-trpc-context.test.ts.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SlayzoneDb } from '@slayzone/platform'
import { createHubAuth, type HubAuth } from '@slayzone/hub-auth/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createHubUsersCapability } from './hub-users.js'
import { createTrpcConnectionRegistry } from './trpc-connections.js'
import { createUserAccessRevoker } from './user-access.js'
import { verifyRestBearer } from './rest-auth.js'
import { webLogin, type WebSessionRow } from './web-sessions.js'

/** The hub's revocation outside hub-auth (T-12), with no computer gateway. */
const revokerFor = (db: SlayzoneDb) =>
  createUserAccessRevoker({
    db,
    getGateway: () => null,
    connections: createTrpcConnectionRegistry()
  })

const tmpDir = mkdtempSync(join(tmpdir(), 'hub-users-cap-'))
const authDbPath = join(tmpDir, 'hub-auth.sqlite')
const auth: HubAuth = await createHubAuth({
  dbPath: authDbPath,
  baseURL: 'http://127.0.0.1:9999',
  secret: 'hub-users-cap-test-secret-at-least-32-chars-long'
})
const harness = await createTestHarness()
const db: SlayzoneDb = harness.slayDb
const users = createHubUsersCapability(() => auth, revokerFor(db))

/** Row counts per hub-auth table for one user. */
const authRows = (userId: string): string => {
  const authDb = new DatabaseSync(authDbPath)
  try {
    return ['user:id', 'account:userId', 'session:userId']
      .map((spec) => {
        const [table, col] = spec.split(':')
        const { n } = authDb
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`)
          .get(userId) as { n: number }
        return `${table}=${n}`
      })
      .join(' ')
  } finally {
    authDb.close()
  }
}
const resolves = async (token: string): Promise<boolean> =>
  (await verifyRestBearer(auth, db, { authorization: `Bearer ${token}` })) !== null

afterAll(async () => {
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

const owner = await users.create({ email: 'owner@example.com' })
const leaver = await users.create({ email: 'leaver@example.com', name: 'Leaver' })
if (!owner.ok || !leaver.ok) throw new Error('created both accounts')

test('create passes the role through; the first account is admin', async () => {
  expect(owner.ok, 'created').toBeTruthy()
  expect(leaver.ok, 'created').toBeTruthy()
  expect(owner.user.role, 'first account').toBe('admin')
  expect(leaver.user.role, 'second account').toBe('user')
  const extra = await users.create({ email: 'extra@example.com', role: 'admin' })
  expect(extra.ok, 'created').toBe(true)
  if (!extra.ok) throw new Error('created')
  expect(extra.user.role, 'explicit admin').toBe('admin')
  expect(await users.setRole('extra@example.com', 'user'), 'demoted').toBe('ok')
  const listed = await users.list()
  expect(
    listed.map((u) => `${u.email}:${u.role}:${u.disabledAt === null}`).join(','),
    'list shows role and enabled state'
  ).toBe('owner@example.com:admin:true,leaver@example.com:user:true,extra@example.com:user:true')
})

test('disable revokes better-auth AND web sessions, keeps the rows, blocks web login', async () => {
  expect(leaver.ok, 'created').toBeTruthy()
  const userId = leaver.user.id
  const full = await auth.api.signInEmail({
    body: { email: 'leaver@example.com', password: leaver.user.password }
  })
  const web = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
  expect(web.ok, 'web login works while enabled').toBe(true)
  if (!web.ok) throw new Error('web login works while enabled')
  expect(await resolves(full.token), 'full session resolves before').toBeTruthy()
  expect(await resolves(web.token), 'web session resolves before').toBeTruthy()

  expect(await users.disable('leaver@example.com'), 'disabled').toBe('ok')

  expect(await resolves(full.token), 'full session refused').toBe(false)
  expect(await resolves(web.token), 'web session refused').toBe(false)
  const rows = await db.all<WebSessionRow>('SELECT * FROM web_sessions WHERE user_id = ?', [userId])
  expect(rows.length, 'the web session row is kept').toBe(1)
  expect(rows[0]!.revoked_at, 'and revoked, not merely unverifiable').not.toBeNull()
  expect(authRows(userId), 'user + account kept').toBe('user=1 account=1 session=0')

  const blocked = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
  expect(blocked.ok, 'web login refused').toBe(false)
  expect(
    (
      (await db.get<{ n: number }>('SELECT count(*) AS n FROM web_sessions WHERE user_id = ?', [
        userId
      ])) ?? { n: -1 }
    ).n,
    'no new web session row minted'
  ).toBe(1)
})

test('enable restores password and web sign-in; old sessions stay revoked', async () => {
  expect(leaver.ok, 'created').toBeTruthy()
  const before = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
  expect(before.ok, 'still disabled').toBe(false)
  expect(await users.enable('leaver@example.com'), 'enabled').toBe('ok')
  const web = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
  expect(web.ok, 'web login works again').toBe(true)
  if (!web.ok) throw new Error('web login works again')
  expect(await resolves(web.token), 'the new web session resolves').toBeTruthy()
  const old = await db.all<WebSessionRow>(
    'SELECT * FROM web_sessions WHERE user_id = ? AND revoked_at IS NOT NULL',
    [leaver.user.id]
  )
  expect(old.length, 'the revoked row stays revoked').toBe(1)
})

test('refusals pass through: last admin, protected service user, unknown email', async () => {
  expect(await users.disable('owner@example.com'), 'last admin').toBe('last-admin')
  expect(await users.setRole('owner@example.com', 'user'), 'last admin role').toBe('last-admin')
  expect(await users.disable('computers@slayzone.internal'), 'service user').toBe('protected')
  expect(await users.enable('nobody@example.com'), 'unknown').toBe('not-found')
})

test('not ready: ready() false, create throws, the rest answer not-found / []', async () => {
  const notReady = createHubUsersCapability(() => null, revokerFor(db))
  expect(notReady.ready(), 'not ready').toBe(false)
  let threw = false
  try {
    await notReady.create({ email: 'x@example.com' })
  } catch {
    threw = true
  }
  expect(threw, 'create throws').toBeTruthy()
  expect((await notReady.list()).length, 'list empty').toBe(0)
  expect(await notReady.disable('x@example.com'), 'disable').toBe('not-found')
  expect(await notReady.enable('x@example.com'), 'enable').toBe('not-found')
  expect(await notReady.setRole('x@example.com', 'admin'), 'setRole').toBe('not-found')
})
