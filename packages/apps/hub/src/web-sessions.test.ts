/**
 * Scoped browser sessions — mint / verify / revoke, over a real migrated
 * SlayzoneDb (the harness's better-sqlite3-backed worker thread).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/web-sessions.test.ts
 */
import { afterAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import {
  mintWebSession,
  verifyWebSessionToken,
  revokeWebSession,
  revokeAllWebSessions,
  listWebSessions,
  isWebSessionToken,
  hashWebSessionToken,
  WEB_SESSION_TOKEN_PREFIX,
  WEB_SESSION_IDLE_MS,
  WEB_SESSION_ABSOLUTE_MS,
  SSO_WEB_SESSION_LIFETIME,
  DEFAULT_WEB_SESSION_LIFETIME,
  hasLiveWebSession,
  webSessionLifetimeFor,
  webSessionCookie,
  clearWebSessionCookie,
  webSessionCookieSecure,
  mintBrowserWebSession,
  revokeWebSessionToken,
  WEB_SESSION_COOKIE_NAME
} from './web-sessions.js'

const h = await createTestHarness()

describe('mintWebSession / verifyWebSessionToken', () => {
  test('mints a szw_ token that verifies to the same userId + scopes', async () => {
    const minted = await mintWebSession(h.slayDb, { userId: 'u1', scopes: ['read', 'tasks'] })
    expect(minted.token.startsWith(WEB_SESSION_TOKEN_PREFIX)).toBe(true)
    expect(isWebSessionToken(minted.token)).toBe(true)

    const result = await verifyWebSessionToken(h.slayDb, minted.token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.userId).toBe('u1')
      expect(result.scopes).toEqual(['read', 'tasks'])
    }
  })

  test('the plaintext token is never recoverable from the stored row', async () => {
    const minted = await mintWebSession(h.slayDb, { userId: 'u2', scopes: ['agent'] })
    const row = await h.slayDb.get<{ token_hash: string }>(
      `SELECT token_hash FROM web_sessions WHERE id = ?`,
      [minted.id]
    )
    expect(row?.token_hash).toBe(hashWebSessionToken(minted.token))
    expect(row?.token_hash).not.toBe(minted.token)
  })

  test('an unknown token fails closed with reason unknown', async () => {
    const result = await verifyWebSessionToken(h.slayDb, `${WEB_SESSION_TOKEN_PREFIX}bogus`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unknown')
  })

  test('a token past its own expires_at fails closed with reason expired', async () => {
    const now = 1_000_000
    const minted = await mintWebSession(h.slayDb, { userId: 'u3', scopes: ['read'], now })
    const result = await verifyWebSessionToken(
      h.slayDb,
      minted.token,
      now + WEB_SESSION_IDLE_MS + 1
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('expired')
  })

  test('a revoked token fails closed with reason revoked, even before its natural expiry', async () => {
    const minted = await mintWebSession(h.slayDb, { userId: 'u4', scopes: ['read'] })
    expect(await revokeWebSession(h.slayDb, minted.id)).toBe(true)
    const result = await verifyWebSessionToken(h.slayDb, minted.token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('revoked')
  })

  test('revoking an unknown / already-revoked id returns false', async () => {
    expect(await revokeWebSession(h.slayDb, 'no-such-id')).toBe(false)
    const minted = await mintWebSession(h.slayDb, { userId: 'u5', scopes: ['read'] })
    expect(await revokeWebSession(h.slayDb, minted.id)).toBe(true)
    expect(await revokeWebSession(h.slayDb, minted.id)).toBe(false) // already revoked
  })
})

describe('idle refresh, capped at the absolute ceiling', () => {
  test('a use within the idle window slides expires_at forward', async () => {
    const created = 10_000_000
    const minted = await mintWebSession(h.slayDb, { userId: 'u6', scopes: ['read'], now: created })
    const originalExpiry = created + WEB_SESSION_IDLE_MS

    // Used partway through the idle window — expiry should slide forward from
    // THIS use, not stay pinned to the original mint time.
    const usedAt = created + WEB_SESSION_IDLE_MS / 2
    await verifyWebSessionToken(h.slayDb, minted.token, usedAt)

    const row = await h.slayDb.get<{ expires_at: number }>(
      `SELECT expires_at FROM web_sessions WHERE id = ?`,
      [minted.id]
    )
    expect(row!.expires_at).toBeGreaterThan(originalExpiry)
    expect(row!.expires_at).toBe(usedAt + WEB_SESSION_IDLE_MS)
  })

  test('refresh never extends past the ABSOLUTE ceiling from original creation', async () => {
    const created = 10_000_000
    const minted = await mintWebSession(h.slayDb, { userId: 'u7', scopes: ['read'], now: created })
    const absoluteCeiling = created + WEB_SESSION_ABSOLUTE_MS

    // A continuously-used session, re-verified every 6 days (inside the 7-day
    // idle window each time, so it never idle-expires) — 4 steps lands one step
    // BEFORE the naive slide would cross the 30-day ceiling (created+24d, whose
    // naive next expiry of +31d exceeds it), so this is exactly where the cap
    // is exercised. Naive sliding would keep pushing expires_at forward by
    // WEB_SESSION_IDLE_MS on every use, extending the session forever — the
    // ceiling must cap it instead.
    const sixDaysMs = 6 * 24 * 60 * 60 * 1000
    let usedAt = created
    for (let i = 0; i < 4; i++) {
      usedAt += sixDaysMs
      const result = await verifyWebSessionToken(h.slayDb, minted.token, usedAt)
      expect(result.ok).toBe(true) // never idle-expires across this sequence
    }

    const row = await h.slayDb.get<{ expires_at: number }>(
      `SELECT expires_at FROM web_sessions WHERE id = ?`,
      [minted.id]
    )
    // usedAt + WEB_SESSION_IDLE_MS at this last step is created+31d — past the
    // 30-day ceiling — so the stored value must be the CAPPED ceiling, not that.
    expect(row!.expires_at).toBe(absoluteCeiling)
  })
})

describe('lifetime on a hub with Entra sign-in (O-8, T-12): 7 days absolute', () => {
  const DAY = 24 * 60 * 60 * 1000
  const sso = SSO_WEB_SESSION_LIFETIME

  test('the lifetimes: SSO 7 days absolute; every other hub unchanged (7 idle / 30)', () => {
    expect(sso).toEqual({ idleMs: 7 * DAY, absoluteMs: 7 * DAY })
    expect(DEFAULT_WEB_SESSION_LIFETIME).toEqual({ idleMs: 7 * DAY, absoluteMs: 30 * DAY })
    expect(webSessionLifetimeFor(null)).toBe(DEFAULT_WEB_SESSION_LIFETIME)
  })

  test('use does not extend it, and it ends exactly 7 days after minting', async () => {
    const created = 50_000_000
    const minted = await mintWebSession(h.slayDb, {
      userId: 'u-sso',
      scopes: ['read'],
      lifetime: sso,
      now: created
    })
    expect(minted.expiresAt).toBe(created + 7 * DAY)
    expect((await verifyWebSessionToken(h.slayDb, minted.token, created + 6 * DAY, sso)).ok).toBe(
      true
    )
    const row = await h.slayDb.get<{ expires_at: number }>(
      `SELECT expires_at FROM web_sessions WHERE id = ?`,
      [minted.id]
    )
    expect(row!.expires_at).toBe(created + 7 * DAY) // not slid
    const late = await verifyWebSessionToken(h.slayDb, minted.token, created + 7 * DAY, sso)
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.reason).toBe('expired')
  })

  test('a row minted under the 30-day ceiling ends at 7 days once the hub has Entra sign-in', async () => {
    const created = 60_000_000
    const minted = await mintWebSession(h.slayDb, {
      userId: 'u-old',
      scopes: ['read'],
      now: created
    })
    // Kept alive by use under the old lifetime...
    expect((await verifyWebSessionToken(h.slayDb, minted.token, created + 6 * DAY)).ok).toBe(true)
    // ...but past 7 days from minting it no longer verifies under the SSO one.
    const result = await verifyWebSessionToken(h.slayDb, minted.token, created + 8 * DAY, sso)
    expect(result.ok).toBe(false)
  })

  test('hasLiveWebSession: unrevoked, unexpired, within the absolute limit', async () => {
    const now = 70_000_000
    await mintWebSession(h.slayDb, { userId: 'u-live', scopes: ['read'], lifetime: sso, now })
    expect(await hasLiveWebSession(h.slayDb, 'u-live', sso, now + DAY)).toBe(true)
    expect(await hasLiveWebSession(h.slayDb, 'u-live', sso, now + 7 * DAY)).toBe(false)
    expect(await hasLiveWebSession(h.slayDb, 'u-nobody', sso, now)).toBe(false)
    await revokeAllWebSessions(h.slayDb, 'u-live')
    expect(await hasLiveWebSession(h.slayDb, 'u-live', sso, now + DAY)).toBe(false)
  })
})

describe('listWebSessions / revokeAllWebSessions', () => {
  test('lists only live (unrevoked) sessions for a user, newest first', async () => {
    const a = await mintWebSession(h.slayDb, { userId: 'u8', scopes: ['read'], now: 1000 })
    const b = await mintWebSession(h.slayDb, { userId: 'u8', scopes: ['read'], now: 2000 })
    await revokeWebSession(h.slayDb, a.id)

    const sessions = await listWebSessions(h.slayDb, 'u8')
    expect(sessions.map((s) => s.id)).toEqual([b.id])
  })

  test('revokeAllWebSessions ends every live session for that user, no others', async () => {
    await mintWebSession(h.slayDb, { userId: 'u9', scopes: ['read'] })
    await mintWebSession(h.slayDb, { userId: 'u9', scopes: ['read'] })
    const other = await mintWebSession(h.slayDb, { userId: 'u10', scopes: ['read'] })

    const revokedCount = await revokeAllWebSessions(h.slayDb, 'u9')
    expect(revokedCount).toBe(2)
    expect(await listWebSessions(h.slayDb, 'u9')).toEqual([])
    expect((await verifyWebSessionToken(h.slayDb, other.token)).ok).toBe(true) // untouched
  })
})

describe('audit (T-03)', () => {
  test('mint, revoke and revoke-all write auth.web_session lines, never the token', async () => {
    const audit: Array<Record<string, unknown>> = []
    setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
    try {
      const minted = await mintWebSession(h.slayDb, { userId: 'u-audit', scopes: ['read'] })
      await revokeWebSession(h.slayDb, minted.id)
      await revokeWebSession(h.slayDb, minted.id) // already revoked: nothing happened
      await mintWebSession(h.slayDb, { userId: 'u-audit', scopes: ['read'] })
      await revokeAllWebSessions(h.slayDb, 'u-audit')
      expect(audit.map((l) => [l.event, l.outcome])).toEqual([
        ['auth.web_session.create', 'success'],
        ['auth.web_session.revoke', 'success'],
        ['auth.web_session.revoke', 'failure'],
        ['auth.web_session.create', 'success'],
        ['auth.web_session.revoke', 'success']
      ])
      const pick = (l: Record<string, unknown>) => ({
        actor: l.actor,
        targetKind: l.targetKind,
        targetId: l.targetId,
        detail: l.detail
      })
      expect(pick(audit[0]!)).toEqual({
        actor: 'u-audit',
        targetKind: 'web_session',
        targetId: minted.id,
        detail: { scopes: ['read'] }
      })
      expect(pick(audit[4]!)).toEqual({
        actor: null,
        targetKind: 'user',
        targetId: 'u-audit',
        detail: { count: 1 }
      })
      expect(JSON.stringify(audit)).not.toContain(minted.token)
    } finally {
      setSecurityLogSink()
    }
  })
})

describe('the browser cookie (T-13)', () => {
  test('Secure exactly when the public address is https: set and not loopback', () => {
    expect(webSessionCookieSecure('hub.normain.com')).toBe(true)
    expect(webSessionCookieSecure('hub.normain.com:8443')).toBe(true)
    expect(webSessionCookieSecure('10.0.0.5:8765')).toBe(true)
    expect(webSessionCookieSecure(undefined)).toBe(false)
    expect(webSessionCookieSecure('127.0.0.1:8765')).toBe(false)
    expect(webSessionCookieSecure('localhost:8765')).toBe(false)
    expect(webSessionCookieSecure('[::1]:8765')).toBe(false)
  })

  test('HttpOnly, SameSite=Lax, Path=/, Max-Age; Secure only when asked', () => {
    const https = webSessionCookie('szw_t', { secure: true, maxAgeSec: 604800 })
    expect(https).toBe(
      `${WEB_SESSION_COOKIE_NAME}=szw_t; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800`
    )
    const loopback = webSessionCookie('szw_t', { secure: false, maxAgeSec: 60 })
    expect(loopback).toBe(
      `${WEB_SESSION_COOKIE_NAME}=szw_t; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`
    )
    expect(clearWebSessionCookie({ secure: true })).toBe(
      `${WEB_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`
    )
    expect(clearWebSessionCookie({ secure: false })).toBe(
      `${WEB_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    )
  })

  test('mintBrowserWebSession: scoped row + its cookie, lifetime as Max-Age (https vs loopback)', async () => {
    const https = await mintBrowserWebSession(null, h.slayDb, 'u-cookie', { secure: true })
    expect(https.setCookie).toBe(
      webSessionCookie(https.token, { secure: true, maxAgeSec: WEB_SESSION_IDLE_MS / 1000 })
    )
    const verified = await verifyWebSessionToken(h.slayDb, https.token)
    expect(verified.ok && verified.scopes).toEqual(['read', 'tasks', 'agent'])
    const loopback = await mintBrowserWebSession(null, h.slayDb, 'u-cookie', { secure: false })
    expect(loopback.setCookie.includes('Secure')).toBe(false)
    expect(loopback.setCookie).toContain('HttpOnly')
  })

  test('mintBrowserWebSession revokes the session the browser cookie still names', async () => {
    const first = await mintBrowserWebSession(null, h.slayDb, 'u-replace', { secure: false })
    const second = await mintBrowserWebSession(null, h.slayDb, 'u-replace', {
      secure: false,
      replacing: first.token
    })
    expect((await verifyWebSessionToken(h.slayDb, first.token)).ok).toBe(false)
    expect((await verifyWebSessionToken(h.slayDb, second.token)).ok).toBe(true)
  })

  test('revokeWebSessionToken: revokes as the token user, null when nothing is live', async () => {
    const audit: Array<Record<string, unknown>> = []
    setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
    try {
      const minted = await mintWebSession(h.slayDb, { userId: 'u-out', scopes: ['read'] })
      expect(await revokeWebSessionToken(h.slayDb, minted.token)).toEqual({
        id: minted.id,
        userId: 'u-out'
      })
      expect(await revokeWebSessionToken(h.slayDb, minted.token)).toBe(null)
      expect(await revokeWebSessionToken(h.slayDb, 'szw_unknown')).toBe(null)
      const revoke = audit.filter((l) => l.event === 'auth.web_session.revoke')
      expect(revoke.length).toBe(1)
      expect(revoke[0]!.actor).toBe('u-out')
      expect(revoke[0]!.outcome).toBe('success')
    } finally {
      setSecurityLogSink()
    }
  })
})

describe('isWebSessionToken', () => {
  test('recognizes the prefix without a DB round trip', () => {
    expect(isWebSessionToken('szw_abc123')).toBe(true)
    expect(isWebSessionToken('szw_')).toBe(false) // prefix alone, no body
    expect(isWebSessionToken('some-better-auth-bearer')).toBe(false)
    expect(isWebSessionToken('')).toBe(false)
  })
})

afterAll(() => h.cleanup())
