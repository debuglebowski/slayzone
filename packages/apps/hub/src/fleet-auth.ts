/**
 * Fleet auth adapter factory.
 *
 * Pure glue between three dark hub/runner-split domains and the fleet hub
 * gateway: it adapts the `@slayzone/runners` store + join-token verifier and the
 * `@slayzone/hub-auth` API-key mint/verify into the exact two callbacks the
 * gateway injects — `verifyEnrollment` and `verifyApiKey`. This module reaches
 * into no persistence of its own; it consumes each domain via its public barrel.
 *
 * Lands DARK — nothing wires these adapters into the gateway yet; a later serial
 * unit calls `createFleetAuthAdapters(...)` and hands the result to
 * `createHubFleetGateway`.
 *
 * The return type is structurally pinned to `HubFleetGatewayOptions` so the
 * callbacks can never silently drift from what the gateway expects.
 *
 * @module server/fleet-auth
 */

import { randomUUID } from 'node:crypto'
import type { HubFleetGatewayOptions } from '@slayzone/fleet/server'
import { FleetErrorCodes, RpcError } from '@slayzone/fleet/shared'
import { type HubAuth, mintRunnerApiKey, verifyRunnerApiKey } from '@slayzone/hub-auth/server'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  deterministicLocalRunnerId,
  getRunner,
  hashJoinToken,
  registerOrReplaceRunner,
  registerRunner,
  retireStaleLocalRunners,
  touchRunnerLastSeen,
  verifyJoinToken
} from '@slayzone/runners/server'

/**
 * The two auth callbacks the fleet hub gateway injects, sliced straight off the
 * gateway's own options type. Keeping this a `Pick` (rather than re-declaring
 * the signatures) guarantees an exact, drift-proof match with the gateway.
 */
export type FleetAuthAdapters = Pick<HubFleetGatewayOptions, 'verifyEnrollment' | 'verifyApiKey'>

export interface FleetAuthAdapterDeps {
  /** App `SlayzoneDb` — home of the `runners` / `join_tokens` tables. */
  db: SlayzoneDb
  /** hub-auth better-auth instance — mints and verifies runner API keys. */
  auth: HubAuth
  /**
   * Re-enroll grace window, ms. A join token is single-use, but the socket can
   * drop between the hub minting a credential and the runner receiving it; the
   * runner then re-dials and enrolls again. Within this window a repeat enroll
   * for the SAME `(joinToken, name)` returns the identical `runnerId` + `apiKey`
   * instead of failing `used`. Default 5 minutes.
   */
  reenrollGraceMs?: number
  /**
   * Name of the co-located ("local") auto-spawned runner (Wave3.5-D5). When an
   * enroll arrives for THIS name, the runner is treated as local: it gets a
   * DETERMINISTIC id (`deterministicLocalRunnerId`) + an UPSERT register, and any
   * OTHER rows sharing this name (historical duplicates from the pre-fix boots)
   * are retired — collapsing the local runner to a single row. ALL other names
   * (remote runners) keep the fresh-uuid INSERT path untouched. Absent ⇒ no name
   * is treated as local (every enroll is a plain remote INSERT, prior behavior).
   */
  localRunnerName?: string
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number
}

const DEFAULT_REENROLL_GRACE_MS = 5 * 60_000

interface GraceEntry {
  runnerId: string
  apiKey: string
  expiresAt: number
}

/**
 * Build the enrollment + api-key adapters for one hub.
 *
 * ## Idempotency (Option A — in-memory grace ledger)
 * `verifyJoinToken` is single-use: it atomically stamps `used_at`, so a naive
 * re-invocation on socket-drop reconnect would reject with `used` and strand the
 * runner. We guard that with a short in-process ledger keyed on
 * `sha256(joinToken) + name`: the first successful enroll records the minted
 * `runnerId` + plaintext `apiKey`; a repeat enroll for the same key inside the
 * grace window returns that exact pair without re-consuming the token or
 * registering a second runner.
 *
 * Chosen over the alternative (persist `join_tokens.runner_id` and re-mint on a
 * `used` result) because it (a) returns the IDENTICAL credential first handed
 * out — no orphaned API keys — and (b) needs no new store surface, honoring
 * barrel-only consumption of the runners domain. The reconnect it covers happens
 * within the same hub process seconds apart, so an in-memory ledger is
 * sufficient; a hub restart legitimately invalidates a half-delivered token.
 */
