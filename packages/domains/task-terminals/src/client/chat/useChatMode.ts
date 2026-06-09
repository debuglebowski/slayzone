import { useCallback, useEffect, useRef, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { toast, type AgentMode, type AutoModeCapability } from '@slayzone/ui'
import { rawPermissionModeToChatMode } from '@slayzone/terminal/shared'

/**
 * Minimal ChatSessionInfo shape — kept inline (instead of importing the full
 * type) to avoid pulling @slayzone/types into task-terminals just for one
 * field. Only `chatMode` is read here; other fields are intentionally untyped.
 */
interface SessionInfoLite {
  chatMode?: AgentMode | null
}

interface UseChatModeOpts {
  taskId: string
  mode: string
  tabId: string
  cwd: string
  /**
   * Live raw permission mode from the running subprocess (via `useChatSession`).
   * Drives drift sync via transition tracking — applied only when value
   * *changes* from last-applied, never on stale renders. Updated on session
   * start / kill+respawn (turn-init).
   */
  livePermissionMode?: string | null
}

/**
 * Owns chat-permission-mode state. Hybrid optimistic / server-authoritative:
 *
 *   - Mount hydration: prefer `chat:getInfo` (in-memory `Session.chatMode`,
 *     fresher than DB) → fall back to `chat:getMode` (DB cache) when no
 *     session exists yet.
 *   - User-driven change: paint the new mode optimistically so the pill never
 *     blocks on the IPC roundtrip. Bypass kill+respawn takes 1-3s; live
 *     `set_permission_mode` control_request takes ms. While an IPC is in
 *     flight, additional clicks update `pendingModeRef` and the optimistic
 *     state — the loop in `handleModeChange` picks up the latest target on
 *     each iteration. Backend stays serialized one-IPC-at-a-time per tab,
 *     avoiding kill+respawn races.
 *   - Server-resolved value still wins on the *latest* IPC: a server downgrade
 *     (e.g. `auto` → `auto-accept` when capability is missing) overrides the
 *     optimistic guess only when the user hasn't superseded.
 *   - On IPC error we revert to the previous *confirmed* mode and toast. The
 *     subprocess state may be uncertain after a failed respawn; drift sync via
 *     `livePermissionMode` re-converges on the next turn-init.
 *   - External drift: `livePermissionMode` transitions (not equality checks)
 *     update state. `pendingModeRef` skips drift while a user-driven change
 *     is in flight — the dying session may emit a final livePermissionMode
 *     before the new subprocess's turn-init lands.
 *
 * Extracted from ChatPanel to keep the panel component focused on layout and
 * keep mode wiring testable in isolation.
 */
export function useChatMode({ taskId, mode, tabId, cwd, livePermissionMode }: UseChatModeOpts) {
  const trpcClient = useTRPCClient()
  const [chatMode, setChatModeState] = useState<AgentMode>('auto-accept')
  const [autoCapability, setAutoCapability] = useState<AutoModeCapability>({
    eligible: false,
    optedIn: false
  })
  const lastAppliedLiveRef = useRef<string | null | undefined>(undefined)
  // Latest user-requested target. Updated synchronously on every click so the
  // loop in `handleModeChange` always picks up the freshest intent.
  const pendingModeRef = useRef<AgentMode | null>(null)
  // Synchronous gate. Without a ref two near-simultaneous clicks both see no
  // active loop and start parallel ones, racing the backend respawn path.
  const loopRunningRef = useRef(false)
  // Last server-confirmed mode. Used to revert on IPC error regardless of how
  // many supersede iterations the loop went through.
  const confirmedModeRef = useRef<AgentMode>('auto-accept')

  // Hydrate on mount. Live session > DB cache.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = (await trpcClient.chat.getInfo.query({ tabId })) as SessionInfoLite | null
        if (cancelled) return
        if (info?.chatMode) {
          setChatModeState(info.chatMode)
          confirmedModeRef.current = info.chatMode
          return
        }
        const cached = (await trpcClient.chat.getMode.query({ taskId, mode })) as AgentMode
        if (!cancelled) {
          setChatModeState(cached)
          confirmedModeRef.current = cached
        }
      } catch {
        /* keep default */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, mode, tabId])

  // Drift sync: apply live permission mode only on transitions. A stale
  // render where livePermissionMode equals the last-applied value is a no-op,
  // so it cannot revert an optimistically-pending or freshly-confirmed mode
  // change. `pendingModeRef` skips drift while a user-driven change is in
  // flight — the dying session may emit a final livePermissionMode before the
  // new subprocess's turn-init lands.
  useEffect(() => {
    if (livePermissionMode === lastAppliedLiveRef.current) return
    lastAppliedLiveRef.current = livePermissionMode
    if (pendingModeRef.current !== null) return
    const mapped = rawPermissionModeToChatMode(livePermissionMode) as AgentMode | null
    if (mapped && mapped !== chatMode) {
      setChatModeState(mapped)
      confirmedModeRef.current = mapped
    }
  }, [livePermissionMode, chatMode])

  useEffect(() => {
    let cancelled = false
    void trpcClient.chat.getAutoEligibility
      .query()
      .then((cap) => {
        if (!cancelled) setAutoCapability(cap)
      })
      .catch(() => {
        /* keep default (hidden) */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleModeChange = useCallback(
    async (next: AgentMode) => {
      if (next === chatMode) return
      if (next === 'auto' && !autoCapability.optedIn) {
        toast('Auto mode requires Max/Team/Enterprise + opt-in via `claude` CLI')
        return
      }
      // Optimistic flip happens on every click, regardless of in-flight IPCs.
      // The loop below picks up `pendingModeRef` as the latest target.
      pendingModeRef.current = next
      setChatModeState(next)

      // Loop already running? Just update the target ref and return; the active
      // loop will fire a new IPC for the latest target on its next iteration.
      // Keeps backend serialized one-IPC-at-a-time per tab.
      if (loopRunningRef.current) return
      loopRunningRef.current = true

      const prev = confirmedModeRef.current
      let lastError: unknown = null
      try {
        while (pendingModeRef.current !== null) {
          const target: AgentMode = pendingModeRef.current
          let info: SessionInfoLite
          try {
            info = (await trpcClient.chat.setMode.mutate({
              tabId,
              taskId,
              mode,
              cwd,
              chatMode: target
            })) as SessionInfoLite
          } catch (err) {
            lastError = err
            break
          }
          // Did the user supersede during the await? If so, drop the response
          // and loop again with the new target.
          if (pendingModeRef.current !== target) continue
          // Latest target — apply server resolution (may downgrade) and exit.
          const resolved = info?.chatMode ?? target
          setChatModeState(resolved)
          confirmedModeRef.current = resolved
          pendingModeRef.current = null
        }
      } finally {
        loopRunningRef.current = false
        pendingModeRef.current = null
      }
      if (lastError !== null) {
        // Revert to the last confirmed mode; subprocess state may be uncertain
        // after a failed respawn but drift sync re-converges on the next
        // turn-init.
        setChatModeState(prev)
        toast(
          `Mode change failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        )
        // Re-throw so callers awaiting the mode change can branch on success
        // (e.g. ExitPlanMode "Approve & exit" sends "Approved" only if the mode
        // actually flipped).
        throw lastError
      }
    },
    [chatMode, autoCapability.optedIn, tabId, taskId, mode, cwd, trpcClient]
  )

  return { chatMode, handleModeChange, autoCapability }
}
