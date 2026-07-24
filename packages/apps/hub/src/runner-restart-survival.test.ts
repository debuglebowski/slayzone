/**
 * Runner restart-survival: local runner stays ONE row across reboots.
 *
 * The gap the single-boot runner e2e (110-runner-loopback) missed: nothing proved
 * a SECOND boot against the SAME persisted store reuses the runner's row instead
 * of orphaning a fresh one. The runner keys its credential file by hub host+PORT
 * (`hubHostFromUrl` → `host_port`), so if the port CHANGES between boots the
 * credential filename changes ⇒ the runner can't `hello` with prior creds ⇒
 * RE-ENROLLS as a new `runners` row (an orphaned `local-runner` per relaunch).
 *
 * Single-listener model: `/runners` rides the ONE hub port (no separate runner
 * listener), and that hub port is STABLE per-environment (SIDECAR_FIXED_PORT /
 * claimServerPort). So the credential key is stable BY CONSTRUCTION — there is no
 * separate runner-port persistence layer to keep in sync. This test proves the
 * survival property holds under that model: a stable hub port ⇒ boot 2 HELLOs into
 * the same row; and the name-based dedup still collapses any pre-existing orphans.
 *
 * This drives the WHOLE chain at the store level — closest-to-real that's reliable
 * (a full app relaunch in Playwright is heavy + flaky; the memory note warns bare
 * launches clobber the real dev store). Everything below is REAL production code:
 *   - `deriveRunnerHubUrl` (the shared-port URL the join token embeds).
 *   - the runner's REAL `createFileCredentialStore` keyed by `hubHostFromUrl`.
 *   - the REAL `createRunnerAuthAdapters` (enroll/hello + local dedup) over a REAL
 *     `createHubAuth` + REAL `mintJoinToken` / api-key mint+verify.
 *
 * A `simulateBoot` models exactly one sidecar boot: derive the runner URL from the
 * (stable) hub port, mint a token embedding it, then run the runner's authenticate
 * logic (mirrors hub-dialer: load creds → `hello`, else `enroll` + save).
 *
 * Native ABI: SlayzoneDb rides better-sqlite3 (Electron ABI) and createHubAuth
 * uses node:sqlite — so this runs under the Electron strict loader, like
 * runner-auth.test.ts. Hand-rolled harness (no vitest).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/runner-restart-survival.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createFileCredentialStore, hubHostFromUrl } from '@slayzone/runner-transport/client'
import { RUNNER_PROTOCOL_VERSION } from '@slayzone/runner-transport/shared'
import { createHubAuth, type HubAuth } from '@slayzone/hub-auth/server'
import { DB_PRAGMAS, type SlayzoneDb } from '@slayzone/platform'
import { listRunners, mintJoinToken } from '@slayzone/runners/server'
import { createSlayzoneDbAdapter } from '@slayzone/test-utils'
import { runMigrations } from '@slayzone/transport/db-bootstrap'
import { createRunnerAuthAdapters } from './runner-auth.js'
import { deriveRunnerHubUrl } from './runner-listener.js'

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
/** The stable per-environment hub port `/runners` rides (SIDECAR_FIXED_PORT.test).
 *  Constant across boots BY CONSTRUCTION — that stability is the whole point. */
const HUB_PORT = 51102

interface BootDeps {
  db: SlayzoneDb
  auth: HubAuth
  /** The runner's credential dir — STABLE across boots (only the filename within
   *  it varies, keyed by hub host+port via hubHostFromUrl). */
  credsBaseDir: string
  /** The hub port this boot serves on. Defaults to the stable HUB_PORT; a test can
   *  pass a DIFFERENT value to model the (now-impossible-in-prod) port-churn case. */
  hubPort?: number
  /** Match production: the auth adapters know the local runner's name. */
  localRunnerName?: string
}

interface BootResult {
  hubUrl: string
  authMode: 'enroll' | 'hello'
  runnerId: string
}

/** One sidecar boot + one runner (re)connect against the SAME persisted store.
 *  Mirrors server.ts: derive the `/runners` URL from the (stable) hub port, mint a
 *  token embedding it, then run the runner's authenticate logic. */
async function simulateBoot(deps: BootDeps): Promise<BootResult> {
  const hubUrl = deriveRunnerHubUrl({ remote: false, host: HOST, port: deps.hubPort ?? HUB_PORT })!
  const minted = await mintJoinToken(deps.db, {
    hubUrl,
    certFingerprint: 'sha256:deadbeef',
    ttlMs: 60_000,
    label: LOCAL_NAME
  })

  // The runner side: real credential store keyed by hub host+port, real adapters.
  const store = createFileCredentialStore(hubHostFromUrl(hubUrl), { baseDir: deps.credsBaseDir })
  const adapters = createRunnerAuthAdapters({
    db: deps.db,
    auth: deps.auth,
    ...(deps.localRunnerName ? { localRunnerName: deps.localRunnerName } : {})
  })

  // Mirror hub-dialer.authenticate: try `hello` with stored creds, else `enroll`.
  const stored = await store.load()
  if (stored) {
    const descriptor = await adapters.verifyApiKey(stored.apiKey)
    if (descriptor) {
      return { hubUrl, authMode: 'hello', runnerId: descriptor.runnerId }
    }
  }
  const enrolled = await adapters.verifyEnrollment({
    joinToken: minted.token,
    name: LOCAL_NAME,
    platform: 'darwin-arm64',
    version: '0.35.0',
    capabilities: ['pty', 'git'],
    protocolVersion: RUNNER_PROTOCOL_VERSION
  })
  await store.save({ runnerId: enrolled.runnerId, apiKey: enrolled.apiKey })
  return { hubUrl, authMode: 'enroll', runnerId: enrolled.runnerId }
}