export function createFleetAuthAdapters(deps: FleetAuthAdapterDeps): FleetAuthAdapters {
  const { db, auth } = deps
  const graceMs = deps.reenrollGraceMs ?? DEFAULT_REENROLL_GRACE_MS
  const now = deps.now ?? Date.now
  const localRunnerName = deps.localRunnerName

  const grace = new Map<string, GraceEntry>()

  const graceKey = (joinToken: string, name: string): string =>
    `${hashJoinToken(joinToken)} ${name}`

  const sweepExpired = (at: number): void => {
    for (const [key, entry] of grace) {
      if (entry.expiresAt <= at) grace.delete(key)
    }
  }

  const verifyEnrollment: FleetAuthAdapters['verifyEnrollment'] = async (params) => {
    const at = now()
    sweepExpired(at)
    const key = graceKey(params.joinToken, params.name)

    // Socket-drop reconnect: hand back the same credential, don't re-consume.
    const cached = grace.get(key)
    if (cached) return { runnerId: cached.runnerId, apiKey: cached.apiKey }

    const verified = await verifyJoinToken(db, params.joinToken, at)
    if (!verified.ok) {
      throw new RpcError(
        FleetErrorCodes.unauthorized,
        `join token rejected: ${verified.reason}`
      )
    }

    // Local vs remote enroll (Wave3.5-D5). The co-located auto-spawned runner is
    // identified purely by its NAME (localRunnerName); it gets a DETERMINISTIC id
    // + an UPSERT so a re-enroll collapses onto its own single row rather than
    // accumulating an orphan per boot. Every other name is a REMOTE runner and
    // keeps the fresh-uuid INSERT path — a disconnected remote laptop is never
    // touched or deduped.
    const isLocal = localRunnerName !== undefined && params.name === localRunnerName
    const runnerId = isLocal ? deterministicLocalRunnerId(params.name) : randomUUID()

    // Mint the key BEFORE registering — the store persists `auth_key_id` only at
    // write time, so the key id must be known first.
    const minted = await mintRunnerApiKey(auth, { runnerId, name: params.name })
    if (isLocal) {
      await registerOrReplaceRunner(db, {
        id: runnerId,
        name: params.name,
        platform: params.platform,
        version: params.version,
        capabilities: toCapabilityMap(params.capabilities),
        authKeyId: minted.keyId,
        now: at
      })
      // One-time (idempotent) collapse of any pre-fix duplicate local rows: retire
      // every OTHER row sharing the local name. No-op once collapsed. Identity-only
      // (by name) — never status-based, never touches a remote runner.
      await retireStaleLocalRunners(db, { name: params.name, keepRunnerId: runnerId })
    } else {
      await registerRunner(db, {
        id: runnerId,
        name: params.name,
        platform: params.platform,
        version: params.version,
        capabilities: toCapabilityMap(params.capabilities),
        authKeyId: minted.keyId,
        now: at
      })
    }

    grace.set(key, { runnerId, apiKey: minted.key, expiresAt: at + graceMs })
    return { runnerId, apiKey: minted.key }
  }

  const verifyApiKey: FleetAuthAdapters['verifyApiKey'] = async (apiKey) => {
    const principal = await verifyRunnerApiKey(auth, apiKey)
    if (!principal) return null

    const runner = await getRunner(db, principal.runnerId)
    if (!runner || runner.revoked_at !== null) return null

    await touchRunnerLastSeen(db, runner.id, now())

    return {
      runnerId: runner.id,
      name: runner.name,
      platform: runner.platform,
      version: runner.version,
      capabilities: parseCapabilityTags(runner.capabilities_json)
    }
  }

  return { verifyEnrollment, verifyApiKey }
}

/**
 * The runner advertises a flat capability tag list (`string[]`), but the store
 * models capabilities as an object map. Encode the set as a `{ tag: true }` map
 * so it persists losslessly through the store's declared type without a cast;
 * `parseCapabilityTags` reverses it.
 */
function toCapabilityMap(tags: string[]): Record<string, true> {
  const map: Record<string, true> = {}
  for (const tag of tags) map[tag] = true
  return map
}

/**
 * Reverse of `toCapabilityMap`: reconstruct the runner's tag list from its
 * persisted `capabilities_json`. Accepts the `{ tag: true }` map written at
 * enroll (keys are the tags) and, defensively, a bare string array. Anything
 * else degrades to `undefined` rather than leaking a wrong shape onto the wire.
 */
function parseCapabilityTags(json: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(json)
    if (Array.isArray(parsed)) {
      const tags = parsed.filter((entry): entry is string => typeof entry === 'string')
      return tags.length > 0 ? tags : undefined
    }
    if (parsed !== null && typeof parsed === 'object') {
      const tags = Object.keys(parsed as Record<string, unknown>)
      return tags.length > 0 ? tags : undefined
    }
  } catch {
    // Malformed JSON — treat as no advertised capabilities.
  }
  return undefined
}
