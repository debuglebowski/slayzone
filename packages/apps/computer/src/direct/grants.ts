/**
 * The computer's direct-link capability table (docs/direct-link.md).
 *
 * A hub registers a grant with `direct.grant` BEFORE it hands the raw token to a
 * client. The table keeps only the token's SHA-256, which is what a client's token
 * is looked up by. The raw token never reaches this process from the hub, and the
 * table never holds it, so a dump of it cannot be replayed.
 *
 * - **Lifetime** counts on this process's monotonic clock (`now`), so hub/computer
 *   wall-clock skew cannot stretch it.
 * - **Every drop is reported** through `onDropped`, whether the grant expired or was
 *   revoked or reset, so the listener can close what the grant opened.
 * - **Per hub.** A computer may serve several hubs; a hub can revoke and reset only
 *   its own grants.
 *
 * @module computer/direct/grants
 */
import { createHash } from 'node:crypto'
import type {
  DirectGrantParams,
  DirectResource,
  DirectRevokeParams
} from '@slayzone/computer-transport/shared'

export interface GrantRecord {
  grantId: string
  /** Which hub link registered it. */
  hubKey: string
  userId: string | null
  resource: DirectResource
  /** On the store's `now()` clock. */
  expiresAt: number
}

export type GrantDropReason = 'expired' | 'revoked' | 'reset'

export interface DirectGrantStore {
  /** Register (or replace, by grant id) one grant from `hubKey`. Throws past the cap. */
  grant(hubKey: string, params: DirectGrantParams): void
  revoke(hubKey: string, params: DirectRevokeParams): number
  /** Keep only `keep` of `hubKey`'s grants; returns how many were dropped. */
  reset(hubKey: string, keep: readonly string[]): number
  /** The live grant a raw token names, or null (unknown or expired). */
  authenticate(token: string): GrantRecord | null
  /** The live grant by id, or null. */
  get(grantId: string): GrantRecord | null
  size(): number
  /** Also tell `listener` about every drop (the direct listener closes what it opened). */
  onDropped(listener: (grants: GrantRecord[], reason: GrantDropReason) => void): () => void
  close(): void
}

export interface DirectGrantStoreOptions {
  /** Monotonic ms. Default `performance.now()`. */
  now?: () => number
  /** Wall-clock Unix ms, for a grant's absolute `notAfter`. Default `Date.now()`. */
  wallNow?: () => number
  onDropped?: (grants: GrantRecord[], reason: GrantDropReason) => void
  /** Bound per hub, so a misbehaving hub cannot grow this without limit. */
  maxGrantsPerHub?: number
}

const DEFAULT_MAX_GRANTS_PER_HUB = 10_000

interface Entry extends GrantRecord {
  tokenHash: string
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function publicRecord(e: Entry): GrantRecord {
  return {
    grantId: e.grantId,
    hubKey: e.hubKey,
    userId: e.userId,
    resource: e.resource,
    expiresAt: e.expiresAt
  }
}

function sameResource(
  r: DirectResource,
  target: Extract<DirectRevokeParams, { by: 'resource' }>['resource']
): boolean {
  if (r.kind === 'pty' && target.kind === 'pty') return r.sessionId === target.sessionId
  if (r.kind === 'chat' && target.kind === 'chat') return r.tabId === target.tabId
  if (r.kind === 'task' && target.kind === 'task') return r.taskId === target.taskId
  return false
}

export function createDirectGrantStore(options: DirectGrantStoreOptions = {}): DirectGrantStore {
  const now = options.now ?? (() => performance.now())
  const wallNow = options.wallNow ?? (() => Date.now())
  const maxPerHub = options.maxGrantsPerHub ?? DEFAULT_MAX_GRANTS_PER_HUB
  const byId = new Map<string, Entry>()
  const byHash = new Map<string, Entry>()
  let sweepTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  const dropListeners = new Set<(grants: GrantRecord[], reason: GrantDropReason) => void>()
  if (options.onDropped) dropListeners.add(options.onDropped)

  function remove(entries: Entry[], reason: GrantDropReason): number {
    for (const e of entries) {
      byId.delete(e.grantId)
      byHash.delete(e.tokenHash)
    }
    if (entries.length > 0) {
      const records = entries.map(publicRecord)
      for (const listener of dropListeners) listener(records, reason)
    }
    return entries.length
  }

  function sweep(): void {
    const t = now()
    remove(
      [...byId.values()].filter((e) => e.expiresAt <= t),
      'expired'
    )
    schedule()
  }

  function schedule(): void {
    if (sweepTimer) clearTimeout(sweepTimer)
    sweepTimer = null
    if (closed || byId.size === 0) return
    let next = Number.POSITIVE_INFINITY
    for (const e of byId.values()) next = Math.min(next, e.expiresAt)
    sweepTimer = setTimeout(sweep, Math.max(0, next - now()))
    sweepTimer.unref?.()
  }

  function live(e: Entry | undefined): Entry | null {
    if (!e) return null
    if (e.expiresAt <= now()) {
      remove([e], 'expired')
      schedule()
      return null
    }
    return e
  }

  return {
    grant(hubKey, params) {
      // An absolute end (`notAfter`, wall clock) bounds the grant however late it
      // arrived: what is left of it at receipt, on this store's monotonic clock. One that
      // is already past is refused, never registered.
      const left =
        params.notAfter === undefined ? Number.POSITIVE_INFINITY : params.notAfter - wallNow()
      if (left <= 0) throw new Error('direct-link grant arrived after its absolute end')
      const existing = byId.get(params.grantId)
      if (existing && existing.hubKey !== hubKey) {
        throw new Error('grant id already registered by another hub')
      }
      if (existing) {
        byId.delete(existing.grantId)
        byHash.delete(existing.tokenHash)
      } else {
        let count = 0
        for (const e of byId.values()) if (e.hubKey === hubKey) count++
        if (count >= maxPerHub) throw new Error('too many direct-link grants from this hub')
      }
      const entry: Entry = {
        grantId: params.grantId,
        hubKey,
        userId: params.userId,
        resource: params.resource,
        expiresAt: now() + Math.min(params.ttlMs, left),
        tokenHash: params.tokenHash
      }
      byId.set(entry.grantId, entry)
      byHash.set(entry.tokenHash, entry)
      schedule()
    },

    revoke(hubKey, params) {
      const mine = [...byId.values()].filter((e) => e.hubKey === hubKey)
      const hit = mine.filter((e) => {
        switch (params.by) {
          case 'grant':
            return params.grantIds.includes(e.grantId)
          case 'user':
            return e.userId === params.userId
          case 'resource':
            return sameResource(e.resource, params.resource)
          case 'all':
            return true
        }
      })
      const n = remove(hit, 'revoked')
      schedule()
      return n
    },

    reset(hubKey, keep) {
      const kept = new Set(keep)
      const n = remove(
        [...byId.values()].filter((e) => e.hubKey === hubKey && !kept.has(e.grantId)),
        'reset'
      )
      schedule()
      return n
    },

    authenticate(token) {
      if (typeof token !== 'string' || token.length === 0) return null
      const e = live(byHash.get(sha256Hex(token)))
      return e ? publicRecord(e) : null
    },

    get(grantId) {
      const e = live(byId.get(grantId))
      return e ? publicRecord(e) : null
    },

    size() {
      return byId.size
    },

    onDropped(listener) {
      dropListeners.add(listener)
      return () => dropListeners.delete(listener)
    },

    close() {
      closed = true
      if (sweepTimer) clearTimeout(sweepTimer)
      sweepTimer = null
      byId.clear()
      byHash.clear()
    }
  }
}
