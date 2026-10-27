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
 * uses node:sqlite, so this runs under vitest on Electron's node like
 * computer-auth.test.ts.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SlayzoneDb } from '@slayzone/platform'
import { createHubAuth, createHubUser, type HubAuth } from '@slayzone/hub-auth/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import {
  connectionToken,
  parseWindowIdFromUrl,
  resolveConnectionPrincipal
} from './hub-trpc-context.js'
import { mintWebSession, WEB_SESSION_COOKIE_NAME } from './web-sessions.js'

const EMAIL = 'client@example.com'

// ── parseWindowIdFromUrl (pure — no auth needed) ──────────────────────────
test('parseWindowIdFromUrl reads a valid ?windowId', () => {
  expect(parseWindowIdFromUrl('/trpc?windowId=7'), 'windowId parsed').toBe(7)
  expect(parseWindowIdFromUrl('/trpc?windowId=0'), 'zero is valid').toBe(0)
})
test('parseWindowIdFromUrl returns null for absent / non-numeric / undefined', () => {
  expect(parseWindowIdFromUrl('/trpc'), 'absent → null').toBeNull()
  expect(parseWindowIdFromUrl('/trpc?windowId=abc'), 'non-numeric → null').toBeNull()
  expect(parseWindowIdFromUrl(undefined), 'undefined url → null').toBeNull()
})
test('parseWindowIdFromUrl treats an empty ?windowId= as 0 (Number("") → 0, matches server.ts)', () => {
  // Faithful to the original inline parse: get() returns '' (not null), so the
  // null-check passes and Number('') === 0 is finite. Preserved on extraction.
  expect(parseWindowIdFromUrl('/trpc?windowId='), 'empty value → 0').toBe(0)
})
test('parseWindowIdFromUrl ignores other query params + keeps only windowId', () => {
  expect(parseWindowIdFromUrl('/trpc?token=x&windowId=42&foo=bar'), 'windowId isolated').toBe(42)
})

const tmpDir = mkdtempSync(join(tmpdir(), 'hub-trpc-ctx-'))
// One path for createHubAuth and the direct flag flips below: two literals drifted
// apart once (the auth DB rename) and the flips silently hit an empty new file.
const authDbPath = join(tmpDir, 'slayzone.auth.sqlite')
const auth: HubAuth = await createHubAuth({
  dbPath: authDbPath,
  baseURL: 'http://127.0.0.1:9999',
  secret: 'hub-trpc-ctx-test-secret-at-least-32-chars-long'
})
// A real migrated SlayzoneDb for the szw_ web-session path — the tRPC twin
// of rest-auth.test.ts's szw_ coverage.
const harness = await createTestHarness()
const db: SlayzoneDb = harness.slayDb

