import { createHash } from 'node:crypto'
import { runWithSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_JOIN_TOKEN_TTL_MS,
  JOIN_TOKEN_PREFIX,
  JoinTokenTtlError,
  MAX_JOIN_TOKEN_TTL_MS,
  auditJoinTokenRedeemRefused,
  decodeJoinToken,
  hashJoinToken,
  isAllowedJoinTokenTtl,
  mintJoinToken,
  recordJoinTokenRedeemed,
  verifyJoinToken
} from './join-tokens'
import { createMigratedDb, type TestDb } from './test-db'

let t: TestDb

beforeEach(() => {
  t = createMigratedDb()
})

afterEach(() => {
  t.close()
})

const NOW = 1_700_000_000_000
const TTL = 60_000

function mint(over: Partial<Parameters<typeof mintJoinToken>[1]> = {}) {
  return mintJoinToken(t.db, {
    hubUrl: 'https://hub.example:8443',
    ttlMs: TTL,
    label: 'office-mac',
    now: NOW,
    ...over
  })
}

describe('mintJoinToken', () => {
  it('returns a szjt1 token whose payload embeds the hub URL + a secret, and no pin', async () => {
    const minted = await mint()
    expect(minted.token.startsWith(`${JOIN_TOKEN_PREFIX}.`)).toBe(true)

    const payload = decodeJoinToken(minted.token)
    expect(payload).not.toBeNull()
    expect(payload!.hubUrl).toBe('https://hub.example:8443')
    expect(payload!.secret.length).toBeGreaterThanOrEqual(32)
    // The wire shape itself: exactly these two fields, no certificate pin.
    const raw = JSON.parse(
      Buffer.from(minted.token.slice(JOIN_TOKEN_PREFIX.length + 1), 'base64url').toString('utf8')
    ) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['hubUrl', 'secret'])

    expect(minted.created_at).toBe(NOW)
    expect(minted.expires_at).toBe(NOW + TTL)
  })

  it('an unused token minted by an OLDER hub (carrying a certFingerprint pin) still redeems', async () => {
    // What an older hub minted and an upgrade leaves in join_tokens: the old payload
    // shape, stored the same way (sha256 of the whole token). The pin is ignored.
    const legacy = `${JOIN_TOKEN_PREFIX}.${Buffer.from(
      JSON.stringify({
        hubUrl: 'wss://hub.example/computers',
        certFingerprint: 'ab'.repeat(32),
        secret: 's'.repeat(43)
      })
    ).toString('base64url')}`
    t.raw
      .prepare(
        `INSERT INTO join_tokens
           (id, token_hash, label, created_at, expires_at, used_at, computer_id, minted_by_user_id)
         VALUES ('legacy-1', ?, 'old-hub', ?, ?, NULL, NULL, NULL)`
      )
      .run(hashJoinToken(legacy), NOW, NOW + TTL)

    expect(decodeJoinToken(legacy)).toEqual({
      hubUrl: 'wss://hub.example/computers',
      secret: 's'.repeat(43)
    })
    const verified = await verifyJoinToken(t.db, legacy, NOW + 1)
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.tokenId).toBe('legacy-1')
      expect(verified.payload).not.toHaveProperty('certFingerprint')
    }
  })

  it('mints unique tokens (fresh secret each time)', async () => {
    const a = await mint()
    const b = await mint({ label: 'second' })
    expect(a.token).not.toBe(b.token)
    expect(decodeJoinToken(a.token)!.secret).not.toBe(decodeJoinToken(b.token)!.secret)
  })

  it('stores ONLY the sha256 hash — no plaintext token or secret at rest', async () => {
    const minted = await mint()
    const secret = decodeJoinToken(minted.token)!.secret

    const row = t.raw.prepare(`SELECT * FROM join_tokens WHERE id = ?`).get(minted.id) as Record<
      string,
      unknown
    >
    expect(row.token_hash).toBe(createHash('sha256').update(minted.token, 'utf8').digest('hex'))
    expect(row.used_at).toBeNull()
    expect(row.computer_id).toBeNull()
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue
      expect(value === minted.token, `column ${key} must not hold the token`).toBe(false)
      expect(value.includes(secret), `column ${key} must not leak the secret`).toBe(false)
    }
  })
})

