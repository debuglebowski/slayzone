/**
 * The hub's `hubUsers` capability (hub-users.ts) against a REAL hub-auth and a real
 * migrated app DB: disabling an account revokes BOTH credential classes — its
 * better-auth sessions (hub-auth) and its scoped web sessions (`web_sessions`, app
 * DB) — keeps every row, and blocks the web login; enabling restores sign-in.
 *
 * Native ABI: the app DB is better-sqlite3 built for Electron, so this runs under the
 * Electron strict loader like hub-trpc-context.test.ts (hand-rolled harness).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/hub-users.test.ts
 */
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
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function main(): Promise<void> {
  console.log('\nhub users capability (real hub-auth + app DB)')
  console.log('─'.repeat(46))

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

  try {
    const owner = await users.create({ email: 'owner@example.com' })
    const leaver = await users.create({ email: 'leaver@example.com', name: 'Leaver' })
    assert(owner.ok && leaver.ok, 'created both accounts')

    await test('create passes the role through; the first account is admin', async () => {
      assert(owner.ok && leaver.ok, 'created')
      assertEq(owner.user.role, 'admin', 'first account')
      assertEq(leaver.user.role, 'user', 'second account')
      const extra = await users.create({ email: 'extra@example.com', role: 'admin' })
      assert(extra.ok, 'created')
      assertEq(extra.user.role, 'admin', 'explicit admin')
      assertEq(await users.setRole('extra@example.com', 'user'), 'ok', 'demoted')
      const listed = await users.list()
      assertEq(
        listed.map((u) => `${u.email}:${u.role}:${u.disabledAt === null}`).join(','),
        'owner@example.com:admin:true,leaver@example.com:user:true,extra@example.com:user:true',
        'list shows role and enabled state'
      )
    })

    await test('disable revokes better-auth AND web sessions, keeps the rows, blocks web login', async () => {
      assert(leaver.ok, 'created')
      const userId = leaver.user.id
      const full = await auth.api.signInEmail({
        body: { email: 'leaver@example.com', password: leaver.user.password }
      })
      const web = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
      assert(web.ok, 'web login works while enabled')
      assert(await resolves(full.token), 'full session resolves before')
      assert(await resolves(web.token), 'web session resolves before')

      assertEq(await users.disable('leaver@example.com'), 'ok', 'disabled')

      assertEq(await resolves(full.token), false, 'full session refused')
      assertEq(await resolves(web.token), false, 'web session refused')
      const rows = await db.all<WebSessionRow>('SELECT * FROM web_sessions WHERE user_id = ?', [
        userId
      ])
      assert(rows.length === 1, 'the web session row is kept')
      assert(rows[0]!.revoked_at !== null, 'and revoked, not merely unverifiable')
      assertEq(authRows(userId), 'user=1 account=1 session=0', 'user + account kept')

      const blocked = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
      assertEq(blocked.ok, false, 'web login refused')
      assertEq(
        (
          (await db.get<{ n: number }>('SELECT count(*) AS n FROM web_sessions WHERE user_id = ?', [
            userId
          ])) ?? { n: -1 }
        ).n,
        1,
        'no new web session row minted'
      )
    })

    await test('enable restores password and web sign-in; old sessions stay revoked', async () => {
      assert(leaver.ok, 'created')
      const before = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
      assertEq(before.ok, false, 'still disabled')
      assertEq(await users.enable('leaver@example.com'), 'ok', 'enabled')
      const web = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
      assert(web.ok, 'web login works again')
      assert(await resolves(web.token), 'the new web session resolves')
      const old = await db.all<WebSessionRow>(
        'SELECT * FROM web_sessions WHERE user_id = ? AND revoked_at IS NOT NULL',
        [leaver.user.id]
      )
      assertEq(old.length, 1, 'the revoked row stays revoked')
    })

    await test('refusals pass through: last admin, protected service user, unknown email', async () => {
      assertEq(await users.disable('owner@example.com'), 'last-admin', 'last admin')
      assertEq(await users.setRole('owner@example.com', 'user'), 'last-admin', 'last admin role')
      assertEq(await users.disable('computers@slayzone.internal'), 'protected', 'service user')
      assertEq(await users.enable('nobody@example.com'), 'not-found', 'unknown')
    })

    await test('not ready: ready() false, create throws, the rest answer not-found / []', async () => {
      const notReady = createHubUsersCapability(() => null, revokerFor(db))
      assertEq(notReady.ready(), false, 'not ready')
      let threw = false
      try {
        await notReady.create({ email: 'x@example.com' })
      } catch {
        threw = true
      }
      assert(threw, 'create throws')
      assertEq((await notReady.list()).length, 0, 'list empty')
      assertEq(await notReady.disable('x@example.com'), 'not-found', 'disable')
      assertEq(await notReady.enable('x@example.com'), 'not-found', 'enable')
      assertEq(await notReady.setRole('x@example.com', 'admin'), 'not-found', 'setRole')
    })
  } finally {
    await harness.cleanup()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
