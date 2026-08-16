/**
 * Computer auth adapter factory — end-to-end against real dependencies.
 *
 * Exercises `createComputerAuthAdapters` over a real migrated `SlayzoneDb` (the
 * full production migration chain, incl. the v149 computer tables) and a real
 * `createHubAuth` better-auth instance on a throwaway sqlite file. No mocks of
 * the computers store, join-token verifier, or api-key mint/verify.
 *
 * Native ABI: the `SlayzoneDb` rides better-sqlite3 (rebuilt for Electron's
 * ABI), and createHubAuth uses `node:sqlite` — so this runs under the Electron
 * strict loader, not plain node/vitest. Hand-rolled harness (no vitest import)
 * to match the server package's other tests and its no-vitest tsconfig.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/computer-auth.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { COMPUTER_PROTOCOL_VERSION } from '@slayzone/computer-transport/shared'
import { createHubAuth, COMPUTER_KEY_PREFIX } from '@slayzone/hub-auth/server'
import { DB_PRAGMAS, type SlayzoneDb } from '@slayzone/platform'
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

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
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
    certFingerprint: 'sha256:deadbeef',
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

async function main(): Promise<void> {
  console.log('\ncomputer-auth adapters (real DB + real hub-auth)')
  console.log('─'.repeat(48))

  const tmpDir = mkdtempSync(join(tmpdir(), 'computer-auth-test-'))
  const { db, close } = createMigratedDb()
  const auth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'computer-auth-test-secret-at-least-32-chars-long'
  })
  const adapters = createComputerAuthAdapters({ db, auth })

  try {
    await test('verifyEnrollment registers a computer + returns {computerId, apiKey}', async () => {
      const token = await mintToken(db)
      const result = await adapters.verifyEnrollment({ ...ENROLL_BASE, joinToken: token })

      assert(
        typeof result.computerId === 'string' && result.computerId.length > 0,
        'computerId set'
      )
      assert(result.apiKey.startsWith(COMPUTER_KEY_PREFIX), 'apiKey carries the computer prefix')

      const row = await getComputer(db, result.computerId)
      assert(row !== null, 'computers row persisted')
      assertEq(row!.name, 'mac-studio', 'name persisted')
      assertEq(row!.platform, 'darwin-arm64', 'platform persisted')
      assertEq(row!.version, '0.35.0', 'version persisted')
      assert(row!.auth_key_id !== null && row!.auth_key_id!.length > 0, 'auth_key_id persisted')
      assertEq(row!.revoked_at, null, 'computer is active')
      const storedCaps = JSON.parse(row!.capabilities_json) as Record<string, unknown>
      assert(
        storedCaps.pty === true && storedCaps.git === true,
        'capability tags persisted as a { tag: true } map'
      )
    })

    await test('verifyApiKey resolves the descriptor for the minted key', async () => {
      const token = await mintToken(db, 'descriptor')
      const enrolled = await adapters.verifyEnrollment({
        ...ENROLL_BASE,
        name: 'descriptor-host',
        joinToken: token
      })

      const descriptor = await adapters.verifyApiKey(enrolled.apiKey)
      assert(descriptor !== null, 'descriptor resolved')
      assertEq(descriptor!.computerId, enrolled.computerId, 'descriptor computerId matches')
      assertEq(descriptor!.name, 'descriptor-host', 'descriptor name')
      assertEq(descriptor!.platform, 'darwin-arm64', 'descriptor platform')
      assertEq(descriptor!.version, '0.35.0', 'descriptor version')
      assert(Array.isArray(descriptor!.capabilities), 'capabilities is a string[]')
      assertEq(
        JSON.stringify(descriptor!.capabilities),
        JSON.stringify(['pty', 'git']),
        'capability tags round-trip'
      )
    })

    await test('verifyApiKey returns null for an unknown key', async () => {
      assertEq(await adapters.verifyApiKey('not-a-real-key'), null, 'unknown key ⇒ null')
      assertEq(
        await adapters.verifyApiKey(`${COMPUTER_KEY_PREFIX}bogus`),
        null,
        'well-prefixed but bogus key ⇒ null'
      )
    })

    await test('re-enroll after socket drop returns the SAME computerId + apiKey', async () => {
      const token = await mintToken(db, 'reenroll')
      const params = { ...ENROLL_BASE, name: 'flaky-host', joinToken: token }

      const before = (await listComputers(db)).length
      const first = await adapters.verifyEnrollment(params)
      // Socket dropped before the computer got `first` — it re-dials and enrolls
      // again with the identical (joinToken, name). Single-use token is already
      // stamped; the grace ledger must make this a no-op re-issue, not a reject.
      const second = await adapters.verifyEnrollment(params)

      assertEq(second.computerId, first.computerId, 'stable computerId across re-enroll')
      assertEq(second.apiKey, first.apiKey, 'identical apiKey across re-enroll')
      assertEq(
        (await listComputers(db)).length,
        before + 1,
        'exactly one computer registered (no duplicate)'
      )

      // And the re-issued key still authenticates.
      const descriptor = await adapters.verifyApiKey(second.apiKey)
      assert(descriptor !== null, 're-enroll key verifies')
      assertEq(descriptor!.computerId, first.computerId, 're-enroll key maps to same computer')
    })

    await test('a raw re-verify of a used token (miss ⇒ used) is rejected', async () => {
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
      assert(threw, 'used token under a new name is rejected')
    })

    await test('expired join token is rejected', async () => {
      const stale = await mintJoinToken(db, {
        hubUrl: 'https://hub.local:4141',
        certFingerprint: 'sha256:deadbeef',
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
      assert(threw, 'expired token rejected')
    })

    await test('revoked computer ⇒ verifyApiKey returns null', async () => {
      const token = await mintToken(db, 'revoke')
      const enrolled = await adapters.verifyEnrollment({
        ...ENROLL_BASE,
        name: 'doomed-host',
        joinToken: token
      })
      assert((await adapters.verifyApiKey(enrolled.apiKey)) !== null, 'valid before revoke')

      await revokeComputer(db, enrolled.computerId)
      assertEq(
        await adapters.verifyApiKey(enrolled.apiKey),
        null,
        'revoked computer no longer authenticates'
      )
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
    await test('a superseded key from a PRIOR enroll no longer authenticates', async () => {
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
      assert(
        (await localAdapters.verifyApiKey(first.apiKey)) !== null,
        'first key valid before rotate'
      )

      // A relaunch: new join token, same local name ⇒ same computer id, fresh key.
      const second = await localAdapters.verifyEnrollment({
        ...ENROLL_BASE,
        name: 'rotating-local',
        joinToken: await mintToken(db, 'rotate-2')
      })
      assertEq(second.computerId, first.computerId, 'same computer id across re-enroll')
      assert(second.apiKey !== first.apiKey, 'a distinct key was issued')

      assert(
        (await localAdapters.verifyApiKey(second.apiKey)) !== null,
        'current key authenticates'
      )
      assertEq(
        await localAdapters.verifyApiKey(first.apiKey),
        null,
        'superseded key is refused even though it names a live computer'
      )
    })

    // --- Local-computer dedup (Wave3.5-D5) -----------------------------------
    await test('LOCAL enroll uses a deterministic id + UPSERTs one row across relaunches', async () => {
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

      assertEq(
        first.computerId,
        deterministicLocalComputerId('local-computer'),
        'id is deterministic'
      )
      assertEq(second.computerId, first.computerId, 'relaunch keeps the SAME local computerId')
      assertEq(
        (await listComputers(db)).filter((r) => r.name === 'local-computer').length,
        before + 1,
        'exactly one local computer row after two enrolls (no orphan)'
      )
    })

    await test('a fresh LOCAL enroll collapses PRE-EXISTING duplicate local rows to one', async () => {
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
      assert(
        (await listComputers(db)).filter((r) => r.name === 'dup-local').length === 2,
        'two orphaned local rows seeded'
      )

      // The next computer-enabled boot enrolls the local computer → cleanup collapses.
      const enrolled = await localAdapters.verifyEnrollment({
        ...ENROLL_BASE,
        name: 'dup-local',
        joinToken: await mintToken(db, 'd3')
      })
      const localRows = (await listComputers(db)).filter((r) => r.name === 'dup-local')
      assertEq(localRows.length, 1, 'collapsed to a single local row')
      assertEq(
        localRows[0].id,
        enrolled.computerId,
        'the surviving row is the deterministic-id one'
      )
      assertEq(
        localRows[0].id,
        deterministicLocalComputerId('dup-local'),
        'kept the deterministic id'
      )
    })

    await test('REMOTE enroll keeps a fresh uuid + is never deduped by the local path', async () => {
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
      assert(
        r1.computerId !== deterministicLocalComputerId('remote-alpha'),
        'remote id is a fresh uuid'
      )
      // Both remote computers survive — dedup is scoped to the single local name only.
      assert((await getComputer(db, r1.computerId)) !== null, 'remote-alpha survives')
      assert((await getComputer(db, r2.computerId)) !== null, 'remote-beta survives')
    })
  } finally {
    close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
