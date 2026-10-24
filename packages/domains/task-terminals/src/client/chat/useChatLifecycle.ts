import { useCallback, useEffect, useRef, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { toast } from '@slayzone/ui'
import type { ChatTimelineState } from '@slayzone/terminal/client'
import {
  agentStartsOnOpen,
  AGENT_STARTUP_SETTING,
  parseAgentStartupMode,
  type AgentState
} from '@slayzone/terminal/shared'
import { resetChat } from './autocomplete/chat-actions'
import type { ChatActions } from './autocomplete/types'

export interface UseChatLifecycleOpts {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  providerFlagsOverride?: string | null
  /** How this tab's agent last ended (`terminal_tabs.agent_state`). */
  agentState?: AgentState
  /** The task's main tab: the startup mode applies. Other chat tabs only restore
   *  an agent that was running. */
  isMain?: boolean
  isTemporary?: boolean
  chatApi: ChatActions
  inFlight: boolean
  hydrating: boolean
  state: ChatTimelineState
  resetTimeline: () => void
  setDraft: (value: string) => void
  clearQueue: () => Promise<void>
}

/**
 * Owns chat-session *lifecycle*: reset / restart, the derived "session ended"
 * display flag, and three fire-and-forget effects:
 *
 *   - Startup: once hydration settles, auto-call `chat.start` (idempotent) when the
 *     startup mode says this agent starts on open (`agentStartsOnOpen`) — e.g. a
 *     subprocess that was alive last time, so the user lands in a live session
 *     without typing. Covers clean shutdown AND crash recovery (`running` is kept
 *     across shutdown by design). Otherwise the chat spawns when the user types.
 *   - Clear the queue on session end / reset.
 *   - Diagnostic: log every `inFlight` transition (with the counters that drive
 *     it + the last 5 timeline kinds) so a stuck indicator leaves evidence.
 */
export function useChatLifecycle({
  tabId,
  taskId,
  mode,
  cwd,
  providerFlagsOverride,
  agentState = 'stopped',
  isMain = false,
  isTemporary = false,
  chatApi,
  inFlight,
  hydrating,
  state,
  resetTimeline,
  setDraft,
  clearQueue
}: UseChatLifecycleOpts) {
  const trpcClient = useTRPCClient()
  const [resetting, setResetting] = useState(false)
  const [restarting, setRestarting] = useState(false)
  // Suppress "Session ended" UI during a reset/restart — process-exit fires between kill and
  // the new session's turn-init, creating a brief flash of the ended state. Also suppress
  // on `notStarted` (lazy-mount with no spawn yet) — there's nothing to restart, and the
  // user can just type to trigger the first spawn.
  const displaySessionEnded = state.sessionEnded && !state.notStarted && !resetting && !restarting

  // Startup: decided once, against the state the tab was opened with (a later
  // exit must not restart it). Waits for hydration so the spawn carries the
  // conversation id.
  const [openState] = useState(() => ({ agentState, isMain, isTemporary }))
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (hydrating || autoStartedRef.current) return
    autoStartedRef.current = true
    // Not cancelled on re-render: the ref makes this one-shot, so a cancelled
    // query would never start the agent (`chatApi` identity can change per render).
    void trpcClient.settings.get
      .query({ key: AGENT_STARTUP_SETTING })
      .then((raw) => {
        const start = openState.isMain
          ? agentStartsOnOpen({
              mode: parseAgentStartupMode(raw),
              state: openState.agentState,
              isTemporary: openState.isTemporary
            })
          : openState.agentState === 'running'
        if (!start) return
        void chatApi.start({
          tabId,
          taskId,
          mode,
          cwd,
          providerFlagsOverride: providerFlagsOverride ?? null
        })
      })
      .catch(() => {
        /* best-effort — the chat still spawns when the user types */
      })
  }, [hydrating, openState, trpcClient, chatApi, tabId, taskId, mode, cwd, providerFlagsOverride])

  const handleRestart = useCallback(async () => {
    if (restarting) return
    setRestarting(true)
    try {
      // Explicit eager spawn — user clicked "Restart", they want a live
      // subprocess immediately. chat.start hydrates if needed then
      // ensureSpawned. chat.hydrate alone would leave the session lazy.
      await chatApi.start({
        tabId,
        taskId,
        mode,
        cwd,
        providerFlagsOverride: providerFlagsOverride ?? null
      })
    } catch (err) {
      toast(`Restart failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestarting(false)
    }
  }, [restarting, chatApi, tabId, taskId, mode, cwd, providerFlagsOverride])

  const handleReset = useCallback(async () => {
    if (resetting) return
    setResetting(true)
    // Clear timeline + ended-state immediately so UI re-enables input while new session spawns.
    resetTimeline()
    setDraft('')
    void clearQueue()
    try {
      await resetChat(
        chatApi,
        { tabId, taskId, mode, cwd, providerFlagsOverride: providerFlagsOverride ?? null },
        {
          interruptFirst: inFlight,
          onSuccess: () => toast('Chat reset'),
          onError: (err) =>
            toast(`Reset failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      )
    } catch {
      /* handled via onError */
    } finally {
      setResetting(false)
    }
  }, [
    resetting,
    inFlight,
    chatApi,
    tabId,
    taskId,
    mode,
    cwd,
    providerFlagsOverride,
    resetTimeline,
    clearQueue
  ])

  // Clear queue on session end / reset.
  useEffect(() => {
    if (state.sessionEnded) void clearQueue()
  }, [state.sessionEnded, clearQueue])

  // Diagnostic: log every inFlight transition (incl. baseline post-hydrate) with
  // the counters that drive `isInFlight` plus the last 5 timeline kinds. Captures
  // evidence next time the indicator gets stuck without forcing a repro.
  const prevInFlightRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (hydrating) return
    const prev = prevInFlightRef.current
    prevInFlightRef.current = inFlight
    if (prev === inFlight) return
    try {
      void trpcClient.diagnostics.recordClientEvent
        .mutate({
          event: 'renderer.chat.inFlight.flip',
          level: 'info',
          message: `inFlight ${prev ?? 'init'}→${inFlight}`,
          taskId,
          sessionId: state.sessionId,
          payload: {
            tabId,
            mode,
            from: prev,
            to: inFlight,
            userMessagesSent: state.userMessagesSent,
            resultCount: state.resultCount,
            sessionEnded: state.sessionEnded,
            timelineLen: state.timeline.length,
            lastEventKinds: state.timeline.slice(-5).map((it) => it.kind)
          }
        })
        .catch(() => {
          /* diagnostics never escalate */
        })
    } catch {
      /* diagnostics never escalate */
    }
  }, [
    inFlight,
    hydrating,
    tabId,
    taskId,
    mode,
    state.sessionId,
    state.userMessagesSent,
    state.resultCount,
    state.sessionEnded,
    state.timeline,
    trpcClient
  ])

  return { resetting, restarting, displaySessionEnded, handleReset, handleRestart }
}
