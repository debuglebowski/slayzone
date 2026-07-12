import type { RunResult, SlayzoneDb } from '@slayzone/platform'
// The runner re-implements decodeJoinToken locally (no @slayzone/runners runtime
// dep — that would drag better-sqlite3 into the bundle). This test-only import of
// the HUB minter guards the two szjt1 codecs against silent drift.
import { mintJoinToken } from '@slayzone/runners/server'
import { describe, expect, it } from 'vitest'
import { decodeJoinToken, JOIN_TOKEN_PREFIX, type JoinTokenPayload } from './join-token'

/** Mint a token the same way the hub does (szjt1.<base64url(JSON)>). */
function encode(payload: JoinTokenPayload): string {
  return `${JOIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

/** Minimal fake DB — mintJoinToken only INSERTs the token hash (never reads back),
 *  so a run() that reports one changed row is enough to exercise the real minter. */
function fakeDb(): SlayzoneDb {
  const run = async (): Promise<RunResult> => ({ changes: 1, lastInsertRowid: 1 })
  return { run, get: async () => undefined, all: async () => [] } as unknown as SlayzoneDb
}

describe('decodeJoinToken', () => {
  it('round-trips a well-formed token', () => {
    const payload: JoinTokenPayload = {
      hubUrl: 'wss://hub.example:8443/fleet',
      certFingerprint: 'a'.repeat(64),
      secret: 'c2VjcmV0'
    }
    expect(decodeJoinToken(encode(payload))).toEqual(payload)
  })

  it('is byte-compatible with the hub minter payload shape', () => {
    // Exactly what @slayzone/runners/server mintJoinToken emits.
    const token = encode({
      hubUrl: 'wss://127.0.0.1:51099/fleet',
      certFingerprint: 'deadbeef'.repeat(8),
      secret: Buffer.from('x'.repeat(32)).toString('base64url')
    })
    const decoded = decodeJoinToken(token)
    expect(decoded?.hubUrl).toBe('wss://127.0.0.1:51099/fleet')
    expect(decoded?.certFingerprint).toBe('deadbeef'.repeat(8))
  })

  it.each([
    ['wrong prefix', 'szjt2.eyJ9'],
    ['no dot', 'szjt1eyJ9'],
    ['empty body', 'szjt1.'],
    ['not base64/json', 'szjt1.@@@@'],
    ['empty string', '']
  ])('returns null for %s', (_label, token) => {
    expect(decodeJoinToken(token)).toBeNull()
  })

  it('returns null when a required field is missing or wrong type', () => {
    const noUrl = `${JOIN_TOKEN_PREFIX}.${Buffer.from(
      JSON.stringify({ certFingerprint: 'a'.repeat(64), secret: 's' })
    ).toString('base64url')}`
    expect(decodeJoinToken(noUrl)).toBeNull()

    const numericUrl = `${JOIN_TOKEN_PREFIX}.${Buffer.from(
      JSON.stringify({ hubUrl: 123, certFingerprint: 'a'.repeat(64), secret: 's' })
    ).toString('base64url')}`
    expect(decodeJoinToken(numericUrl)).toBeNull()
  })

  it('returns null for a JSON array (not an object)', () => {
    const arr = `${JOIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(['x'])).toString('base64url')}`
    expect(decodeJoinToken(arr)).toBeNull()
  })

  it('decodes a token produced by the HUB minter (guards against codec drift)', async () => {
    // Feed the runner decoder the EXACT output of @slayzone/runners/server
    // mintJoinToken. If the hub ever changes the prefix or payload shape, this
    // fails here even though the local encode()-based tests above stay green.
    const minted = await mintJoinToken(fakeDb(), {
      hubUrl: 'wss://127.0.0.1:51099/fleet',
      certFingerprint: 'deadbeef'.repeat(8),
      ttlMs: 60_000,
      label: 'drift-guard'
    })
    const decoded = decodeJoinToken(minted.token)
    expect(decoded).not.toBeNull()
    expect(decoded?.hubUrl).toBe('wss://127.0.0.1:51099/fleet')
    expect(decoded?.certFingerprint).toBe('deadbeef'.repeat(8))
    // The minter injects a random 256-bit secret — decoded, non-empty, base64url.
    expect(typeof decoded?.secret).toBe('string')
    expect((decoded?.secret ?? '').length).toBeGreaterThan(0)
  })
})
