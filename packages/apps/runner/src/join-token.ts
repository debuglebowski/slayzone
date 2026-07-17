/**
 * Stateless join-token decode (runner side).
 *
 * A join token is `szjt1.<base64url(JSON{hubUrl,certFingerprint,secret})>` — the
 * exact format minted by the hub in `@slayzone/runners/server` (join-tokens.ts).
 * The runner needs the embedded `hubUrl` + `certFingerprint` to dial + pin the
 * hub before sending any runner frame.
 *
 * This is a dependency-free re-implementation of the hub-side `decodeJoinToken`.
 * The runner package only depends on `@slayzone/runner-transport`; importing the hub decoder
 * from `@slayzone/runners/server` would drag its `./store` module (and thus
 * `@slayzone/platform` + better-sqlite3) into the runner bundle. The token grammar
 * is trivial and stable (`szjt1.` prefix), so decoding it locally is the smallest
 * sustainable option — kept byte-compatible with the minter.
 *
 * @module runner/join-token
 */

/** Prefix of a v1 join token — must match `@slayzone/runners/server`. */
export const JOIN_TOKEN_PREFIX = 'szjt1'

/** Decoded contents of a join token — what an enrolling runner needs. */
export interface JoinTokenPayload {
  hubUrl: string
  certFingerprint: string
  /** 256-bit random secret (base64url). Unused by the runner (the enroll frame
   *  carries the whole token), but decoded for completeness. */
  secret: string
}

/**
 * Decode a token's embedded payload. Returns `null` for anything that is not a
 * well-formed `szjt1.` token (wrong prefix, empty/invalid base64url, non-object
 * JSON, or missing string fields).
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
