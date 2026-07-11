import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type { JoinToken } from '../shared/types'

/**
 * Single-use runner enrollment tokens.
 *
 * Token format: `szjt1.<base64url(JSON payload)>` where the payload embeds the
 * hub URL, the hub's TLS cert fingerprint (so the runner can pin it before
 * trusting the hub) and a 256-bit random secret. The DB stores ONLY
 * `sha256(token)` — the plaintext token is returned once from `mintJoinToken`
 * and can never be recovered from the hub afterwards.
 */

export const JOIN_TOKEN_PREFIX = 'szjt1'

/** Decoded contents of a join token — what an enrolling runner needs. */
export interface JoinTokenPayload {
  hubUrl: string
  certFingerprint: string
  /** 256-bit random secret (base64url). Makes the token unguessable. */
  secret: string
}

export interface MintJoinTokenInput {
  hubUrl: string
  certFingerprint: string
  ttlMs: number
  label: string
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
  | { ok: true; tokenId: string; label: string; payload: JoinTokenPayload }
  | { ok: false; reason: 'malformed' | 'unknown' | 'used' | 'expired' }

/** The at-rest form of a token: lowercase hex sha256 of the full token string. */
export function hashJoinToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Stateless decode of a token's embedded payload (no DB) — the runner side
 * uses this to learn the hub URL + pinned cert before dialing. Returns `null`
 * for anything that isn't a well-formed `szjt1.` token.
 */
export function decodeJoinToken(token: string): JoinTokenPayload | null {
  const dot = token.indexOf('.')
  if (dot === -1 || token.slice(0, dot) !== JOIN_TOKEN_PREFIX) return null
  const body = token.slice(dot + 1)
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const { hubUrl, certFingerprint, secret } = parsed as Record<string, unknown>
    if (
      typeof hubUrl !== 'string' ||
      typeof certFingerprint !== 'string' ||
      typeof secret !== 'string'
    ) {
      return null
    }
    return { hubUrl, certFingerprint, secret }
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
    certFingerprint: input.certFingerprint,
    secret: randomBytes(32).toString('base64url')
  }
  const token = `${JOIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
  const id = randomUUID()
  const expiresAt = now + input.ttlMs
  await db.run(
    `INSERT INTO join_tokens (id, token_hash, label, created_at, expires_at, used_at, runner_id)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    [id, hashJoinToken(token), input.label, now, expiresAt]
  )
  return { id, token, label: input.label, created_at: now, expires_at: expiresAt }
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
  const payload = decodeJoinToken(token)
  if (!payload) return { ok: false, reason: 'malformed' }

  const row = await db.get<JoinToken>(`SELECT * FROM join_tokens WHERE token_hash = ?`, [
    hashJoinToken(token)
  ])
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.used_at !== null) return { ok: false, reason: 'used' }
  if (row.expires_at <= now) return { ok: false, reason: 'expired' }

  const res = await db.run(
    `UPDATE join_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
    [now, row.id, now]
  )
  if (res.changes === 0) return { ok: false, reason: 'used' }

  return { ok: true, tokenId: row.id, label: row.label, payload }
}
