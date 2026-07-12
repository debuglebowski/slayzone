/**
 * Fleet restart-survival: local runner stays ONE row across reboots (Wave3.5-D5).
 *
 * The gap the single-boot fleet e2e (110-fleet-loopback) missed: nothing proved
 * a SECOND boot against the SAME persisted store reuses the runner's row instead
 * of orphaning a fresh one. The bug: the `/fleet` listener bound an OS-assigned
 * port each boot; the runner keys its credential file by hub host+PORT
 * (`hubHostFromUrl` → `host_port`), so a new port ⇒ a new credential filename ⇒
 * the runner can't `hello` with prior creds ⇒ RE-ENROLLS as a new `runners` row.
 * One orphaned `local-runner` accumulated per relaunch.
 *
 * This drives the WHOLE chain at the store+claim level — closest-to-real that's
 * reliable (a full app relaunch in Playwright is heavy + flaky; the memory note
 * warns bare launches clobber the real dev store). Everything below is the REAL
 * production code, not mocks:
 *   - PART 1 port pinning: `resolveDesiredFleetPort` + `claimFleetServerPort`
 *     (persist to `settings.fleet_server_port`) over a real migrated SlayzoneDb.
 *   - the runner's REAL `createFileCredentialStore` keyed by `hubHostFromUrl`.
 *   - the REAL `createFleetAuthAdapters` (enroll/hello + local dedup) over a REAL
 *     `createHubAuth` + REAL `mintJoinToken` / api-key mint+verify.
 *
 * A `simulateBoot` models exactly one sidecar boot: resolve the desired fleet
 * port, "bind" it (an OS assigns a fresh port only when asked for 0 — the precise
 * behavior that caused the bug), persist it, mint a token embedding
 * `wss://host:<port>/fleet`, then run the runner's authenticate logic (mirrors
 * hub-dialer: load creds → `hello`, else `enroll` + save).
 *
 * Native ABI: SlayzoneDb rides better-sqlite3 (Electron ABI) and createHubAuth
 * uses node:sqlite — so this runs under the Electron strict loader, like
 * fleet-auth.test.ts. Hand-rolled harness (no vitest).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/server/src/fleet-restart-survival.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createFileCredentialStore, hubHostFromUrl } from '@slayzone/fleet/client'
import { FLEET_PROTOCOL_VERSION } from '@slayzone/fleet/shared'
import { createHubAuth, type HubAuth } from '@slayzone/hub-auth/server'
import { DB_PRAGMAS, type SlayzoneDb } from '@slayzone/platform'
import { listRunners, mintJoinToken } from '@slayzone/runners/server'
import { createSlayzoneDbAdapter } from '@slayzone/test-utils'
import { runMigrations } from '@slayzone/transport/db-bootstrap'
import { createFleetAuthAdapters } from './fleet-auth.js'
import { claimFleetServerPort, resolveDesiredFleetPort } from './port-claim.js'

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

function createMigratedDb(): { db: SlayzoneDb; close: () => void } {
  const raw = new Database(':memory:')
  for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
  runMigrations(raw)
  return { db: createSlayzoneDbAdapter(raw), close: () => raw.close() }
}

const HOST = '127.0.0.1'
const LOCAL_NAME = 'local-runner'

/** A fake OS port allocator: hands out a fresh port ONLY when asked to bind 0
 *  (the OS-assigned path). A non-zero request "binds" that exact port when free,
 *  or returns `null` when the port is in `taken` (models EADDRINUSE on a pinned
 *  port). Port 0 → a NEW port every boot — the precise behavior at the root of
 *  the bug. */
function makePortAllocator(
  start = 51000,
  taken: Set<number> = new Set()
): (requested: number) => number | null {
  let next = start
  return (requested: number) => {
    if (requested === 0) {
      while (taken.has(next)) next++
      return next++
    }
    return taken.has(requested) ? null : requested
  }
}

