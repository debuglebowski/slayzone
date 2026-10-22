import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import type { JoinToken } from '../shared/types'

/**
 * Single-use computer enrollment tokens.
 *
 * Token format: `szjt1.<base64url(JSON payload)>` where the payload embeds the
 * hub URL and a 256-bit random secret. The DB stores ONLY `sha256(token)` — the
 * plaintext token is returned once from `mintJoinToken` and can never be recovered
 * from the hub afterwards.
 *
 * There is no certificate pin: the hub never terminates TLS or presents a
 * certificate of its own (a front end does), and a computer verifies the front
 * end's certificate the normal way. A token minted by an OLDER hub also carries a
 * `certFingerprint` field; both decoders ignore it, so such a token (still unused in
 * `join_tokens` after an upgrade) redeems exactly like a new one.
 */

export const JOIN_TOKEN_PREFIX = 'szjt1'

/** Decoded contents of a join token — what an enrolling computer needs. */
export interface JoinTokenPayload {
  hubUrl: string
  /** 256-bit random secret (base64url). Makes the token unguessable. */
  secret: string
}

export interface MintJoinTokenInput {
  hubUrl: string
  ttlMs: number
  label: string
  /**
   * The user who minted this token, when the hub knows one.
   *
   * A token is the only thing that crosses from "a user clicked mint" to "a
   * machine enrolled", so it is the only place ownership can be carried without
   * asking the computer to assert an identity it cannot prove. Null on an
   * unauthenticated loopback hub — the normal local case — and an unowned computer
   * then stays honestly unowned.
   */
  mintedByUserId?: string | null
  /** Clock override for tests. */
  now?: number
}

export interface MintedJoinToken {
  /** join_tokens row id. */
  id: string
  /** Plaintext token — show once, never stored. */
  token: string
  label: string
  created_at: number
  expires_at: number
}

export type VerifyJoinTokenResult =
  | {
      ok: true
      tokenId: string
      label: string
      payload: JoinTokenPayload
      /** Carried to `computers.owner_user_id` at enroll. Null = unowned. */
      mintedByUserId: string | null
    }
  | { ok: false; reason: 'malformed' | 'unknown' | 'used' | 'expired' }

/** The at-rest form of a token: lowercase hex sha256 of the full token string. */
export function hashJoinToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Stateless decode of a token's embedded payload (no DB). Returns `null` for
 * anything that isn't a well-formed `szjt1.` token. Other fields — an older hub's
 * `certFingerprint` included — are ignored.
 */
export function decodeJoinToken(token: string): JoinTokenPayload | null {
  const dot = token.indexOf('.')
  if (dot === -1 || token.slice(0, dot) !== JOIN_TOKEN_PREFIX) return null
  const body = token.slice(dot + 1)
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const { hubUrl, secret } = parsed as Record<string, unknown>
    if (typeof hubUrl !== 'string' || typeof secret !== 'string') return null
    return { hubUrl, secret }
  } catch {
    return null
  }
}

/** Mint a token and persist ONLY its sha256 hash in `join_tokens`. */
export async function mintJoinToken(
  db: SlayzoneDb,
  input: MintJoinTokenInput
): Promise<MintedJoinToken> {
  const now = input.now ?? Date.now()
  const payload: JoinTokenPayload = {
    hubUrl: input.hubUrl,
    secret: randomBytes(32).toString('base64url')
  }
  const token = `${JOIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
  const id = randomUUID()
  const expiresAt = now + input.ttlMs
  await db.run(
    `INSERT INTO join_tokens
       (id, token_hash, label, created_at, expires_at, used_at, computer_id, minted_by_user_id)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [id, hashJoinToken(token), input.label, now, expiresAt, input.mintedByUserId ?? null]
  )
  // Every mint path (tRPC, REST, the desktop's loopback auto-enroll) lands here. The
  // id names the row, never the token; ip/route come from the request context.
  securityEvent({
    event: 'computer.join_token.mint',
    outcome: 'success',
    actor: input.mintedByUserId ?? undefined,
    targetKind: 'join_token',
    targetId: id,
    detail: { label: input.label, ttlMs: input.ttlMs }
  })
  return { id, token, label: input.label, created_at: now, expires_at: expiresAt }
}

/** Audit line for a redeem attempt (T-03): the row id when one matched, never the token. */
function auditRedeem(
  tokenId: string | null,
  result: { ok: true; mintedByUserId: string | null } | { ok: false; reason: string }
): void {
  securityEvent({
    event: 'computer.join_token.redeem',
    outcome: result.ok ? 'success' : 'failure',
    targetKind: 'join_token',
    targetId: tokenId,
    detail: result.ok ? { mintedBy: result.mintedByUserId } : { reason: result.reason }
  })
}

/**
 * Verify a presented token: hash lookup + expiry check + single-use claim
 * (stamps `used_at`). The `used_at IS NULL` guard in the UPDATE makes the
 * claim atomic — a concurrent verifier loses the race and gets `'used'`.
 */
export async function verifyJoinToken(
  db: SlayzoneDb,
  token: string,
  now: number = Date.now()
): Promise<VerifyJoinTokenResult> {
  const refuse = (
    reason: 'malformed' | 'unknown' | 'used' | 'expired',
    tokenId: string | null
  ): VerifyJoinTokenResult => {
    const result = { ok: false as const, reason }
    auditRedeem(tokenId, result)
    return result
  }
  const payload = decodeJoinToken(token)
  if (!payload) return refuse('malformed', null)

  const row = await db.get<JoinToken>(`SELECT * FROM join_tokens WHERE token_hash = ?`, [
    hashJoinToken(token)
  ])
  if (!row) return refuse('unknown', null)
  if (row.used_at !== null) return refuse('used', row.id)
  if (row.expires_at <= now) return refuse('expired', row.id)

  const res = await db.run(
    `UPDATE join_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
    [now, row.id, now]
  )
  if (res.changes === 0) return refuse('used', row.id)

  const result: VerifyJoinTokenResult = {
    ok: true,
    tokenId: row.id,
    label: row.label,
    payload,
    mintedByUserId: row.minted_by_user_id ?? null
  }
  auditRedeem(row.id, result)
  return result
}