describe('lifetime cap (T-20)', () => {
  it('is 1 hour; the default (15 minutes) is under it', () => {
    expect(MAX_JOIN_TOKEN_TTL_MS).toBe(60 * 60_000)
    expect(DEFAULT_JOIN_TOKEN_TTL_MS).toBeLessThanOrEqual(MAX_JOIN_TOKEN_TTL_MS)
    expect(isAllowedJoinTokenTtl(MAX_JOIN_TOKEN_TTL_MS)).toBe(true)
    for (const bad of [MAX_JOIN_TOKEN_TTL_MS + 1, 2 * 60 * 60_000, 0, -1, 1.5, Number.NaN]) {
      expect(isAllowedJoinTokenTtl(bad), String(bad)).toBe(false)
    }
  })

  it('refuses to mint a longer token and writes nothing', async () => {
    await expect(mint({ ttlMs: 2 * 60 * 60_000 })).rejects.toBeInstanceOf(JoinTokenTtlError)
    await expect(mint({ ttlMs: 2 * 60 * 60_000 })).rejects.toMatchObject({
      code: 'JOIN_TOKEN_TTL_TOO_LONG'
    })
    expect(t.raw.prepare('SELECT COUNT(*) AS n FROM join_tokens').get()).toEqual({ n: 0 })
  })

  it('mints one of exactly 1 hour', async () => {
    const minted = await mint({ ttlMs: MAX_JOIN_TOKEN_TTL_MS })
    expect(minted.expires_at - minted.created_at).toBe(MAX_JOIN_TOKEN_TTL_MS)
  })
})

describe('owner (T-20)', () => {
  it('records who it is for apart from who minted it, and verify hands back the owner', async () => {
    const minted = await mint({ mintedByUserId: 'admin-1', ownerUserId: 'bob' })
    const row = t.raw
      .prepare('SELECT minted_by_user_id, owner_user_id FROM join_tokens WHERE id = ?')
      .get(minted.id)
    expect(row).toEqual({ minted_by_user_id: 'admin-1', owner_user_id: 'bob' })
    const verified = await verifyJoinToken(t.db, minted.token, NOW + 1)
    expect(verified.ok && verified.ownerUserId).toBe('bob')
  })

  it('a token for nobody (login off) verifies as unowned', async () => {
    const verified = await verifyJoinToken(t.db, (await mint()).token, NOW + 1)
    expect(verified.ok && verified.ownerUserId).toBeNull()
  })

  it('recordJoinTokenRedeemed records the computer the token enrolled', async () => {
    const minted = await mint({ ownerUserId: 'bob' })
    await recordJoinTokenRedeemed(t.db, {
      tokenId: minted.id,
      computerId: 'c-1',
      ownerUserId: 'bob'
    })
    expect(
      t.raw.prepare('SELECT computer_id FROM join_tokens WHERE id = ?').get(minted.id)
    ).toEqual({ computer_id: 'c-1' })
  })
})

