import { describe, expect, it } from 'vitest'
import {
  TASK_TOKEN_PREFIX,
  mintTaskToken,
  verifyTaskToken,
  type TaskTokenClaims
} from './task-tokens'

const SECRET = 'hub-runner-secret-at-least-32-chars-long!!'
const NOW = 1_700_000_000_000
const TTL = 5 * 60_000

function mint(over: Partial<Parameters<typeof mintTaskToken>[1]> = {}): string {
  return mintTaskToken(SECRET, {
    taskId: 'task-abc',
    runnerId: 'runner-1',
    ttlMs: TTL,
    now: NOW,
    ...over
  })
}

describe('mintTaskToken', () => {
  it('returns a three-part sztt1 token', () => {
    const token = mint()
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe(TASK_TOKEN_PREFIX)
    expect(parts[1].length).toBeGreaterThan(0)
    expect(parts[2].length).toBeGreaterThan(0)
  })

  it('embeds the scoped claims (taskId, runnerId, iat, exp)', () => {
    const token = mint()
    const result = verifyTaskToken(SECRET, token, NOW)
    expect(result.ok).toBe(true)
    const claims = (result as { ok: true; claims: TaskTokenClaims }).claims
    expect(claims.taskId).toBe('task-abc')
    expect(claims.runnerId).toBe('runner-1')
    expect(claims.iat).toBe(NOW)
    expect(claims.exp).toBe(NOW + TTL)
  })
})

describe('verifyTaskToken', () => {
  it('accepts a fresh token before expiry', () => {
    const token = mint()
    const result = verifyTaskToken(SECRET, token, NOW + TTL - 1)
    expect(result.ok).toBe(true)
  })

  it('rejects an expired token (exp is exclusive)', () => {
    const token = mint()
    expect(verifyTaskToken(SECRET, token, NOW + TTL)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyTaskToken(SECRET, token, NOW + TTL + 1)).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a token signed with a different secret', () => {
    const token = mintTaskToken('a-totally-different-secret-value-here!!', {
      taskId: 'task-abc',
      runnerId: 'runner-1',
      ttlMs: TTL,
      now: NOW
    })
    expect(verifyTaskToken(SECRET, token, NOW)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects a token whose claims were tampered with', () => {
    const token = mint()
    const [prefix, , sig] = token.split('.')
    const forgedBody = Buffer.from(
      JSON.stringify({ taskId: 'other-task', runnerId: 'runner-1', iat: NOW, exp: NOW + TTL }),
      'utf8'
    ).toString('base64url')
    const forged = `${prefix}.${forgedBody}.${sig}`
    expect(verifyTaskToken(SECRET, forged, NOW)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects malformed tokens', () => {
    expect(verifyTaskToken(SECRET, 'not-a-token', NOW).ok).toBe(false)
    expect(verifyTaskToken(SECRET, 'not-a-token', NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyTaskToken(SECRET, 'wrongprefix.body.sig', NOW)).toEqual({
      ok: false,
      reason: 'malformed'
    })
    expect(verifyTaskToken(SECRET, `${TASK_TOKEN_PREFIX}.only-two-parts`, NOW)).toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('round-trips distinct scopes without collision', () => {
    const a = verifyTaskToken(SECRET, mint({ taskId: 't1', runnerId: 'rA' }), NOW)
    const b = verifyTaskToken(SECRET, mint({ taskId: 't2', runnerId: 'rB' }), NOW)
    expect(a.ok && b.ok).toBe(true)
    const ac = (a as { ok: true; claims: TaskTokenClaims }).claims
    const bc = (b as { ok: true; claims: TaskTokenClaims }).claims
    expect(ac.taskId).toBe('t1')
    expect(ac.runnerId).toBe('rA')
    expect(bc.taskId).toBe('t2')
    expect(bc.runnerId).toBe('rB')
  })
})