interface BootDeps {
  db: SlayzoneDb
  auth: HubAuth
  /** The runner's credential dir — STABLE across boots (only the filename within
   *  it varies, keyed by hub host+port via hubHostFromUrl). */
  credsBaseDir: string
  /** Bind a requested port. `0` ⇒ a fresh OS-assigned port. A non-zero request
   *  returns that exact port when free, or `null` when TAKEN (models EADDRINUSE
   *  → the server.ts pinned-bind failure that must fall back + re-persist). */
  bindPort: (requested: number) => number | null
  /** Override SLAYZONE_FLEET_PORT for this boot (operator pin). */
  fleetPortEnv?: string
  /** Match production: the auth adapters know the local runner's name. */
  localRunnerName?: string
}

interface BootResult {
  boundPort: number
  hubUrl: string
  authMode: 'enroll' | 'hello'
  runnerId: string
}

/** One sidecar boot + one runner (re)connect against the SAME persisted store.
 *  Mirrors server.ts's resolve → bind → (fallback on pinned failure) → persist,
 *  including the `force` re-claim when a pinned bind fails and we fall back. */
async function simulateBoot(deps: BootDeps): Promise<BootResult> {
  // PART 1: resolve the desired fleet port (env > persisted > 0), "bind" it, and
  // persist the actually-bound port for the next boot.
  const desired = await resolveDesiredFleetPort(deps.db, deps.fleetPortEnv)
  let boundPort = deps.bindPort(desired)
  let fellBackFromPinned = false
  if (boundPort === null) {
    // Pinned port taken (no explicit env override in these sims) → fall back to
    // an OS-assigned port, exactly like server.ts, and force-persist it.
    boundPort = deps.bindPort(0)
    if (boundPort === null) throw new Error('OS-assigned bind unexpectedly failed')
    fellBackFromPinned = true
  }
  await claimFleetServerPort(deps.db, HOST, boundPort, () => {}, { force: fellBackFromPinned })

  const hubUrl = `wss://${HOST}:${boundPort}/fleet`
  const minted = await mintJoinToken(deps.db, {
    hubUrl,
    certFingerprint: 'sha256:deadbeef',
    ttlMs: 60_000,
    label: LOCAL_NAME
  })

  // The runner side: real credential store keyed by hub host+port, real adapters.
  const store = createFileCredentialStore(hubHostFromUrl(hubUrl), { baseDir: deps.credsBaseDir })
  const adapters = createFleetAuthAdapters({
    db: deps.db,
    auth: deps.auth,
    ...(deps.localRunnerName ? { localRunnerName: deps.localRunnerName } : {})
  })

  // Mirror hub-dialer.authenticate: try `hello` with stored creds, else `enroll`.
  const stored = await store.load()
  if (stored) {
    const descriptor = await adapters.verifyApiKey(stored.apiKey)
    if (descriptor) {
      return { boundPort, hubUrl, authMode: 'hello', runnerId: descriptor.runnerId }
    }
  }
  const enrolled = await adapters.verifyEnrollment({
    joinToken: minted.token,
    name: LOCAL_NAME,
    platform: 'darwin-arm64',
    version: '0.35.0',
    capabilities: ['pty', 'git'],
    protocolVersion: FLEET_PROTOCOL_VERSION
  })
  await store.save({ runnerId: enrolled.runnerId, apiKey: enrolled.apiKey })
  return { boundPort, hubUrl, authMode: 'enroll', runnerId: enrolled.runnerId }
}

function localRunnerCount(db: SlayzoneDb): Promise<number> {
  return listRunners(db).then((rows) => rows.filter((r) => r.name === LOCAL_NAME).length)
}

