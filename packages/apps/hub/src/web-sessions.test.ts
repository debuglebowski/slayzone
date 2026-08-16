/**
 * Scoped browser sessions — mint / verify / revoke, over a real migrated
 * SlayzoneDb (the harness's better-sqlite3-backed worker thread).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/web-sessions.test.ts
 */
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../shared/test-utils/ipc-harness.js'
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
  WEB_SESSION_ABSOLUTE_MS
} from './web-sessions.js'

const h = await createTestHarness()

await describe('mintWebSession / verifyWebSessionToken', () => {
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

await describe('idle refresh, capped at the absolute ceiling', () => {
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

await describe('listWebSessions / revokeAllWebSessions', () => {
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

await describe('isWebSessionToken', () => {
  test('recognizes the prefix without a DB round trip', () => {
    expect(isWebSessionToken('szw_abc123')).toBe(true)
    expect(isWebSessionToken('szw_')).toBe(false) // prefix alone, no body
    expect(isWebSessionToken('some-better-auth-bearer')).toBe(false)
    expect(isWebSessionToken('')).toBe(false)
  })
})

h.cleanup()
