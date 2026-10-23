import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { JOIN_TOKEN_MAX_TTL_MS } from '@slayzone/platform/join-token'
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

/** Lifetime of a join token when the caller names none: 15 minutes. */
export const DEFAULT_JOIN_TOKEN_TTL_MS = 15 * 60_000

/**
 * The longest a join token may live: 1 hour (O-5, T-20). It is a bearer secret
 * that enrolls a machine into a user's account, handed over by chat or mail, so
 * its exposure window stays short; a longer `ttlMs` is refused, never clipped,
 * so a caller asking for a day learns it did not get one. Defined on the lean
 * platform subpath so the CLI checks the same number.
 */
export const MAX_JOIN_TOKEN_TTL_MS = JOIN_TOKEN_MAX_TTL_MS

/** Stable code of a mint refused for its lifetime ({@link MAX_JOIN_TOKEN_TTL_MS}). */
export const JOIN_TOKEN_TTL_TOO_LONG = 'JOIN_TOKEN_TTL_TOO_LONG'

/** A positive whole number of ms, at most {@link MAX_JOIN_TOKEN_TTL_MS}. */
export function isAllowedJoinTokenTtl(ttlMs: number): boolean {
  return Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= MAX_JOIN_TOKEN_TTL_MS
}

/** Thrown by {@link mintJoinToken} for a lifetime {@link isAllowedJoinTokenTtl} refuses. */
export class JoinTokenTtlError extends Error {
  readonly code = JOIN_TOKEN_TTL_TOO_LONG
  constructor(readonly ttlMs: number) {
    super(
      `a join token lives at most ${MAX_JOIN_TOKEN_TTL_MS / 60_000} minutes; ` +
        `ttlMs ${ttlMs} is refused`
    )
    this.name = 'JoinTokenTtlError'
  }
}

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
   * The user who minted this token, when the hub knows one: the audit line's actor,
   * kept on the row for the record. NOT the owner (T-20): on a hub with login an
   * admin mints for someone else.
   */
  mintedByUserId?: string | null
  /**
   * The user the token is FOR: the computer that redeems it belongs to them,
   * whoever redeems it (T-20).
   *
   * A token is the only thing that crosses from "an admin minted it" to "a machine
   * enrolled", so it is the only place ownership can be carried without asking the
   * computer to assert an identity it cannot prove. Null on a hub without login —
   * the desktop app's — where an unowned computer stays honestly unowned. The
   * caller has checked that the account exists and is enabled; enrollment checks
   * again.
   */
  ownerUserId?: string | null
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
      ownerUserId: string | null
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

/**
 * Mint a token and persist ONLY its sha256 hash in `join_tokens`.
 *
 * Throws {@link JoinTokenTtlError} for a lifetime over the cap: the backstop for every
 * mint path. The tRPC and REST callers check first (`join-token-policy.ts` in
 * transport), so a refusal there is a stable code and an audit line, not a throw.
 */
export async function mintJoinToken(
  db: SlayzoneDb,
  input: MintJoinTokenInput
): Promise<MintedJoinToken> {
  if (!isAllowedJoinTokenTtl(input.ttlMs)) throw new JoinTokenTtlError(input.ttlMs)
  const now = input.now ?? Date.now()
  const payload: JoinTokenPayload = {
    hubUrl: input.hubUrl,
    secret: randomBytes(32).toString('base64url')
  }
  const token = `${JOIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
  const id = randomUUID()
  const expiresAt = now + input.ttlMs
  const ownerUserId = input.ownerUserId ?? null
  await db.run(
    `INSERT INTO join_tokens
       (id, token_hash, label, created_at, expires_at, used_at, computer_id, minted_by_user_id,
        owner_user_id)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      id,
      hashJoinToken(token),
      input.label,
      now,
      expiresAt,
      input.mintedByUserId ?? null,
      ownerUserId
    ]
  )
  // Every mint path (tRPC, REST, the desktop's loopback auto-enroll) lands here. The
  // row id names the token (it is random, not derived from the secret, and it is what
  // the redeem line carries too); the token itself never appears. ip/route come from
  // the request context.
  securityEvent({
    event: 'computer.join_token.mint',
    outcome: 'success',
    actor: input.mintedByUserId ?? undefined,
    targetKind: 'join_token',
    targetId: id,
    detail: { label: input.label, ttlMs: input.ttlMs, owner: ownerUserId }
  })
  return { id, token, label: input.label, created_at: now, expires_at: expiresAt }
}

/**
 * Audit line for a redeem that did not complete (T-03): the row id when one matched,
 * never the token. `failure` for a token that is not redeemable (`malformed`,
 * `unknown`, `used`, `expired`), `denied` for one refused by policy after the claim
 * (the owner's account is disabled). The client address comes from the socket's
 * context (hub-gateway.ts, T-22).
 */
export function auditJoinTokenRedeemRefused(
  tokenId: string | null,
  reason: string,
  outcome: 'failure' | 'denied' = 'failure'
): void {
  securityEvent({
    event: 'computer.join_token.redeem',
    outcome,
    targetKind: 'join_token',
    targetId: tokenId,
    detail: { reason }
  })
}

/**
 * Finish a redeem once its computer exists: record which computer the token enrolled
 * (`join_tokens.computer_id`) and write the one success line — the computer, its
 * owner and, from the socket's context, the client address.
 */
export async function recordJoinTokenRedeemed(
  db: SlayzoneDb,
  input: { tokenId: string; computerId: string; ownerUserId: string | null }
): Promise<void> {
  await db.run(`UPDATE join_tokens SET computer_id = ? WHERE id = ?`, [
    input.computerId,
    input.tokenId
  ])
  securityEvent({
    event: 'computer.join_token.redeem',
    outcome: 'success',
    targetKind: 'join_token',
    targetId: input.tokenId,
    detail: { computerId: input.computerId, owner: input.ownerUserId }
  })
}

/**
 * Verify a presented token: hash lookup + expiry check + single-use claim
 * (stamps `used_at`). The `used_at IS NULL` guard in the UPDATE makes the
 * claim atomic — a concurrent verifier loses the race and gets `'used'`.
 *
 * Audits a refusal itself. A success is the caller's to audit, once the computer it
 * enrolls exists: {@link recordJoinTokenRedeemed} (or {@link auditJoinTokenRedeemRefused}
 * when enrollment stops after the claim).
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
    auditJoinTokenRedeemRefused(tokenId, reason)
    return { ok: false, reason }
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

  return {
    ok: true,
    tokenId: row.id,
    label: row.label,
    payload,
    ownerUserId: row.owner_user_id ?? null
  }
}
