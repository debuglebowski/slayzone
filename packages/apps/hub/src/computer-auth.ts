/**
 * Computer auth adapter factory.
 *
 * Pure glue between three dark hub/computer-split domains and the computer hub
 * gateway: it adapts the `@slayzone/computers` store + join-token verifier and the
 * `@slayzone/hub-auth` API-key mint/verify into the exact two callbacks the
 * gateway injects — `verifyEnrollment` and `verifyApiKey`. This module reaches
 * into no persistence of its own; it consumes each domain via its public barrel.
 *
 * Lands DARK — nothing wires these adapters into the gateway yet; a later serial
 * unit calls `createComputerAuthAdapters(...)` and hands the result to
 * `createHubComputerGateway`.
 *
 * The return type is structurally pinned to `HubComputerGatewayOptions` so the
 * callbacks can never silently drift from what the gateway expects.
 *
 * @module server/computer-auth
 */

import { randomUUID } from 'node:crypto'
import type { HubComputerGatewayOptions } from '@slayzone/computer-transport/server'
import { ComputerTransportErrorCodes, RpcError } from '@slayzone/computer-transport/shared'
import { type HubAuth, mintComputerApiKey, verifyComputerApiKey } from '@slayzone/hub-auth/server'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  deterministicLocalComputerId,
  getComputer,
  hashJoinToken,
  registerOrReplaceComputer,
  setComputerOwner,
  registerComputer,
  retireStaleLocalComputers,
  touchComputerLastSeen,
  reconcileMachineForComputer,
  verifyJoinToken
} from '@slayzone/computers/server'

/**
 * The two auth callbacks the computer hub gateway injects, sliced straight off the
 * gateway's own options type. Keeping this a `Pick` (rather than re-declaring
 * the signatures) guarantees an exact, drift-proof match with the gateway.
 */
export type ComputerAuthAdapters = Pick<
  HubComputerGatewayOptions,
  'verifyEnrollment' | 'verifyApiKey'
>

export interface ComputerAuthAdapterDeps {
  /** App `SlayzoneDb` — home of the `computers` / `join_tokens` tables. */
  db: SlayzoneDb
  /** hub-auth better-auth instance — mints and verifies computer API keys. */
  auth: HubAuth
  /**
   * Re-enroll grace window, ms. A join token is single-use, but the socket can
   * drop between the hub minting a credential and the computer receiving it; the
   * computer then re-dials and enrolls again. Within this window a repeat enroll
   * for the SAME `(joinToken, name)` returns the identical `computerId` + `apiKey`
   * instead of failing `used`. Default 5 minutes.
   */
  reenrollGraceMs?: number
  /**
   * Name of the co-located ("local") auto-spawned computer (Wave3.5-D5). When an
   * enroll arrives for THIS name, the computer is treated as local: it gets a
   * DETERMINISTIC id (`deterministicLocalComputerId`) + an UPSERT register, and any
   * OTHER rows sharing this name (historical duplicates from the pre-fix boots)
   * are retired — collapsing the local computer to a single row. ALL other names
   * (remote computers) keep the fresh-uuid INSERT path untouched. Absent ⇒ no name
   * is treated as local (every enroll is a plain remote INSERT, prior behavior).
   */
  localComputerName?: string
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number
}

const DEFAULT_REENROLL_GRACE_MS = 5 * 60_000

interface GraceEntry {
  computerId: string
  apiKey: string
  expiresAt: number
}

/**
 * Build the enrollment + api-key adapters for one hub.
 *
 * ## Idempotency (Option A — in-memory grace ledger)
 * `verifyJoinToken` is single-use: it atomically stamps `used_at`, so a naive
 * re-invocation on socket-drop reconnect would reject with `used` and strand the
 * computer. We guard that with a short in-process ledger keyed on
 * `sha256(joinToken) + name`: the first successful enroll records the minted
 * `computerId` + plaintext `apiKey`; a repeat enroll for the same key inside the
 * grace window returns that exact pair without re-consuming the token or
 * registering a second computer.
 *
 * Chosen over the alternative (persist `join_tokens.computer_id` and re-mint on a
 * `used` result) because it (a) returns the IDENTICAL credential first handed
 * out — no orphaned API keys — and (b) needs no new store surface, honoring
 * barrel-only consumption of the computers domain. The reconnect it covers happens
 * within the same hub process seconds apart, so an in-memory ledger is
 * sufficient; a hub restart legitimately invalidates a half-delivered token.
 */