async function main(): Promise<void> {
  console.log('\nfleet restart-survival (local runner stays ONE row across reboots)')
  console.log('─'.repeat(64))

  const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-restart-'))
  const auth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9998',
    secret: 'fleet-restart-survival-secret-at-least-32-chars'
  })

  try {
    await test('stable pinned port ⇒ boot 2 HELLOs into the same row (count stays 1)', async () => {
      const { db, close } = createMigratedDb()
      const credsBaseDir = mkdtempSync(join(tmpDir, 'creds-stable-'))
      const bindPort = makePortAllocator(51000)
      try {
        const boot1 = await simulateBoot({ db, auth, credsBaseDir, bindPort, localRunnerName: LOCAL_NAME })
        assertEq(boot1.authMode, 'enroll', 'boot 1 enrolls (no prior creds)')
        assertEq(await localRunnerCount(db), 1, 'one local runner after boot 1')

        // Boot 2: PART 1 makes resolveDesiredFleetPort return the persisted port,
        // so bindPort reuses it → the credential key is identical → hello.
        const boot2 = await simulateBoot({ db, auth, credsBaseDir, bindPort, localRunnerName: LOCAL_NAME })
        assertEq(boot2.boundPort, boot1.boundPort, 'boot 2 reused the pinned port')
        assertEq(boot2.authMode, 'hello', 'boot 2 HELLOs with the persisted creds')
        assertEq(boot2.runnerId, boot1.runnerId, 'same runnerId across reboots')
        assertEq(await localRunnerCount(db), 1, 'STILL one local runner after boot 2')

        // A third boot for good measure — the survival property must hold steady.
        const boot3 = await simulateBoot({ db, auth, credsBaseDir, bindPort, localRunnerName: LOCAL_NAME })
        assertEq(boot3.authMode, 'hello', 'boot 3 also HELLOs')
        assertEq(await localRunnerCount(db), 1, 'still one local runner after boot 3')
      } finally {
        close()
      }
    })

    await test('pinned port TAKEN ⇒ fallback port is force-persisted; next boot HELLOs (stays 1)', async () => {
      // The coverage gap: boot 1 pins 51000; before boot 2 something ELSE grabs
      // 51000 (still live). Boot 2's pinned bind fails → falls back to an
      // OS-assigned port → force-persists it (the guard would otherwise refuse,
      // seeing 51000 alive). Boot 3 must then reuse the NEW pinned port and HELLO —
      // proving the fix converges instead of re-enrolling every boot.
      const { db, close } = createMigratedDb()
      const credsBaseDir = mkdtempSync(join(tmpDir, 'creds-conflict-'))
      const taken = new Set<number>()
      const bindPort = makePortAllocator(51000, taken)
      try {
        const boot1 = await simulateBoot({ db, auth, credsBaseDir, bindPort, localRunnerName: LOCAL_NAME })
        assertEq(boot1.boundPort, 51000, 'boot 1 bound the first OS-assigned port')
        assertEq(boot1.authMode, 'enroll', 'boot 1 enrolls')

        // A foreign process now holds 51000 (and it is "still live"). Boot 2 must
        // fall back + re-persist, NOT go dark and NOT keep the stale pin.
        taken.add(51000)
        const boot2 = await simulateBoot({ db, auth, credsBaseDir, bindPort, localRunnerName: LOCAL_NAME })
        assert(boot2.boundPort !== 51000, 'boot 2 fell back off the taken pinned port')
        // Boot 2 re-enrolls (its new-port credential key can't match boot-1 creds),
        // but PART 2 dedup keeps it a single row.
        assertEq(await localRunnerCount(db), 1, 'still one local runner after the conflict boot')

        // The fallback port must have been FORCE-persisted → boot 3 (conflict
        // cleared) reuses it and HELLOs. Without force, boot 3 would re-pin 51000,
        // fail again, churn forever. This is the regression guard for finding #1.
        const persisted = await resolveDesiredFleetPort(db, undefined)
        assertEq(persisted, boot2.boundPort, 'fallback port was persisted (force bypassed the guard)')
        const boot3 = await simulateBoot({ db, auth, credsBaseDir, bindPort, localRunnerName: LOCAL_NAME })
        assertEq(boot3.boundPort, boot2.boundPort, 'boot 3 reuses the stabilized fallback port')
        assertEq(boot3.authMode, 'hello', 'boot 3 HELLOs — the URL/credential key stopped churning')
        assertEq(await localRunnerCount(db), 1, 'still ONE local runner after convergence')
      } finally {
        close()
      }
    })

    await test('regression guard: WITHOUT port pinning the credential key changes each boot', async () => {
      // Proves the bug the fix addresses: if the port is NOT pinned (always
      // OS-assigned), boot 2's credential filename differs → creds miss → enroll.
      // We reproduce by NOT persisting/reusing the port (bindPort always fresh).
      const { db, close } = createMigratedDb()
      const credsBaseDir = mkdtempSync(join(tmpDir, 'creds-unpinned-'))
      let fakePort = 60000
      try {
        // Boot 1 on port 60000.
        const url1 = `wss://${HOST}:${fakePort}/fleet`
        const store1 = createFileCredentialStore(hubHostFromUrl(url1), { baseDir: credsBaseDir })
        assertEq(await store1.load(), null, 'no creds before first enroll')
        // Boot 2 on a DIFFERENT port 60001 — the pre-fix reality.
        fakePort += 1
        const url2 = `wss://${HOST}:${fakePort}/fleet`
        const store2 = createFileCredentialStore(hubHostFromUrl(url2), { baseDir: credsBaseDir })
        // Save creds under boot-1's key, then confirm boot-2's key can't see them.
        await store1.save({ runnerId: 'x', apiKey: 'k' })
        assert((await store1.load()) !== null, 'boot-1 key reads its own creds')
        assertEq(
          await store2.load(),
          null,
          'boot-2 key (different port) CANNOT read boot-1 creds → would re-enroll'
        )
      } finally {
        close()
      }
    })

    await test('PART 2 dedup collapses pre-existing duplicates to one on next local enroll', async () => {
      // Seed the user's current broken state: multiple orphaned local rows (from
      // pre-fix relaunches, each a fresh-uuid enroll under the local name), plus a
      // legitimate REMOTE runner that must survive.
      const { db, close } = createMigratedDb()
      const credsBaseDir = mkdtempSync(join(tmpDir, 'creds-dedup-'))
      try {
        const remoteAdapters = createFleetAuthAdapters({ db, auth }) // no localRunnerName → fresh uuids
        for (const label of ['orphan-1', 'orphan-2', 'orphan-3']) {
          const t = await mintJoinToken(db, {
            hubUrl: `wss://${HOST}:59999/fleet`,
            certFingerprint: 'sha256:deadbeef',
            ttlMs: 60_000,
            label
          })
          await remoteAdapters.verifyEnrollment({
            joinToken: t.token,
            name: LOCAL_NAME,
            platform: 'p',
            version: 'v',
            capabilities: [],
            protocolVersion: FLEET_PROTOCOL_VERSION
          })
        }
        // A real remote runner (different name) — a sleeping laptop; must NOT be reaped.
        const remoteToken = await mintJoinToken(db, {
          hubUrl: `wss://${HOST}:59999/fleet`,
          certFingerprint: 'sha256:deadbeef',
          ttlMs: 60_000,
          label: 'sleeping-laptop'
        })
        const remote = await remoteAdapters.verifyEnrollment({
          joinToken: remoteToken.token,
          name: 'sleeping-laptop',
          platform: 'p',
          version: 'v',
          capabilities: [],
          protocolVersion: FLEET_PROTOCOL_VERSION
        })
        assertEq(await localRunnerCount(db), 3, 'three orphaned local rows seeded')

        // The next fleet-enabled boot: the local runner enrolls → dedup collapses.
        const boot = await simulateBoot({ db, auth, credsBaseDir, bindPort: makePortAllocator(51500), localRunnerName: LOCAL_NAME })
        assertEq(boot.authMode, 'enroll', 'first boot in this store enrolls')
        assertEq(await localRunnerCount(db), 1, 'collapsed to a single local runner')
        // Remote runner untouched — dedup is identity-only (by local name), never
        // status-based and never touches a remote runner.
        assert(
          (await listRunners(db)).some((r) => r.id === remote.runnerId),
          'remote runner survives'
        )
      } finally {
        close()
      }
    })

    await test('operator SLAYZONE_FLEET_PORT override pins directly (also stays 1 across boots)', async () => {
      const { db, close } = createMigratedDb()
      const credsBaseDir = mkdtempSync(join(tmpDir, 'creds-envpin-'))
      const bindPort = makePortAllocator(51000)
      try {
        const boot1 = await simulateBoot({ db, auth, credsBaseDir, bindPort, fleetPortEnv: '51234', localRunnerName: LOCAL_NAME })
        assertEq(boot1.boundPort, 51234, 'env override port bound')
        const boot2 = await simulateBoot({ db, auth, credsBaseDir, bindPort, fleetPortEnv: '51234', localRunnerName: LOCAL_NAME })
        assertEq(boot2.boundPort, 51234, 'env override reused')
        assertEq(boot2.authMode, 'hello', 'boot 2 HELLOs under the env pin')
        assertEq(await localRunnerCount(db), 1, 'one local runner under env pin')
      } finally {
        close()
      }
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
