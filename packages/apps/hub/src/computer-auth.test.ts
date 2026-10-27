/**
 * Computer auth adapter factory — end-to-end against real dependencies.
 *
 * Exercises `createComputerAuthAdapters` over a real migrated `SlayzoneDb` (the
 * full production migration chain, incl. the v149 computer tables) and a real
 * `createHubAuth` better-auth instance on a throwaway sqlite file. No mocks of
 * the computers store, join-token verifier, or api-key mint/verify.
 *
 * Native ABI: the `SlayzoneDb` rides better-sqlite3 (rebuilt for Electron's
 * ABI), and createHubAuth uses `node:sqlite` — so this runs under vitest on
 * Electron's node: packages/shared/test-utils/vitest.harness.config.ts.
 */
import { afterAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { COMPUTER_PROTOCOL_VERSION } from '@slayzone/computer-transport/shared'
import {
  createHubAuth,
  createHubUser,
  COMPUTER_KEY_PREFIX,
  disableHubUser
} from '@slayzone/hub-auth/server'
import { DB_PRAGMAS, type SlayzoneDb } from '@slayzone/platform'
import { runWithSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import {
  deterministicLocalComputerId,
  getComputer,
  listComputers,
  mintJoinToken,
  revokeComputer
} from '@slayzone/computers/server'
import { createSlayzoneDbAdapter } from '@slayzone/test-utils'
import { runMigrations } from '@slayzone/transport/db-bootstrap'
import { createComputerAuthAdapters } from './computer-auth.js'

/** Fresh in-memory SlayzoneDb with the FULL production migration chain applied. */
function createMigratedDb(): { db: SlayzoneDb; close: () => void } {
  const raw = new Database(':memory:')
  for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
  runMigrations(raw)
  return { db: createSlayzoneDbAdapter(raw), close: () => raw.close() }
}

/** A ready-to-use join token for the seeded hub. */
async function mintToken(db: SlayzoneDb, label = 'ci'): Promise<string> {
  const minted = await mintJoinToken(db, {
    hubUrl: 'https://hub.local:4141',
    ttlMs: 60_000,
    label
  })
  return minted.token
}

const ENROLL_BASE = {
  name: 'mac-studio',
  platform: 'darwin-arm64',
  version: '0.35.0',
  capabilities: ['pty', 'git'],
  protocolVersion: COMPUTER_PROTOCOL_VERSION
}

const tmpDir = mkdtempSync(join(tmpdir(), 'computer-auth-test-'))
const { db, close } = createMigratedDb()
const auth = await createHubAuth({
  dbPath: join(tmpDir, 'slayzone.auth.sqlite'),
  baseURL: 'http://127.0.0.1:9999',
  secret: 'computer-auth-test-secret-at-least-32-chars-long'
})
const adapters = createComputerAuthAdapters({ db, auth })

afterAll(async () => {
  close()
  rmSync(tmpDir, { recursive: true, force: true })
})

test('verifyEnrollment registers a computer + returns {computerId, apiKey}', async () => {
  const token = await mintToken(db)
  const result = await adapters.verifyEnrollment({ ...ENROLL_BASE, joinToken: token })

  expect(typeof result.computerId, 'computerId set').toBe('string')
  expect(result.computerId.length, 'computerId set').toBeGreaterThan(0)
  expect(
    result.apiKey.startsWith(COMPUTER_KEY_PREFIX),
    'apiKey carries the computer prefix'
  ).toBeTruthy()

  const row = await getComputer(db, result.computerId)
  expect(row, 'computers row persisted').not.toBeNull()
  expect(row!.name, 'name persisted').toBe('mac-studio')
  expect(row!.platform, 'platform persisted').toBe('darwin-arm64')
  expect(row!.version, 'version persisted').toBe('0.35.0')
  expect(row!.auth_key_id, 'auth_key_id persisted').not.toBeNull()
  expect(row!.auth_key_id!.length, 'auth_key_id persisted').toBeGreaterThan(0)
  expect(row!.revoked_at, 'computer is active').toBeNull()
  const storedCaps = JSON.parse(row!.capabilities_json) as Record<string, unknown>
  expect(storedCaps.pty, 'capability tags persisted as a { tag: true } map').toBe(true)
  expect(storedCaps.git, 'capability tags persisted as a { tag: true } map').toBe(true)
})

test('verifyApiKey resolves the descriptor for the minted key', async () => {
  const token = await mintToken(db, 'descriptor')
  const enrolled = await adapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'descriptor-host',
    joinToken: token
  })

  const descriptor = await adapters.verifyApiKey(enrolled.apiKey)
  expect(descriptor, 'descriptor resolved').not.toBeNull()
  expect(descriptor!.computerId, 'descriptor computerId matches').toBe(enrolled.computerId)
  expect(descriptor!.name, 'descriptor name').toBe('descriptor-host')
  expect(descriptor!.platform, 'descriptor platform').toBe('darwin-arm64')
  expect(descriptor!.version, 'descriptor version').toBe('0.35.0')
  expect(Array.isArray(descriptor!.capabilities), 'capabilities is a string[]').toBeTruthy()
  expect(JSON.stringify(descriptor!.capabilities), 'capability tags round-trip').toBe(
    JSON.stringify(['pty', 'git'])
  )
})