describe('verifyJoinToken', () => {
  it('accepts a live token and stamps used_at (single-use claim)', async () => {
    const minted = await mint()
    const res = await verifyJoinToken(t.db, minted.token, NOW + 1)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.tokenId).toBe(minted.id)
      expect(res.label).toBe('office-mac')
      expect(res.payload.hubUrl).toBe('https://hub.example:8443')
    }

    const row = t.raw.prepare(`SELECT used_at FROM join_tokens WHERE id = ?`).get(minted.id) as {
      used_at: number | null
    }
    expect(row.used_at).toBe(NOW + 1)
  })

  it('rejects a second use', async () => {
    const minted = await mint()
    await verifyJoinToken(t.db, minted.token, NOW + 1)
    const res = await verifyJoinToken(t.db, minted.token, NOW + 2)
    expect(res).toEqual({ ok: false, reason: 'used' })
  })

  it('rejects an expired token and does NOT consume it', async () => {
    const minted = await mint()
    const res = await verifyJoinToken(t.db, minted.token, NOW + TTL)
    expect(res).toEqual({ ok: false, reason: 'expired' })

    const row = t.raw.prepare(`SELECT used_at FROM join_tokens WHERE id = ?`).get(minted.id) as {
      used_at: number | null
    }
    expect(row.used_at).toBeNull()
  })

  it('rejects malformed tokens', async () => {
    expect(await verifyJoinToken(t.db, 'garbage', NOW)).toEqual({
      ok: false,
      reason: 'malformed'
    })
    expect(await verifyJoinToken(t.db, 'szjt2.abc', NOW)).toEqual({
      ok: false,
      reason: 'malformed'
    })
    expect(
      await verifyJoinToken(
        t.db,
        `${JOIN_TOKEN_PREFIX}.${Buffer.from('{"hubUrl":1}').toString('base64url')}`,
        NOW
      )
    ).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a well-formed token that was never minted here', async () => {
    await mint()
    const foreign = `${JOIN_TOKEN_PREFIX}.${Buffer.from(
      JSON.stringify({ hubUrl: 'https://x', secret: 's' })
    ).toString('base64url')}`
    expect(await verifyJoinToken(t.db, foreign, NOW)).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('hashJoinToken / decodeJoinToken', () => {
  it('hash is deterministic lowercase hex sha256', () => {
    expect(hashJoinToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
  })

  it('decode returns null for junk', () => {
    expect(decodeJoinToken('')).toBeNull()
    expect(decodeJoinToken('szjt1.')).toBeNull()
    expect(decodeJoinToken('szjt1.!!!!')).toBeNull()
    expect(decodeJoinToken(`szjt1.${Buffer.from('[1,2]').toString('base64url')}`)).toBeNull()
  })
})

describe('audit (T-03)', () => {
  let audit: Array<Record<string, unknown>>
  beforeEach(() => {
    audit = []
    setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
  })
  afterEach(() => setSecurityLogSink())

  it('mint writes computer.join_token.mint with the minter and the owner, never the token', async () => {
    const minted = await runWithSecurityContext(
      { actor: 'ctx-user', ip: '203.0.113.5', route: 'trpc computers.mintJoinToken' },
      () => mint({ mintedByUserId: 'user-1', ownerUserId: 'bob' })
    )
    expect(audit).toEqual([
      expect.objectContaining({
        event: 'computer.join_token.mint',
        outcome: 'success',
        actor: 'user-1',
        ip: '203.0.113.5',
        targetKind: 'join_token',
        targetId: minted.id,
        detail: { ttlMs: TTL, label: 'office-mac', owner: 'bob' }
      })
    ])
    expect(JSON.stringify(audit)).not.toContain(minted.token)
    expect(JSON.stringify(audit)).not.toContain(decodeJoinToken(minted.token)!.secret)
  })

  it('redeem writes computer.join_token.redeem: success once (with the computer), then failure with the reason', async () => {
    const minted = await mint({ mintedByUserId: 'user-1', ownerUserId: 'bob' })
    audit.length = 0
    const verified = await verifyJoinToken(t.db, minted.token, NOW + 1)
    // The claim alone writes nothing: the success line waits for the computer.
    expect(audit).toEqual([])
    await runWithSecurityContext({ actor: null, ip: '198.51.100.7', route: 'WS /computers' }, () =>
      recordJoinTokenRedeemed(t.db, {
        tokenId: verified.ok ? verified.tokenId : '',
        computerId: 'c-1',
        ownerUserId: 'bob'
      })
    )
    await verifyJoinToken(t.db, minted.token, NOW + 2)
    await verifyJoinToken(t.db, 'szjt1.garbage', NOW + 3)
    auditJoinTokenRedeemRefused(minted.id, 'owner_disabled', 'denied')
    expect(audit).toEqual([
      expect.objectContaining({
        event: 'computer.join_token.redeem',
        outcome: 'success',
        ip: '198.51.100.7',
        targetId: minted.id,
        detail: { computerId: 'c-1', owner: 'bob' }
      }),
      expect.objectContaining({
        event: 'computer.join_token.redeem',
        outcome: 'failure',
        targetId: minted.id,
        detail: expect.objectContaining({ reason: 'used' })
      }),
      expect.objectContaining({
        event: 'computer.join_token.redeem',
        outcome: 'failure',
        targetId: null,
        detail: expect.objectContaining({ reason: 'malformed' })
      }),
      expect.objectContaining({
        event: 'computer.join_token.redeem',
        outcome: 'denied',
        targetId: minted.id,
        detail: { reason: 'owner_disabled' }
      })
    ])
    expect(JSON.stringify(audit)).not.toContain(minted.token)
  })
})
