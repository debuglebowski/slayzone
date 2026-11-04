/**
 * React side of `keepDirectLease`: hold a direct-link lease for one target while
 * the component is mounted (docs/direct-link.md). Null while there is none (use the
 * hub relay). `wakeKey`: when it changes, try again at once (e.g. the session
 * started). `lost()`: report the lease unusable (its stream ended).
 *
 * Off — always null — in a client that installed no probe (`setDirectLinkProbe`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirectTarget } from '../direct/router'
import { keepDirectLease, type DirectLeaseKeeper } from './direct-lease-keeper'
import {
  directLinkManagerFor,
  isDirectLinkEnabled,
  type DirectLease,
  type DirectLinkHubClient
} from './direct-link'
import { useHubId } from './HubScope'

/** Ambient hub id outside a HubScope (single hub, tests). */
const DEFAULT_HUB_KEY = 'default'

export function useDirectLease(
  client: unknown,
  target: DirectTarget | null,
  wakeKey?: unknown
): { lease: DirectLease | null; lost: () => void } {
  const hubId = useHubId() ?? DEFAULT_HUB_KEY
  const [lease, setLease] = useState<DirectLease | null>(null)
  const keeperRef = useRef<DirectLeaseKeeper | null>(null)
  const wakeRef = useRef(new Set<() => void>())
  const kind = target?.kind
  const id = target ? (target.kind === 'pty' ? target.sessionId : target.tabId) : null

  useEffect(() => {
    if (!kind || !id || !isDirectLinkEnabled()) return
    const keeper = keepDirectLease({
      target: kind === 'pty' ? { kind, sessionId: id } : { kind, tabId: id },
      manager: directLinkManagerFor(hubId, client as DirectLinkHubClient),
      wake: (cb) => {
        wakeRef.current.add(cb)
        return () => wakeRef.current.delete(cb)
      },
      onChange: setLease
    })
    keeperRef.current = keeper
    return () => {
      keeperRef.current = null
      keeper.stop()
    }
  }, [client, hubId, kind, id])

  useEffect(() => {
    for (const cb of wakeRef.current) cb()
  }, [wakeKey])

  const lost = useCallback(() => keeperRef.current?.lost(), [])
  return { lease, lost }
}
