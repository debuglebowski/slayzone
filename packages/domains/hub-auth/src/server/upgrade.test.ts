/**
 * Upgrade of a hub-auth DB from before the account model (T-08): the `user` table
 * has no `role` / `disabledAt`. `legacyHub` below is the better-auth config of that
 * release, FROZEN here on purpose (same plugins and options, no `additionalFields`),
 * so this keeps describing the old schema however auth.ts changes later. Accounts are
 * written the way that release's `createHubUser` wrote them.
 *
 * Asserted: `createHubAuth` on that file adds the columns, keeps every account,
 * password, session and computer key, and makes exactly one admin (the oldest
 * account), once.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apiKey } from '@better-auth/api-key'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { bearer, jwt, organization } from 'better-auth/plugins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHubAuth, type HubAuth } from './auth'
import { COMPUTER_SERVICE_USER_EMAIL } from './computer-keys'
import { listHubUsers } from './users'
import { verifyComputerApiKey, verifySession } from './verify'

const SECRET = 'hub-auth-test-secret-at-least-32-chars-long'
const BASE_URL = 'http://127.0.0.1:9999'

let tmpDir: string
let dbPath: string
let audit: Array<Record<string, unknown>>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-upgrade-test-'))
  dbPath = join(tmpDir, 'hub-auth.sqlite')
  audit = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
})

afterEach(() => {
  setSecurityLogSink()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** The pre-T-08 hub-auth config (auth.ts before the account model). */
function legacyHub(database: DatabaseSync) {
  return betterAuth({
    baseURL: BASE_URL,
    secret: SECRET,
    database,
    emailAndPassword: { enabled: true, disableSignUp: true },
    telemetry: { enabled: false },
    plugins: [
      bearer(),
      jwt(),
      organization(),
      apiKey({
        enableMetadata: true,
        enableSessionForAPIKeys: false,
        defaultPrefix: 'szr_',
        rateLimit: { enabled: false }
      })
    ]
  })
}

interface LegacyState {
  /** Insertion order differs from age on purpose: carol is inserted first, alice is oldest. */
  ids: { alice: string; bob: string; carol: string }
  password: string
  token: string
  computerKey: string
  computerKeyId: string
}

/** A populated pre-T-08 hub: three humans, a session, the computer service user + a key. */
async function seedLegacyHub(): Promise<LegacyState> {
  const database = new DatabaseSync(dbPath)
  database.exec('PRAGMA journal_mode = WAL;')
  const legacy = legacyHub(database)
  await (await getMigrations(legacy.options)).runMigrations()
  const ctx = await legacy.$context
  const password = 'legacy-password-123456'
  const hash = await ctx.password.hash(password)
  const human = async (email: string, createdAt: string): Promise<string> => {
    const user = await ctx.internalAdapter.createUser({
      email,
      name: email.split('@')[0]!,
      emailVerified: true,
      createdAt: new Date(createdAt)
    })
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: hash
    })
    return user.id
  }
  const carol = await human('carol@example.com', '2026-03-01T00:00:00.000Z')
  const alice = await human('alice@example.com', '2026-01-01T00:00:00.000Z')
  const bob = await human('bob@example.com', '2026-02-01T00:00:00.000Z')
  const { token } = await legacy.api.signInEmail({
    body: { email: 'alice@example.com', password }
  })
  const service = await ctx.internalAdapter.createUser({
    email: COMPUTER_SERVICE_USER_EMAIL,
    name: 'SlayZone Computer Service',
    emailVerified: true
  })
  const key = await legacy.api.createApiKey({
    body: { name: 'ci-computer', userId: service.id, metadata: { computerId: 'computer-1' } }
  })
  database.close()
  return {
    ids: { alice, bob, carol },
    password,
    token,
    computerKey: key.key,
    computerKeyId: key.id
  }
}

const boot = (): Promise<HubAuth> => createHubAuth({ dbPath, baseURL: BASE_URL, secret: SECRET })

function userColumns(): string[] {
  const db = new DatabaseSync(dbPath)
  try {
    return (db.prepare('PRAGMA table_info(user)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  } finally {
    db.close()
  }
}

describe('upgrade from a hub-auth DB without the account model', () => {
  it('adds the columns, keeps every account, and makes the oldest account the one admin', async () => {
    const legacy = await seedLegacyHub()
    expect(userColumns()).not.toContain('role')
    audit.length = 0

    const auth = await boot()

    expect(userColumns()).toEqual(expect.arrayContaining(['role', 'disabledAt']))
    const users = await listHubUsers(auth)
    expect(users.map((u) => [u.email, u.role, u.disabledAt])).toEqual([
      ['alice@example.com', 'admin', null],
      ['bob@example.com', 'user', null],
      ['carol@example.com', 'user', null]
    ])
    expect(audit.map((l) => `${l.event}:${l.outcome}`)).toEqual(['user.role_change:success'])
    expect(audit[0]!.targetId).toBe(legacy.ids.alice)
    expect(audit[0]!.detail).toEqual({ reason: 'first_admin', role: 'admin' })
  })

  it('keeps passwords, sessions and computer keys working', async () => {
    const legacy = await seedLegacyHub()
    const auth = await boot()

    const session = await verifySession(auth, { authorization: `Bearer ${legacy.token}` })
    expect(session).toMatchObject({ userId: legacy.ids.alice, role: 'admin' })
    const signIn = await auth.api.signInEmail({
      body: { email: 'bob@example.com', password: legacy.password }
    })
    expect(await verifySession(auth, { authorization: `Bearer ${signIn.token}` })).toMatchObject({
      userId: legacy.ids.bob,
      role: 'user'
    })
    expect(await verifyComputerApiKey(auth, legacy.computerKey)).toEqual({
      computerId: 'computer-1',
      keyId: legacy.computerKeyId
    })
  })

  it('promotes once: later boots change nothing', async () => {
    await seedLegacyHub()
    await boot()
    audit.length = 0
    const again = await boot()
    expect(audit).toEqual([])
    expect((await listHubUsers(again)).filter((u) => u.role === 'admin')).toHaveLength(1)
  })

  it('a pre-T-08 hub with no humans gets no admin until its first account', async () => {
    const database = new DatabaseSync(dbPath)
    await (await getMigrations(legacyHub(database).options)).runMigrations()
    database.close()
    const auth = await boot()
    expect(await listHubUsers(auth)).toEqual([])
    expect(audit).toEqual([])
  })
})