test('verifyApiKey returns null for an unknown key', async () => {
  expect(await adapters.verifyApiKey('not-a-real-key'), 'unknown key ⇒ null').toBeNull()
  expect(
    await adapters.verifyApiKey(`${COMPUTER_KEY_PREFIX}bogus`),
    'well-prefixed but bogus key ⇒ null'
  ).toBeNull()
})

test('re-enroll after socket drop returns the SAME computerId + apiKey', async () => {
  const token = await mintToken(db, 'reenroll')
  const params = { ...ENROLL_BASE, name: 'flaky-host', joinToken: token }

  const before = (await listComputers(db)).length
  const first = await adapters.verifyEnrollment(params)
  // Socket dropped before the computer got `first` — it re-dials and enrolls
  // again with the identical (joinToken, name). Single-use token is already
  // stamped; the grace ledger must make this a no-op re-issue, not a reject.
  const second = await adapters.verifyEnrollment(params)

  expect(second.computerId, 'stable computerId across re-enroll').toBe(first.computerId)
  expect(second.apiKey, 'identical apiKey across re-enroll').toBe(first.apiKey)
  expect((await listComputers(db)).length, 'exactly one computer registered (no duplicate)').toBe(
    before + 1
  )

  // And the re-issued key still authenticates.
  const descriptor = await adapters.verifyApiKey(second.apiKey)
  expect(descriptor, 're-enroll key verifies').not.toBeNull()
  expect(descriptor!.computerId, 're-enroll key maps to same computer').toBe(first.computerId)
})

test('a raw re-verify of a used token (miss ⇒ used) is rejected', async () => {
  // Same token, a DIFFERENT name misses the grace ledger and hits the
  // single-use guard — proves we are not blanket-accepting used tokens.
  const token = await mintToken(db, 'used-guard')
  await adapters.verifyEnrollment({ ...ENROLL_BASE, name: 'first-name', joinToken: token })
  let threw = false
  try {
    await adapters.verifyEnrollment({ ...ENROLL_BASE, name: 'other-name', joinToken: token })
  } catch {
    threw = true
  }
  expect(threw, 'used token under a new name is rejected').toBeTruthy()
})

test('expired join token is rejected', async () => {
  const stale = await mintJoinToken(db, {
    hubUrl: 'https://hub.local:4141',
    ttlMs: 1,
    label: 'expired',
    now: 1000
  })
  let threw = false
  try {
    // now() well past the 1001 expiry.
    const adaptersExpired = createComputerAuthAdapters({ db, auth, now: () => 10_000 })
    await adaptersExpired.verifyEnrollment({ ...ENROLL_BASE, joinToken: stale.token })
  } catch {
    threw = true
  }
  expect(threw, 'expired token rejected').toBeTruthy()
})

test('revoked computer ⇒ verifyApiKey returns null', async () => {
  const token = await mintToken(db, 'revoke')
  const enrolled = await adapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'doomed-host',
    joinToken: token
  })
  expect(await adapters.verifyApiKey(enrolled.apiKey), 'valid before revoke').not.toBeNull()

  await revokeComputer(db, enrolled.computerId)
  expect(
    await adapters.verifyApiKey(enrolled.apiKey),
    'revoked computer no longer authenticates'
  ).toBeNull()
})

/**
 * The key must be THE key this computer enrolled with, not merely A key that
 * names it. `verifyComputerApiKey` proves a key was minted by us; this proves
 * it was minted FOR this computer.
 *
 * Without the `auth_key_id` binding, a key from a PREVIOUS enroll of the same
 * computer id keeps authenticating forever: re-enroll rotates the stored
 * `auth_key_id` but the old apikey row is untouched, so its holder — e.g.
 * whoever had the machine before it was re-provisioned — silently retains
 * access to the current computer.
 */
