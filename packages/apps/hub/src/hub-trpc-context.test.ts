/**
 * Client↔hub `/trpc` connection-context seam — end-to-end against a real
 * `createHubAuth`, exercising the two security-relevant decisions server.ts makes
 * per WS connection (extracted into hub-trpc-context.ts so they are testable
 * without the full startServer boot):
 *
 *   1. `parseWindowIdFromUrl` — the ?windowId=N → ctx.windowId parse.
 *   2. `resolveConnectionPrincipal` — the bearer-token → principal verification,
 *      gated on whether the hub enforces auth. This is the load-bearing gap the
 *      inventory flagged: the connectionParams.token → verifySession → principal
 *      path was never driven live. Here a REAL signed-in session token round-trips
 *      to a principal, a bogus/blank/absent token yields null, and the whole thing
 *      is inert (null, no verify) when auth is off.
 *
 * No mocks of hub-auth: a real better-auth instance on a throwaway node:sqlite
 * file mints a genuine session token via signInEmail. Native ABI: createHubAuth
 * uses node:sqlite, so this runs under the Electron strict loader like
 * runner-auth.test.ts (hand-rolled harness, no vitest import).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/hub-trpc-context.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubAuth, type HubAuth } from '@slayzone/hub-auth/server'
import { parseWindowIdFromUrl, resolveConnectionPrincipal } from './hub-trpc-context.js'

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

const EMAIL = 'client@example.com'
const PASSWORD = 'super-secret-password-1'

async function main(): Promise<void> {
  console.log('\nhub /trpc connection-context seam (real hub-auth)')
  console.log('─'.repeat(48))

  // ── parseWindowIdFromUrl (pure — no auth needed) ──────────────────────────
  await test('parseWindowIdFromUrl reads a valid ?windowId', () => {
    assertEq(parseWindowIdFromUrl('/trpc?windowId=7'), 7, 'windowId parsed')
    assertEq(parseWindowIdFromUrl('/trpc?windowId=0'), 0, 'zero is valid')
  })
  await test('parseWindowIdFromUrl returns null for absent / non-numeric / undefined', () => {
    assertEq(parseWindowIdFromUrl('/trpc'), null, 'absent → null')
    assertEq(parseWindowIdFromUrl('/trpc?windowId=abc'), null, 'non-numeric → null')
    assertEq(parseWindowIdFromUrl(undefined), null, 'undefined url → null')
  })
  await test('parseWindowIdFromUrl treats an empty ?windowId= as 0 (Number("") → 0, matches server.ts)', () => {
    // Faithful to the original inline parse: get() returns '' (not null), so the
    // null-check passes and Number('') === 0 is finite. Preserved on extraction.
    assertEq(parseWindowIdFromUrl('/trpc?windowId='), 0, 'empty value → 0')
  })
  await test('parseWindowIdFromUrl ignores other query params + keeps only windowId', () => {
    assertEq(parseWindowIdFromUrl('/trpc?token=x&windowId=42&foo=bar'), 42, 'windowId isolated')
  })

  const tmpDir = mkdtempSync(join(tmpdir(), 'hub-trpc-ctx-'))
  const auth: HubAuth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-trpc-ctx-test-secret-at-least-32-chars-long'
  })

  try {
    // Mint a genuine session token the way a real client would obtain one.
    await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: 'Client' } })
    const signIn = await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } })
    const validToken = signIn.token
    assert(typeof validToken === 'string' && validToken.length > 0, 'got a real session token')

    // ── auth ENFORCED (hubAuthRequired = true) ──────────────────────────────
    await test('a real signed-in session token resolves to a principal', async () => {
      const principal = await resolveConnectionPrincipal({
        hubAuthRequired: true,
        hubAuth: auth,
        token: validToken
      })
      assert(principal !== null, 'principal resolved')
      assert(
        typeof principal!.userId === 'string' && principal!.userId.length > 0,
        'principal carries a userId'
      )
      // Fresh sign-up has no active organization.
      assertEq(principal!.orgId, null, 'orgId is null for a user with no active org')
    })

    await test('a bogus token yields a null principal (rejected, not thrown)', async () => {
      const principal = await resolveConnectionPrincipal({
        hubAuthRequired: true,
        hubAuth: auth,
        token: 'not-a-real-session-token'
      })
      assertEq(principal, null, 'bogus token → null principal')
    })

    await test('a blank / undefined / null token yields a null principal', async () => {
      assertEq(
        await resolveConnectionPrincipal({ hubAuthRequired: true, hubAuth: auth, token: '' }),
        null,
        'empty string → null'
      )
      assertEq(
        await resolveConnectionPrincipal({ hubAuthRequired: true, hubAuth: auth, token: undefined }),
        null,
        'undefined → null'
      )
      assertEq(
        await resolveConnectionPrincipal({ hubAuthRequired: true, hubAuth: auth, token: null }),
        null,
        'null → null'
      )
    })

    // ── auth OFF (the default local-loopback path) ──────────────────────────
    await test('auth OFF: even a VALID token yields null (inert — no verify, byte-identical)', async () => {
      const principal = await resolveConnectionPrincipal({
        hubAuthRequired: false,
        hubAuth: auth,
        token: validToken
      })
      assertEq(principal, null, 'gate off → null principal despite a valid token')
    })

    await test('no hubAuth instance: null principal even when auth is nominally required', async () => {
      const principal = await resolveConnectionPrincipal({
        hubAuthRequired: true,
        hubAuth: null,
        token: validToken
      })
      assertEq(principal, null, 'missing hubAuth → null (fail-closed, no crash)')
    })

    // ── the full server.ts wiring: token+windowId together ──────────────────
    await test('end-to-end: a client connect frame (windowId + bearer) produces windowId + principal', async () => {
      // Mirror server.ts createTrpcContext: parse the url for windowId and the
      // connectionParams for the token, both from one simulated connect.
      const reqUrl = '/trpc?windowId=3'
      const connectionParams: Record<string, string | undefined> = { token: validToken }
      const windowId = parseWindowIdFromUrl(reqUrl)
      const principal = await resolveConnectionPrincipal({
        hubAuthRequired: true,
        hubAuth: auth,
        token: connectionParams.token
      })
      assertEq(windowId, 3, 'windowId flows through')
      assert(principal !== null && principal.userId.length > 0, 'principal attributed on the same connect')
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
