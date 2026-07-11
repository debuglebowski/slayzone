/**
 * Fleet auth adapter factory — end-to-end against real dependencies.
 *
 * Exercises `createFleetAuthAdapters` over a real migrated `SlayzoneDb` (the
 * full production migration chain, incl. the v149 fleet tables) and a real
 * `createHubAuth` better-auth instance on a throwaway sqlite file. No mocks of
 * the runners store, join-token verifier, or api-key mint/verify.
 *
 * Native ABI: the `SlayzoneDb` rides better-sqlite3 (rebuilt for Electron's
 * ABI), and createHubAuth uses `node:sqlite` — so this runs under the Electron
 * strict loader, not plain node/vitest. Hand-rolled harness (no vitest import)
 * to match the server package's other tests and its no-vitest tsconfig.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/server/src/fleet-auth.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { FLEET_PROTOCOL_VERSION } from '@slayzone/fleet/shared'
import { createHubAuth, RUNNER_KEY_PREFIX } from '@slayzone/hub-auth/server'
import { DB_PRAGMAS, type SlayzoneDb } from '@slayzone/platform'
import { getRunner, listRunners, mintJoinToken, revokeRunner } from '@slayzone/runners/server'
import { createSlayzoneDbAdapter } from '@slayzone/test-utils'
import { runMigrations } from '@slayzone/transport/db-bootstrap'
import { createFleetAuthAdapters } from './fleet-auth.js'

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
  protocolVersion: FLEET_PROTOCOL_VERSION
}

async function main(): Promise<void> {
  console.log('\nfleet-auth adapters (real DB + real hub-auth)')
  console.log('─'.repeat(48))

  const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-auth-test-'))
  const { db, close } = createMigratedDb()
  const auth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'fleet-auth-test-secret-at-least-32-chars-long'
  })
  const adapters = createFleetAuthAdapters({ db, auth })

  try {
    await test('verifyEnrollment registers a runner + returns {runnerId, apiKey}', async () => {
      const token = await mintToken(db)
      const result = await adapters.verifyEnrollment({ ...ENROLL_BASE, joinToken: token })

      assert(typeof result.runnerId === 'string' && result.runnerId.length > 0, 'runnerId set')
      assert(result.apiKey.startsWith(RUNNER_KEY_PREFIX), 'apiKey carries the runner prefix')

      const row = await getRunner(db, result.runnerId)
      assert(row !== null, 'runners row persisted')
      assertEq(row!.name, 'mac-studio', 'name persisted')
      assertEq(row!.platform, 'darwin-arm64', 'platform persisted')
      assertEq(row!.version, '0.35.0', 'version persisted')
      assert(row!.auth_key_id !== null && row!.auth_key_id!.length > 0, 'auth_key_id persisted')
      assertEq(row!.revoked_at, null, 'runner is active')
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
      assertEq(descriptor!.runnerId, enrolled.runnerId, 'descriptor runnerId matches')
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
        await adapters.verifyApiKey(`${RUNNER_KEY_PREFIX}bogus`),
        null,
        'well-prefixed but bogus key ⇒ null'
      )
    })

    await test('re-enroll after socket drop returns the SAME runnerId + apiKey', async () => {
      const token = await mintToken(db, 'reenroll')
      const params = { ...ENROLL_BASE, name: 'flaky-host', joinToken: token }

      const before = (await listRunners(db)).length
      const first = await adapters.verifyEnrollment(params)
      // Socket dropped before the runner got `first` — it re-dials and enrolls
      // again with the identical (joinToken, name). Single-use token is already
      // stamped; the grace ledger must make this a no-op re-issue, not a reject.
      const second = await adapters.verifyEnrollment(params)

      assertEq(second.runnerId, first.runnerId, 'stable runnerId across re-enroll')
      assertEq(second.apiKey, first.apiKey, 'identical apiKey across re-enroll')
      assertEq(
        (await listRunners(db)).length,
        before + 1,
        'exactly one runner registered (no duplicate)'
      )

      // And the re-issued key still authenticates.
      const descriptor = await adapters.verifyApiKey(second.apiKey)
      assert(descriptor !== null, 're-enroll key verifies')
      assertEq(descriptor!.runnerId, first.runnerId, 're-enroll key maps to same runner')
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
        const adaptersExpired = createFleetAuthAdapters({ db, auth, now: () => 10_000 })
        await adaptersExpired.verifyEnrollment({ ...ENROLL_BASE, joinToken: stale.token })
      } catch {
        threw = true
      }
      assert(threw, 'expired token rejected')
    })

    await test('revoked runner ⇒ verifyApiKey returns null', async () => {
      const token = await mintToken(db, 'revoke')
      const enrolled = await adapters.verifyEnrollment({
        ...ENROLL_BASE,
        name: 'doomed-host',
        joinToken: token
      })
      assert((await adapters.verifyApiKey(enrolled.apiKey)) !== null, 'valid before revoke')

      await revokeRunner(db, enrolled.runnerId)
      assertEq(
        await adapters.verifyApiKey(enrolled.apiKey),
        null,
        'revoked runner no longer authenticates'
      )
    })
  } finally {
    close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