test('a superseded key from a PRIOR enroll no longer authenticates', async () => {
  // The LOCAL path is the one that keeps a stable computer id across enrolls
  // (deterministic id + UPSERT), so it is where a key can outlive its own
  // enrollment. A remote enroll mints a fresh uuid each time, so its old key
  // points at an old row and was never the risk.
  const localAdapters = createComputerAuthAdapters({
    db,
    auth,
    localComputerName: 'rotating-local'
  })
  const first = await localAdapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'rotating-local',
    joinToken: await mintToken(db, 'rotate-1')
  })
  expect(
    await localAdapters.verifyApiKey(first.apiKey),
    'first key valid before rotate'
  ).not.toBeNull()

  // A relaunch: new join token, same local name ⇒ same computer id, fresh key.
  const second = await localAdapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'rotating-local',
    joinToken: await mintToken(db, 'rotate-2')
  })
  expect(second.computerId, 'same computer id across re-enroll').toBe(first.computerId)
  expect(second.apiKey, 'a distinct key was issued').not.toBe(first.apiKey)

  expect(
    await localAdapters.verifyApiKey(second.apiKey),
    'current key authenticates'
  ).not.toBeNull()
  expect(
    await localAdapters.verifyApiKey(first.apiKey),
    'superseded key is refused even though it names a live computer'
  ).toBeNull()
})

// --- Local-computer dedup (Wave3.5-D5) -----------------------------------
test('LOCAL enroll uses a deterministic id + UPSERTs one row across relaunches', async () => {
  const localAdapters = createComputerAuthAdapters({
    db,
    auth,
    localComputerName: 'local-computer'
  })
  const before = (await listComputers(db)).filter((r) => r.name === 'local-computer').length

  const t1 = await mintToken(db, 'local-1')
  const first = await localAdapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'local-computer',
    joinToken: t1
  })
  // A relaunch: a NEW join token (new port/creds) but the same local name.
  const t2 = await mintToken(db, 'local-2')
  const second = await localAdapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'local-computer',
    joinToken: t2
  })

  expect(first.computerId, 'id is deterministic').toBe(
    deterministicLocalComputerId('local-computer')
  )
  expect(second.computerId, 'relaunch keeps the SAME local computerId').toBe(first.computerId)
  expect(
    (await listComputers(db)).filter((r) => r.name === 'local-computer').length,
    'exactly one local computer row after two enrolls (no orphan)'
  ).toBe(before + 1)
})

test('a fresh LOCAL enroll collapses PRE-EXISTING duplicate local rows to one', async () => {
  const localAdapters = createComputerAuthAdapters({ db, auth, localComputerName: 'dup-local' })
  // Seed the pre-fix state: two random-id rows named 'dup-local' (orphans from
  // prior boots) via the REMOTE (fresh-uuid) path, imitating the historical bug.
  const remoteAdapters = createComputerAuthAdapters({ db, auth }) // no localComputerName
  await remoteAdapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'dup-local',
    joinToken: await mintToken(db, 'd1')
  })
  await remoteAdapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'dup-local',
    joinToken: await mintToken(db, 'd2')
  })
  expect(
    (await listComputers(db)).filter((r) => r.name === 'dup-local').length,
    'two orphaned local rows seeded'
  ).toBe(2)

  // The next computer-enabled boot enrolls the local computer → cleanup collapses.
  const enrolled = await localAdapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'dup-local',
    joinToken: await mintToken(db, 'd3')
  })
  const localRows = (await listComputers(db)).filter((r) => r.name === 'dup-local')
  expect(localRows.length, 'collapsed to a single local row').toBe(1)
  expect(localRows[0].id, 'the surviving row is the deterministic-id one').toBe(enrolled.computerId)
  expect(localRows[0].id, 'kept the deterministic id').toBe(
    deterministicLocalComputerId('dup-local')
  )
})

test('REMOTE enroll keeps a fresh uuid + is never deduped by the local path', async () => {
  // A hub configured with a local name; a REMOTE computer (different name) must
  // NOT get the deterministic id and NEVER be retired.
  const localAdapters = createComputerAuthAdapters({ db, auth, localComputerName: 'the-local' })
  const r1 = await localAdapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'remote-alpha',
    joinToken: await mintToken(db, 'r1')
  })
  const r2 = await localAdapters.verifyEnrollment({
    ...ENROLL_BASE,
    name: 'remote-beta',
    joinToken: await mintToken(db, 'r2')
  })
  expect(r1.computerId, 'remote id is a fresh uuid').not.toBe(
    deterministicLocalComputerId('remote-alpha')
  )
  // Both remote computers survive — dedup is scoped to the single local name only.
  expect(await getComputer(db, r1.computerId), 'remote-alpha survives').not.toBeNull()
  expect(await getComputer(db, r2.computerId), 'remote-beta survives').not.toBeNull()
})