function localRunnerCount(db: SlayzoneDb): Promise<number> {
  return listRunners(db).then((rows) => rows.filter((r) => r.name === LOCAL_NAME).length)
}

async function main(): Promise<void> {
  console.log('\nrunner restart-survival (local runner stays ONE row across reboots)')
  console.log('─'.repeat(64))

  const tmpDir = mkdtempSync(join(tmpdir(), 'runner-restart-'))
  const auth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9998',
    secret: 'runner-restart-survival-secret-at-least-32-chars'
  })

  try {
    await test('stable hub port ⇒ boot 2 HELLOs into the same row (count stays 1)', async () => {
      const { db, close } = createMigratedDb()
      const credsBaseDir = mkdtempSync(join(tmpDir, 'creds-stable-'))
      try {
        const boot1 = await simulateBoot({ db, auth, credsBaseDir, localRunnerName: LOCAL_NAME })
        assertEq(boot1.authMode, 'enroll', 'boot 1 enrolls (no prior creds)')
        assertEq(await localRunnerCount(db), 1, 'one local runner after boot 1')

        // Boot 2: same stable hub port → identical credential key → hello.
        const boot2 = await simulateBoot({ db, auth, credsBaseDir, localRunnerName: LOCAL_NAME })
        assertEq(boot2.hubUrl, boot1.hubUrl, 'boot 2 derives the identical runner URL')
        assertEq(boot2.authMode, 'hello', 'boot 2 HELLOs with the persisted creds')
        assertEq(boot2.runnerId, boot1.runnerId, 'same runnerId across reboots')
        assertEq(await localRunnerCount(db), 1, 'STILL one local runner after boot 2')

        // A third boot for good measure — the survival property must hold steady.
        const boot3 = await simulateBoot({ db, auth, credsBaseDir, localRunnerName: LOCAL_NAME })
        assertEq(boot3.authMode, 'hello', 'boot 3 also HELLOs')
        assertEq(await localRunnerCount(db), 1, 'still one local runner after boot 3')
      } finally {
        close()
      }
    })

    await test('regression guard: a CHANGED hub port would change the credential key (why stability matters)', async () => {
      // Documents the failure the single-listener model structurally prevents: if
      // the hub port differed between boots, the runner's credential filename
      // (hubHostFromUrl → host_port) would differ → creds miss → re-enroll. The
      // production hub port is fixed per-environment (SIDECAR_FIXED_PORT), so this
      // can't happen; the assertion pins the property so a future change that
      // reintroduces a churning port is caught.
      const { db, close } = createMigratedDb()
      const credsBaseDir = mkdtempSync(join(tmpDir, 'creds-portchange-'))
      try {
        const url1 = deriveRunnerHubUrl({ remote: false, host: HOST, port: 60000 })!
        const url2 = deriveRunnerHubUrl({ remote: false, host: HOST, port: 60001 })!
        const store1 = createFileCredentialStore(hubHostFromUrl(url1), { baseDir: credsBaseDir })
        const store2 = createFileCredentialStore(hubHostFromUrl(url2), { baseDir: credsBaseDir })
        await store1.save({ runnerId: 'x', apiKey: 'k' })
        assert((await store1.load()) !== null, 'boot-1 key reads its own creds')
        assertEq(
          await store2.load(),
          null,
          'a DIFFERENT hub port yields a different credential key → would re-enroll'
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
        const remoteAdapters = createRunnerAuthAdapters({ db, auth }) // no localRunnerName → fresh uuids
        for (const label of ['orphan-1', 'orphan-2', 'orphan-3']) {
          const t = await mintJoinToken(db, {
            hubUrl: `wss://${HOST}:59999/runners`,
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
            protocolVersion: RUNNER_PROTOCOL_VERSION
          })
        }
        // A real remote runner (different name) — a sleeping laptop; must NOT be reaped.
        const remoteToken = await mintJoinToken(db, {
          hubUrl: `wss://${HOST}:59999/runners`,
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
          protocolVersion: RUNNER_PROTOCOL_VERSION
        })
        assertEq(await localRunnerCount(db), 3, 'three orphaned local rows seeded')

        // The next runner-enabled boot: the local runner enrolls → dedup collapses.
        const boot = await simulateBoot({ db, auth, credsBaseDir, localRunnerName: LOCAL_NAME })
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
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
