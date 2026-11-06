/**
 * Keep a terminal's direct link (direct-pty.ts) running while it is mounted.
 * The hub this terminal belongs to issues the capabilities; its manager is shared
 * by every terminal of that hub (one socket per computer).
 */
import { useEffect } from 'react'
import {
  directLinkManagerFor,
  isDirectLinkEnabled,
  useHubId,
  type DirectLinkHubClient
} from '@slayzone/transport/client'
import { ptyBufferSince, startDirectPtyLink } from './direct-pty'
import { usePty } from './PtyContext'
import { useTerminalStateStore } from './useTerminalStateStore'
import { useTRPCClient } from './trpc'
import { DIRECT_LINK_DEFAULT_HUB_ID } from '@slayzone/platform/electron-bootstrap-contract'

export function useDirectPtyLink(sessionId: string): void {
  const trpcClient = useTRPCClient()
  const hubId = useHubId() ?? DIRECT_LINK_DEFAULT_HUB_ID
  const { deliver, getLastSeq } = usePty()
  useEffect(() => {
    // A host that installed no probe (web shell, fork) stays on the relay.
    if (!isDirectLinkEnabled()) return
    const manager = directLinkManagerFor(hubId, trpcClient as unknown as DirectLinkHubClient)
    return startDirectPtyLink({
      sessionId,
      manager,
      // A gap is read back from wherever the session is now (direct, else the hub).
      deliver: (data, seq) =>
        deliver(sessionId, data, seq, (afterSeq) =>
          ptyBufferSince(trpcClient, sessionId, afterSeq).then((b) => b?.chunks ?? [])
        ),
      lastSeq: () => getLastSeq(sessionId),
      // Retry when the session's state moves (it started, restarted): a terminal
      // mounts before its process exists.
      wake: (cb) =>
        useTerminalStateStore.subscribe(
          (s) => s.byId[sessionId],
          () => cb()
        )
    })
  }, [sessionId, hubId, trpcClient, deliver, getLastSeq])
}
