import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Per-task hub bearer tokens (hub/runner split, Model A).
 *
 * When a task's PTY runs on a REMOTE runner, the `slay` CLI + agent hooks inside
 * that pty must dial the HUB (not loopback). They authenticate with a short-lived
 * bearer scoped to `{ taskId, runnerId }`. These are self-contained HMAC-signed
 * tokens (no DB row): the hub verifies them statelessly with the SAME secret it
 * signed them with, and expiry is embedded in the payload.
 *
 * Format: `sztt1.<base64url(JSON claims)>.<base64url(hmac-sha256)>` where the MAC
 * covers `sztt1.<body>`. Chosen over a DB-backed token (like join tokens) because
 * these are minted per-PTY-spawn at high frequency and are inherently short-lived
 * — a stateless MAC needs no storage, no cleanup, and no read on the verify path.
 *
 * This unit MINTS + INJECTS the token so the plumbing exists. Wiring the verify
 * into request-auth middleware is deliberately a follow-up (enforcement) — the
 * hub still trusts the runner API key for the transport itself today.
 */

/** Version prefix — lets the format evolve without ambiguity. */
export const TASK_TOKEN_PREFIX = 'sztt1'

/** Claims embedded in (and recoverable from) a task token. */
export interface TaskTokenClaims {
  taskId: string
  runnerId: string
  /** Issued-at, epoch ms. */
  iat: number
  /** Expiry, epoch ms. */
  exp: number
}

export interface MintTaskTokenInput {
  taskId: string
  runnerId: string
  /** Time-to-live in ms from `now`. */
  ttlMs: number
  /** Clock override for tests. */
  now?: number
}

export type VerifyTaskTokenResult =
  | { ok: true; claims: TaskTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' }

/** HMAC-SHA256(secret, body) as base64url. */
function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url')
}

/**
 * Mint a signed task token. The plaintext is the only artifact — nothing is
 * persisted, so the same `(secret, input)` at the same `now` is reproducible
 * (useful in tests) but otherwise carries a per-call issued-at.
 */
export function mintTaskToken(secret: string, input: MintTaskTokenInput): string {
  const now = input.now ?? Date.now()
  const claims: TaskTokenClaims = {
    taskId: input.taskId,
    runnerId: input.runnerId,
    iat: now,
    exp: now + input.ttlMs
  }
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const signed = `${TASK_TOKEN_PREFIX}.${body}`
  return `${signed}.${sign(secret, signed)}`
}

/**
 * Verify a task token against the signing secret. Rejects a wrong format
 * (`malformed`), a forged/altered token (`bad-signature`), or an elapsed expiry
 * (`expired`). The signature is checked in constant time before the payload is
 * trusted.
 */
export function verifyTaskToken(
  secret: string,
  token: string,
  now: number = Date.now()
): VerifyTaskTokenResult {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TASK_TOKEN_PREFIX) return { ok: false, reason: 'malformed' }
  const [, body, sig] = parts
  if (!body || !sig) return { ok: false, reason: 'malformed' }

  const expected = sign(secret, `${TASK_TOKEN_PREFIX}.${body}`)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'bad-signature' }
  }

  let claims: TaskTokenClaims
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'malformed' }
    }
    const { taskId, runnerId, iat, exp } = parsed as Record<string, unknown>
    if (
      typeof taskId !== 'string' ||
      typeof runnerId !== 'string' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number'
    ) {
      return { ok: false, reason: 'malformed' }
    }
    claims = { taskId, runnerId, iat, exp }
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (claims.exp <= now) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}
