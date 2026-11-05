/**
 * Direct client ↔ computer link — the hub → computer grant frames (protocol v8).
 *
 * The hub gates a client's request ONCE, mints an opaque 256-bit token, and
 * registers only its SHA-256 on the computer with `direct.grant` before handing the
 * raw token to the client. The client then presents the token to the computer's
 * direct listener. The raw token never crosses the hub ↔ computer link, and the
 * computer never stores it: a leaked grant table cannot be replayed.
 *
 * Audience binding is inherent: only the computer that received the hash can
 * accept the token. Lifetime is a TTL in ms, counted on the computer's own
 * monotonic clock, so hub/computer wall-clock skew cannot stretch it.
 *
 * See docs/direct-link.md.
 *
 * @module computer/shared/direct
 */
import { z } from 'zod'
import { isBareAuthority } from '@slayzone/platform/hub-addr'

/** Wire version of the client ↔ computer direct protocol (path segment + issue result). */
export const DIRECT_LINK_PROTOCOL = 1

/** Upgrade path of the computer's direct listener. */
export const DIRECT_LINK_PATH = '/direct/v1'

/**
 * Plain-HTTP reachability probe on the direct listener. Clients probe here before
 * opening any WebSocket: Chromium throttles ALL of a renderer's sockets after
 * failed WebSocket connects, and a failed fetch does not count.
 */
export const DIRECT_LINK_HEALTH_PATH = '/direct/v1/health'

/** Grant lifetime. Clients renew at half of it through the hub (re-gated). */
export const DIRECT_GRANT_TTL_MS = 5 * 60_000

/** Upper bound the computer accepts for a grant's TTL, whatever the hub sends. */
export const DIRECT_GRANT_MAX_TTL_MS = 15 * 60_000

const idField = z.string().min(1).max(200)

/** SHA-256 of the raw token, lowercase hex. */
export const directTokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/)

/** What one grant lets its bearer touch on the computer. */
export const directResourceSchema = z.discriminatedUnion('kind', [
  /** One terminal session's output, backfill and input. */
  z.object({ kind: z.literal('pty'), sessionId: idField }),
  /**
   * One chat tab, pinned to the ownership epoch the hub checked. The computer
   * refuses the grant's requests once its own epoch for the tab moves on.
   */
  z.object({
    kind: z.literal('chat'),
    tabId: idField,
    epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
])
export type DirectResource = z.infer<typeof directResourceSchema>

/** `direct.grant` params: register one capability. */
export const directGrantParamsSchema = z.object({
  /** Hub-minted id, safe to log (the token is not). */
  grantId: idField,
  tokenHash: directTokenHashSchema,
  /** The user the hub gated. `null` = a hub without login (its one local user). */
  userId: idField.nullable(),
  resource: directResourceSchema,
  ttlMs: z.number().int().positive().max(DIRECT_GRANT_MAX_TTL_MS)
})
export type DirectGrantParams = z.infer<typeof directGrantParamsSchema>

export const directGrantResultSchema = z.object({ ok: z.literal(true) })
export type DirectGrantResult = z.infer<typeof directGrantResultSchema>

/** `direct.revoke` params: drop grants now, and close what they opened. */
export const directRevokeParamsSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('grant'), grantIds: z.array(idField).min(1).max(1000) }),
  /** Every grant issued to a user (account disabled). */
  z.object({ by: z.literal('user'), userId: idField }),
  /** Every grant on one session / tab, whatever its epoch (task gone, ownership moved). */
  z.object({
    by: z.literal('resource'),
    resource: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('pty'), sessionId: idField }),
      z.object({ kind: z.literal('chat'), tabId: idField })
    ])
  }),
  /** Every grant from this hub (computer revoked, hub shutting down). */
  z.object({ by: z.literal('all') })
])
export type DirectRevokeParams = z.infer<typeof directRevokeParamsSchema>

export const directRevokeResultSchema = z.object({ revoked: z.number().int().nonnegative() })
export type DirectRevokeResult = z.infer<typeof directRevokeResultSchema>

/**
 * `direct.reset` params: sent once after every (re)connect. The computer keeps only
 * the listed grants; a hub that restarted lists none, so every grant drops.
 */
export const directResetParamsSchema = z.object({
  keep: z.array(idField).max(10_000)
})
export type DirectResetParams = z.infer<typeof directResetParamsSchema>

export const directResetResultSchema = z.object({ dropped: z.number().int().nonnegative() })
export type DirectResetResult = z.infer<typeof directResetResultSchema>

/**
 * The authority a computer advertises for its direct listener (`hello` /
 * `enroll`, v8). Authority only — never a URL: clients derive the scheme from the
 * host (`hubUrlFromAddr`), and TLS is a front end's job, never the computer's.
 * `null` = no direct listener.
 */
export const directAddressSchema = z.string().min(1).max(300).nullable()

// ── WebRTC (remote computers without a reachable listener) ─────────────────────
//
// The hub brokers ONE offer/answer per peer connection over the links it already
// has (the client's tRPC socket, the computer's authed wss), bound to a grant it
// registered. The data channel then carries the same direct protocol as the
// WebSocket listener, and its first frame still presents the capability.

/** Label of the data channel the direct protocol runs on. */
export const DIRECT_RTC_CHANNEL_LABEL = 'slayzone-direct-v1'

/** Largest SDP accepted either way (a complete, non-trickle description). */
export const DIRECT_RTC_MAX_SDP = 64 * 1024

/** STUN servers handed to both peers: authorities (`host:port`), never URLs. */
export const directStunAddressesSchema = z
  .array(z.string().min(1).max(300).refine(isBareAuthority, 'a bare host:port authority'))
  .max(8)

/** `direct.rtcOffer` params: answer the client's offer for a grant this hub registered. */
export const directRtcOfferParamsSchema = z.object({
  grantId: idField,
  sdp: z.string().min(1).max(DIRECT_RTC_MAX_SDP),
  stunAddresses: directStunAddressesSchema
})
export type DirectRtcOfferParams = z.infer<typeof directRtcOfferParamsSchema>

/** The computer's complete answer (candidates gathered in). */
export const directRtcAnswerSchema = z.object({
  sdp: z.string().min(1).max(DIRECT_RTC_MAX_SDP)
})
export type DirectRtcAnswer = z.infer<typeof directRtcAnswerSchema>