afterAll(async () => {
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

// Mint a genuine session token the way a real client would obtain one. Public
// signup is closed (`disableSignUp`), so the account comes from createHubUser,
// which generates the password and returns it once.
const created = await createHubUser(auth, { email: EMAIL, name: 'Client' })
if ('error' in created) throw new Error('created the fixture account')
const signIn = await auth.api.signInEmail({
  body: { email: EMAIL, password: created.password }
})
const validToken = signIn.token
if (!(typeof validToken === 'string' && validToken.length > 0)) {
  throw new Error('got a real session token')
}

// ── auth ENFORCED (hubAuthRequired = true) ──────────────────────────────
test('a real signed-in session token resolves to a principal', async () => {
  const principal = await resolveConnectionPrincipal({
    hubAuthRequired: true,
    hubAuth: auth,
    db: null,
    token: validToken
  })
  expect(principal, 'principal resolved').not.toBeNull()
  expect(typeof principal!.userId, 'principal carries a userId').toBe('string')
  expect(principal!.userId.length, 'principal carries a userId').toBeGreaterThan(0)
  // Fresh sign-up has no active organization.
  expect(principal!.orgId, 'orgId is null for a user with no active org').toBeNull()
  // Every principal resolved through THIS path (verifySession — desktop,
  // CLI, a co-located `slay` via the bootstrap-owner token) carries `full`,
  // which the scope gate in trpc.ts treats as "skip the check entirely".
  // This is the guarantee that every existing client stays byte-identical
  // now that scopes exist at all — a narrower array only ever comes from
  // the separate scoped web-session resolver.
  expect(principal!.scopes.join(','), 'session principal is full-scoped').toBe('full')
})

test('a bogus token yields a null principal (rejected, not thrown)', async () => {
  const principal = await resolveConnectionPrincipal({
    hubAuthRequired: true,
    hubAuth: auth,
    db: null,
    token: 'not-a-real-session-token'
  })
  expect(principal, 'bogus token → null principal').toBeNull()
})

test('a blank / undefined / null token yields a null principal', async () => {
  expect(
    await resolveConnectionPrincipal({
      hubAuthRequired: true,
      hubAuth: auth,
      db: null,
      token: ''
    }),
    'empty string → null'
  ).toBeNull()
  expect(
    await resolveConnectionPrincipal({
      hubAuthRequired: true,
      hubAuth: auth,
      db: null,
      token: undefined
    }),
    'undefined → null'
  ).toBeNull()
  expect(
    await resolveConnectionPrincipal({
      hubAuthRequired: true,
      hubAuth: auth,
      db: null,
      token: null
    }),
    'null → null'
  ).toBeNull()
})

// ── auth OFF (the default local-loopback path) ──────────────────────────
test('auth OFF: even a VALID token yields null (inert — no verify, byte-identical)', async () => {
  const principal = await resolveConnectionPrincipal({
    hubAuthRequired: false,
    hubAuth: auth,
    db: null,
    token: validToken
  })
  expect(principal, 'gate off → null principal despite a valid token').toBeNull()
})

test('no hubAuth instance: null principal even when auth is nominally required', async () => {
  const principal = await resolveConnectionPrincipal({
    hubAuthRequired: true,
    hubAuth: null,
    db: null,
    token: validToken
  })
  expect(principal, 'missing hubAuth → null (fail-closed, no crash)').toBeNull()
})

// ── the szw_ scoped-session path — the tRPC twin of rest-auth.test.ts's ──
const scopedSession = await mintWebSession(db, {
  userId: created.id,
  scopes: ['read', 'tasks', 'agent']
})

test('a szw_ token resolves to its OWN scopes over connectionParams, never full', async () => {
  const principal = await resolveConnectionPrincipal({
    hubAuthRequired: true,
    hubAuth: auth,
    db,
    token: scopedSession.token
  })
  expect(principal, 'scoped session resolves').not.toBeNull()
  expect(principal!.userId, 'carries the owning userId').toBe(created.id)
  expect(principal!.scopes.join(','), 'carries its minted scopes').toBe('read,tasks,agent')
  expect(principal!.scopes, 'never full — this is the whole point').not.toContain('full')
})

// ── the web shell's cookie (T-13): its only credential on /trpc ─────────────
const cookies = { [WEB_SESSION_COOKIE_NAME]: scopedSession.token, other: 'x' }

test('cookie only, from the hub page: the socket authenticates as the web session', async () => {
  const presented = connectionToken({
    connectionParamsToken: undefined,
    cookies,
    cookieOriginAllowed: true
  })
  expect(presented.token, 'the cookie token is used').toBe(scopedSession.token)
  expect(presented.cookieRefused, 'not refused').toBe(false)
  const principal = await resolveConnectionPrincipal({
    hubAuthRequired: true,
    hubAuth: auth,
    db,
    token: presented.token
  })
  expect(principal?.userId, 'the session owner').toBe(created.id)
  expect(principal?.scopes.join(','), 'scoped, never full').toBe('read,tasks,agent')
})

test('cookie with a cross-origin or MISSING Origin: refused, no principal', async () => {
  const presented = connectionToken({
    connectionParamsToken: undefined,
    cookies,
    cookieOriginAllowed: false
  })
  expect(presented.token, 'cookie not used').toBeNull()
  expect(presented.cookieRefused, 'reported, so the hub audits it').toBe(true)
})

test('connectionParams wins over the cookie; a non-szw_ cookie is never read', async () => {
  expect(
    connectionToken({ connectionParamsToken: 'explicit', cookies, cookieOriginAllowed: false })
      .token,
    'a client-sent token needs no Origin (it is not ambient)'
  ).toBe('explicit')
  const fullInCookie = connectionToken({
    connectionParamsToken: undefined,
    cookies: { [WEB_SESSION_COOKIE_NAME]: validToken },
    cookieOriginAllowed: true
  })
  expect(fullInCookie.token, 'a better-auth token in the cookie slot resolves nothing').toBeNull()
  expect(fullInCookie.cookieRefused, 'and is not a web-session cookie at all').toBe(false)
  expect(
    connectionToken({ connectionParamsToken: '', cookies: {}, cookieOriginAllowed: true }).token,
    'nothing presented'
  ).toBeNull()
})

test('a szw_ token with no db available resolves to null, never throws', async () => {
  const principal = await resolveConnectionPrincipal({
    hubAuthRequired: true,
    hubAuth: auth,
    db: null,
    token: scopedSession.token
  })
  expect(principal, 'no db → null, fail-closed').toBeNull()
})

test('an unknown / revoked szw_ token resolves to null over connectionParams too', async () => {
  expect(
    await resolveConnectionPrincipal({
      hubAuthRequired: true,
      hubAuth: auth,
      db,
      token: 'szw_totally-made-up'
    }),
    'unknown szw_ token'
  ).toBeNull()
})

// ── account role + disabled account (T-08) ──────────────────────────────
const second = await createHubUser(auth, { email: 'second@example.com' })
if ('error' in second) throw new Error('created a second account')
const secondFull = await auth.api.signInEmail({
  body: { email: 'second@example.com', password: second.password }
})
const secondWeb = await mintWebSession(db, { userId: second.id, scopes: ['read'] })
const resolve = (token: string) =>
  resolveConnectionPrincipal({ hubAuthRequired: true, hubAuth: auth, db, token })
/** Flag the account directly, leaving every session row in place — the "a session
 *  exists for a disabled account anyway" case (`disableHubUser` would revoke). */
const setDisabled = (userId: string, disabled: boolean): void => {
  const authDb = new DatabaseSync(authDbPath)
  authDb
    .prepare('UPDATE user SET disabledAt = ? WHERE id = ?')
    .run(disabled ? new Date().toISOString() : null, userId)
  authDb.close()
}

test('the principal carries the account role, for both credential classes', async () => {
  expect((await resolve(validToken))?.role, 'first account, full session').toBe('admin')
  expect((await resolve(scopedSession.token))?.role, 'first account, web session').toBe('admin')
  expect((await resolve(secondFull.token))?.role, 'second account, full session').toBe('user')
  expect((await resolve(secondWeb.token))?.role, 'second account, web session').toBe('user')
})

test('a disabled account: its existing full and web sessions resolve to null', async () => {
  setDisabled(second.id, true)
  expect(await resolve(secondFull.token), 'full session refused').toBeNull()
  expect(await resolve(secondWeb.token), 'web session refused').toBeNull()
  expect((await resolve(validToken))?.userId, 'other accounts unaffected').toBe(created.id)
  // The refusal came from the flag: clearing it lets the same sessions through.
  setDisabled(second.id, false)
  expect((await resolve(secondFull.token))?.userId, 'full session again').toBe(second.id)
  expect((await resolve(secondWeb.token))?.userId, 'web session again').toBe(second.id)
})

test('a szw_ token with no hubAuth resolves to null — its account cannot be checked', async () => {
  const principal = await resolveConnectionPrincipal({
    hubAuthRequired: true,
    hubAuth: null,
    db,
    token: scopedSession.token
  })
  expect(principal, 'no hubAuth → null, fail-closed').toBeNull()
})

// ── the full server.ts wiring: token+windowId together ──────────────────
test('end-to-end: a client connect frame (windowId + bearer) produces windowId + principal', async () => {
  // Mirror server.ts createTrpcContext: parse the url for windowId and the
  // connectionParams for the token, both from one simulated connect.
  const reqUrl = '/trpc?windowId=3'
  const connectionParams: Record<string, string | undefined> = { token: validToken }
  const windowId = parseWindowIdFromUrl(reqUrl)
  const principal = await resolveConnectionPrincipal({
    hubAuthRequired: true,
    hubAuth: auth,
    db: null,
    token: connectionParams.token
  })
  expect(windowId, 'windowId flows through').toBe(3)
  expect(principal, 'principal attributed on the same connect').not.toBeNull()
  expect(principal?.userId.length, 'principal attributed on the same connect').toBeGreaterThan(0)
})
