import type { RunResult, SlayzoneDb } from '@slayzone/platform'
// The decoder under test lives on the lean `@slayzone/platform/join-token` subpath —
// no @slayzone/computers RUNTIME dep, which would drag better-sqlite3 into both the
// computer and CLI bundles. This test-only import of the HUB minter is what guards the
// two szjt1 codecs against silent drift, and it stays HERE (not in platform) because
// @slayzone/computers already depends on @slayzone/platform — devDep'ing it back would
// close a cycle.
import { mintJoinToken } from '@slayzone/computers/server'
import { describe, expect, it } from 'vitest'
import {
  decodeJoinToken,
  JOIN_TOKEN_PREFIX,
  joinTokenCarriesCertPin
} from '@slayzone/platform/join-token'

/** Mint a token the same way the hub does (szjt1.<base64url(JSON)>). */
function encode(payload: Record<string, unknown>): string {
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
    const payload = { hubUrl: 'wss://hub.example:8443/computers', secret: 'c2VjcmV0' }
    expect(decodeJoinToken(encode(payload))).toEqual(payload)
  })

  it('decodes a token minted by an OLDER hub, ignoring its certificate pin', () => {
    // The pre-removal shape: an older hub embedded a pin of its own self-signed
    // certificate. It still decodes; the pin is dropped, never surfaced.
    const token = encode({
      hubUrl: 'wss://127.0.0.1:51099/computers',
      certFingerprint: 'deadbeef'.repeat(8),
      secret: Buffer.from('x'.repeat(32)).toString('base64url')
    })
    expect(decodeJoinToken(token)).toEqual({
      hubUrl: 'wss://127.0.0.1:51099/computers',
      secret: Buffer.from('x'.repeat(32)).toString('base64url')
    })
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
    const noUrl = `${JOIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify({ secret: 's' })).toString(
      'base64url'
    )}`
    expect(decodeJoinToken(noUrl)).toBeNull()

    const numericUrl = `${JOIN_TOKEN_PREFIX}.${Buffer.from(
      JSON.stringify({ hubUrl: 123, secret: 's' })
    ).toString('base64url')}`
    expect(decodeJoinToken(numericUrl)).toBeNull()
  })

  it('returns null for a JSON array (not an object)', () => {
    const arr = `${JOIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(['x'])).toString('base64url')}`
    expect(decodeJoinToken(arr)).toBeNull()
  })

  it('decodes a token produced by the HUB minter (guards against codec drift)', async () => {
    // Feed the computer decoder the EXACT output of @slayzone/computers/server
    // mintJoinToken. If the hub ever changes the prefix or payload shape, this
    // fails here even though the local encode()-based tests above stay green.
    const minted = await mintJoinToken(fakeDb(), {
      hubUrl: 'wss://127.0.0.1:51099/computers',
      ttlMs: 60_000,
      label: 'drift-guard'
    })
    const decoded = decodeJoinToken(minted.token)
    expect(decoded).not.toBeNull()
    expect(decoded?.hubUrl).toBe('wss://127.0.0.1:51099/computers')
    expect(joinTokenCarriesCertPin(minted.token)).toBe(false)
    // The minter injects a random 256-bit secret — decoded, non-empty, base64url.
    expect(typeof decoded?.secret).toBe('string')
    expect((decoded?.secret ?? '').length).toBeGreaterThan(0)
  })
})

describe('joinTokenCarriesCertPin', () => {
  it('is true only for a well-formed token that still carries a non-empty pin', () => {
    const base = { hubUrl: 'wss://hub.example/computers', secret: 's' }
    expect(joinTokenCarriesCertPin(encode({ ...base, certFingerprint: 'ab'.repeat(32) }))).toBe(
      true
    )
    // The interim shape (pin field present but empty) and the current one carry no pin.
    expect(joinTokenCarriesCertPin(encode({ ...base, certFingerprint: '' }))).toBe(false)
    expect(joinTokenCarriesCertPin(encode(base))).toBe(false)
    // A token that does not decode is never reported as pinned.
    expect(joinTokenCarriesCertPin(encode({ certFingerprint: 'ab'.repeat(32) }))).toBe(false)
    expect(joinTokenCarriesCertPin('garbage')).toBe(false)
  })
})