export function createComputerAuthAdapters(deps: ComputerAuthAdapterDeps): ComputerAuthAdapters {
  const { db, auth } = deps
  const graceMs = deps.reenrollGraceMs ?? DEFAULT_REENROLL_GRACE_MS
  const now = deps.now ?? Date.now
  const localComputerName = deps.localComputerName

  const grace = new Map<string, GraceEntry>()

  const graceKey = (joinToken: string, name: string): string =>
    `${hashJoinToken(joinToken)} ${name}`

  const sweepExpired = (at: number): void => {
    for (const [key, entry] of grace) {
      if (entry.expiresAt <= at) grace.delete(key)
    }
  }

  const verifyEnrollment: ComputerAuthAdapters['verifyEnrollment'] = async (params) => {
    const at = now()
    sweepExpired(at)
    const key = graceKey(params.joinToken, params.name)

    // Socket-drop reconnect: hand back the same credential, don't re-consume.
    const cached = grace.get(key)
    if (cached) return { computerId: cached.computerId, apiKey: cached.apiKey }

    const verified = await verifyJoinToken(db, params.joinToken, at)
    if (!verified.ok) {
      throw new RpcError(
        ComputerTransportErrorCodes.unauthorized,
        `join token rejected: ${verified.reason}`
      )
    }

    // Local vs remote enroll (Wave3.5-D5). The co-located auto-spawned computer is
    // identified purely by its NAME (localComputerName); it gets a DETERMINISTIC id
    // + an UPSERT so a re-enroll collapses onto its own single row rather than
    // accumulating an orphan per boot. Every other name is a REMOTE computer and
    // keeps the fresh-uuid INSERT path — a disconnected remote laptop is never
    // touched or deduped.
    const isLocal = localComputerName !== undefined && params.name === localComputerName
    const computerId = isLocal ? deterministicLocalComputerId(params.name) : randomUUID()

    // Mint the key BEFORE registering — the store persists `auth_key_id` only at
    // write time, so the key id must be known first.
    const minted = await mintComputerApiKey(auth, { computerId, name: params.name })
    if (isLocal) {
      await registerOrReplaceComputer(db, {
        id: computerId,
        name: params.name,
        platform: params.platform,
        version: params.version,
        capabilities: toCapabilityMap(params.capabilities),
        authKeyId: minted.keyId,
        now: at
      })
      // A computer process runs as exactly one OS account, so it belongs to exactly
      // one SlayZone user. The join token carried who minted it — the only path
      // from "a user clicked mint" to "a machine enrolled" — and null stays null
      // rather than attributing the machine to a guess.
      await setComputerOwner(db, computerId, verified.mintedByUserId)
      // One-time (idempotent) collapse of any pre-fix duplicate local rows: retire
      // every OTHER row sharing the local name. No-op once collapsed. Identity-only
      // (by name) — never status-based, never touches a remote computer.
      await retireStaleLocalComputers(db, { name: params.name, keepComputerId: computerId })
    } else {
      await registerComputer(db, {
        id: computerId,
        name: params.name,
        platform: params.platform,
        version: params.version,
        capabilities: toCapabilityMap(params.capabilities),
        authKeyId: minted.keyId,
        now: at
      })
      await setComputerOwner(db, computerId, verified.mintedByUserId)
    }

    grace.set(key, { computerId, apiKey: minted.key, expiresAt: at + graceMs })
    if (params.hostId) {
      try {
        await reconcileMachineForComputer(db, { computerId, hostId: params.hostId, now: at })
      } catch {
        /* grouping is cosmetic — never block an enroll on it */
      }
    }
    return { computerId, apiKey: minted.key }
  }

  const verifyApiKey: ComputerAuthAdapters['verifyApiKey'] = async (apiKey, context) => {
    const principal = await verifyComputerApiKey(auth, apiKey)
    if (!principal) return null

    const computer = await getComputer(db, principal.computerId)
    if (!computer || computer.revoked_at !== null) return null

    // The key must be THE key this computer enrolled with, not merely A key that
    // names it. Second half of the impersonation fix whose first half lives in
    // `verifyComputerApiKey` (see its docstring): that one proves the key was
    // minted by us, this one proves it was minted FOR this computer. Without it,
    // a stale key from a previous enroll of the same id keeps working forever —
    // `revokeComputerApiKey` deletes the apikey row, but a re-enroll rotates
    // `auth_key_id` and left the old row's holder authenticated.
    //
    // NULL IS ALLOWED, deliberately: `auth_key_id` is nullable and rows enrolled
    // before it was recorded carry null. Refusing those would disconnect every
    // pre-existing computer on upgrade. Such a row is still protected by the
    // `referenceId` check upstream; it just cannot be pinned any tighter until it
    // re-enrolls, at which point `registerComputer` fills the column in.
    if (computer.auth_key_id !== null && computer.auth_key_id !== principal.keyId) return null

    await touchComputerLastSeen(db, computer.id, now())
    // Grouping only — never allowed to fail a reconnect.
    if (context?.hostId) {
      try {
        await reconcileMachineForComputer(db, {
          computerId: computer.id,
          hostId: context.hostId
        })
      } catch {
        /* a computer that cannot be grouped still works perfectly well */
      }
    }

    return {
      computerId: computer.id,
      name: computer.name,
      platform: computer.platform,
      version: computer.version,
      capabilities: parseCapabilityTags(computer.capabilities_json)
    }
  }

  return { verifyEnrollment, verifyApiKey }
}

/**
 * The computer advertises a flat capability tag list (`string[]`), but the store
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
 * Reverse of `toCapabilityMap`: reconstruct the computer's tag list from its
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
