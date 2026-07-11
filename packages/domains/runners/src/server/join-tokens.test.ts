import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JOIN_TOKEN_PREFIX,
  decodeJoinToken,
  hashJoinToken,
  mintJoinToken,
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
    certFingerprint: 'sha256:ab:cd:ef',
    ttlMs: TTL,
    label: 'office-mac',
    now: NOW,
    ...over
  })
}

describe('mintJoinToken', () => {
  it('returns a szjt1 token whose payload embeds hub URL + cert fingerprint', async () => {
    const minted = await mint()
    expect(minted.token.startsWith(`${JOIN_TOKEN_PREFIX}.`)).toBe(true)

    const payload = decodeJoinToken(minted.token)
    expect(payload).not.toBeNull()
    expect(payload!.hubUrl).toBe('https://hub.example:8443')
    expect(payload!.certFingerprint).toBe('sha256:ab:cd:ef')
    expect(payload!.secret.length).toBeGreaterThanOrEqual(32)

    expect(minted.created_at).toBe(NOW)
    expect(minted.expires_at).toBe(NOW + TTL)
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
    expect(row.token_hash).toBe(
      createHash('sha256').update(minted.token, 'utf8').digest('hex')
    )
    expect(row.used_at).toBeNull()
    expect(row.runner_id).toBeNull()
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue
      expect(value === minted.token, `column ${key} must not hold the token`).toBe(false)
      expect(value.includes(secret), `column ${key} must not leak the secret`).toBe(false)
    }
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

    const row = t.raw
      .prepare(`SELECT used_at FROM join_tokens WHERE id = ?`)
      .get(minted.id) as { used_at: number | null }
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

    const row = t.raw
      .prepare(`SELECT used_at FROM join_tokens WHERE id = ?`)
      .get(minted.id) as { used_at: number | null }
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
      JSON.stringify({ hubUrl: 'https://x', certFingerprint: 'f', secret: 's' })
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