// T-20: the token names who the computer is for. Redeeming carries no identity
// of its own, so whoever runs the enroll, the computer is the named user's — never
// the admin who minted it — and the token works once.
const admin = await createHubUser(auth, { email: 'admin@example.com', role: 'admin' })
const bob = await createHubUser(auth, { email: 'bob@example.com', role: 'user' })
const dave = await createHubUser(auth, { email: 'dave@example.com', role: 'user' })
if ('error' in admin || 'error' in bob || 'error' in dave) throw new Error('users created')
const mintFor = async (ownerUserId: string, label: string) =>
  mintJoinToken(db, {
    hubUrl: 'https://hub.local:4141',
    ttlMs: 60_000,
    label,
    mintedByUserId: admin.id,
    ownerUserId
  })

test('T-20: redeem makes the named user the owner, not the minter; a second redeem is refused', async () => {
  const audit: Array<Record<string, unknown>> = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
  try {
    const minted = await mintFor(bob.id, 'bob-laptop')
    audit.length = 0
    // The enroll runs in the socket's context (hub-gateway.ts): client address only.
    const enrolled = await runWithSecurityContext(
      { actor: null, ip: '198.51.100.9', route: 'WS /computers' },
      () =>
        adapters.verifyEnrollment({
          ...ENROLL_BASE,
          name: 'bob-laptop',
          joinToken: minted.token
        })
    )
    const row = await getComputer(db, enrolled.computerId)
    expect(row?.owner_user_id, 'owner is the named user').toBe(bob.id)
    const tokenRow = await db.get<{ computer_id: string | null }>(
      'SELECT computer_id FROM join_tokens WHERE id = ?',
      [minted.id]
    )
    expect(tokenRow?.computer_id, 'the token records its computer').toBe(enrolled.computerId)

    let refused = ''
    try {
      await adapters.verifyEnrollment({
        ...ENROLL_BASE,
        name: 'thief-box',
        joinToken: minted.token
      })
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err)
    }
    expect(refused, `second redeem refused as used, got: ${refused}`).toMatch(/used/)

    const redeems = audit.filter((l) => l.event === 'computer.join_token.redeem')
    expect(redeems.length, 'one success line, one refusal').toBe(2)
    expect(redeems[0]!.outcome, 'success first').toBe('success')
    expect(redeems[0]!.targetId, 'names the token row').toBe(minted.id)
    expect(redeems[0]!.ip, 'client address from the socket context').toBe('198.51.100.9')
    const detail = redeems[0]!.detail as { computerId?: string; owner?: string }
    expect(detail.computerId, 'carries the computer').toBe(enrolled.computerId)
    expect(detail.owner, 'carries the owner').toBe(bob.id)
    expect((redeems[1]!.detail as { reason?: string }).reason, 'then used').toBe('used')
    const all = JSON.stringify(audit)
    expect(all, 'no line carries the token').not.toContain(minted.token)
    expect(all, 'nor its payload').not.toContain(minted.token.split('.')[1]!)
  } finally {
    setSecurityLogSink()
  }
})

test('T-20: a token for a user disabled since is refused at redeem, audited', async () => {
  const minted = await mintFor(dave.id, 'dave-laptop')
  expect(await disableHubUser(auth, 'dave@example.com'), 'dave disabled').toBe('ok')
  const audit: Array<Record<string, unknown>> = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
  let refused = ''
  try {
    await adapters.verifyEnrollment({
      ...ENROLL_BASE,
      name: 'dave-laptop',
      joinToken: minted.token
    })
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err)
  } finally {
    setSecurityLogSink()
  }
  expect(refused, `refused, got: ${refused}`).toMatch(/disabled/)
  const line = audit.find((l) => l.event === 'computer.join_token.redeem')
  expect(line?.outcome, 'denied').toBe('denied')
  expect((line?.detail as { reason?: string } | undefined)?.reason, 'reason').toBe('owner_disabled')
  const owned = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM computers WHERE owner_user_id = ?',
    [dave.id]
  )
  expect(owned?.n, 'no computer for dave').toBe(0)
})
