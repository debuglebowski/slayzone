/**
 * React side of `keepDirectLease`: hold a direct-link lease for one target while
 * the component is mounted (docs/direct-link.md). Null while there is none (use the
 * hub relay). `wakeKey`: when it changes, try again at once (e.g. the session
 * started). `lost()`: report the lease unusable (its stream ended).
 *
 * Off — always null — in a client that installed no probe (`setDirectLinkProbe`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirectIssueTarget } from '../direct/router'
import { keepDirectLease, type DirectLeaseKeeper } from './direct-lease-keeper'
import {
  directLinkManagerFor,
  isDirectLinkEnabled,
  type DirectLease,
  type DirectLinkHubClient
} from './direct-link'
import { useHubId } from './HubScope'
import { DIRECT_LINK_DEFAULT_HUB_ID } from '@slayzone/platform/electron-bootstrap-contract'

export function useDirectLease(
  client: unknown,
  target: DirectIssueTarget | null,
  wakeKey?: unknown
): { lease: DirectLease | null; lost: () => void } {
  const hubId = useHubId() ?? DIRECT_LINK_DEFAULT_HUB_ID
  const [lease, setLease] = useState<DirectLease | null>(null)
  const keeperRef = useRef<DirectLeaseKeeper | null>(null)
  const wakeRef = useRef(new Set<() => void>())
  const kind = target?.kind
  const id = target ? (target.kind === 'pty' ? target.sessionId : target.tabId) : null
  const taskId = target?.taskId ?? null

  useEffect(() => {
    if (!kind || !id || !taskId || !isDirectLinkEnabled()) return
    const keeper = keepDirectLease({
      target: kind === 'pty' ? { kind, sessionId: id, taskId } : { kind, tabId: id, taskId },
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
  }, [client, hubId, kind, id, taskId])

  useEffect(() => {
    for (const cb of wakeRef.current) cb()
  }, [wakeKey])

  const lost = useCallback(() => keeperRef.current?.lost(), [])
  return { lease, lost }
}
