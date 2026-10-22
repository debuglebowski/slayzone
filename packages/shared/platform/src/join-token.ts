/**
 * Stateless join-token decode — the CONSUMER side of the szjt1 grammar.
 *
 * A join token is `szjt1.<base64url(JSON{hubUrl,secret})>` — the exact format
 * minted by the hub in `@slayzone/computers/server` (join-tokens.ts).
 *
 * TWO CONSUMERS, ONE DECODER:
 *   - the COMPUTER reads the embedded `hubUrl` to dial the hub before sending any
 *     computer frame; the hub's front end certificate is verified the normal way
 *     (CA chain + hostname), never pinned;
 *   - `slay computer create` validates a `--token` locally (fail fast on a typo rather
 *     than installing a unit that crash-loops against an undialable hub) and reads
 *     the `hubUrl` out of it for `slay computer ls`.
 *
 * A token minted by an older hub also carries `certFingerprint`, a pin of the
 * certificate that hub used to serve itself. It is IGNORED: the hub no longer
 * presents a certificate of its own, so the pin could only ever fail against the
 * front end's. Such a token still decodes ({@link joinTokenCarriesCertPin} lets a
 * computer say that it ignores the pin). No prefix bump: this decoder accepts both
 * shapes, so there is nothing for a version to distinguish.
 *
 * This is a dependency-free re-implementation of the hub-side `decodeJoinToken`.
 * Importing the hub decoder from `@slayzone/computers/server` would drag its `./store`
 * module (and thus better-sqlite3) into both the computer and the CLI bundle. The token
 * grammar is trivial and stable (`szjt1.` prefix), so decoding it here is the
 * smallest sustainable option — kept byte-compatible with the minter, which
 * `computer/src/join-token.test.ts` pins by round-tripping a REAL minted token.
 *
 * Lives on the lean `@slayzone/platform/join-token` subpath (node builtins only, no
 * local imports) so neither consumer pulls the platform barrel.
 *
 * @module platform/join-token
 */

/** Prefix of a v1 join token — must match `@slayzone/computers/server`. */
export const JOIN_TOKEN_PREFIX = 'szjt1'

/** Decoded contents of a join token — what an enrolling computer needs. */
export interface JoinTokenPayload {
  hubUrl: string
  /** 256-bit random secret (base64url). Unused by the computer (the enroll frame
   *  carries the whole token), but decoded for completeness. */
  secret: string
}

/** The token's JSON object, or null when it is not a well-formed `szjt1.` token. */
function parseJoinTokenBody(token: string): Record<string, unknown> | null {
  const dot = token.indexOf('.')
  if (dot === -1 || token.slice(0, dot) !== JOIN_TOKEN_PREFIX) return null
  const body = token.slice(dot + 1)
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Decode a token's embedded payload. Returns `null` for anything that is not a
 * well-formed `szjt1.` token (wrong prefix, empty/invalid base64url, non-object
 * JSON, or missing string fields). Any other field — an older hub's
 * `certFingerprint` included — is ignored.
 */
export function decodeJoinToken(token: string): JoinTokenPayload | null {
  const parsed = parseJoinTokenBody(token)
  if (!parsed) return null
  const { hubUrl, secret } = parsed
  if (typeof hubUrl !== 'string' || typeof secret !== 'string') return null
  return { hubUrl, secret }
}

/**
 * True when `token` is a well-formed token from an older hub that still carries a
 * certificate pin (a non-empty `certFingerprint`). The pin is never used; this only
 * lets a computer report at boot that it ignores one, so the change from pinning to
 * normal certificate verification is never silent.
 */
export function joinTokenCarriesCertPin(token: string): boolean {
  if (!decodeJoinToken(token)) return false
  const pin = parseJoinTokenBody(token)?.certFingerprint
  return typeof pin === 'string' && pin !== ''
}
