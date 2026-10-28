import { useCallback, useEffect, useRef, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { toast } from '@slayzone/ui'
import type { ChatTimelineState } from '@slayzone/terminal/client'
import {
  agentStartsOnOpen,
  AGENT_STARTUP_SETTING,
  parseAgentStartupMode,
  type AgentState
} from '@slayzone/terminal-contracts'
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
  /** Task view on screen. Off screen (tab-bar restore on reload/restart) the
   *  startup mode only restores what `auto` would; the rest waits until shown. */
  shown?: boolean
  chatApi: ChatActions
  inFlight: boolean
  hydrating: boolean
  state: ChatTimelineState
  resetTimeline: () => void
  setDraft: (value: string) => void
  clearQueue: () => Promise<void>
}

type ChatTarget = {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  providerFlagsOverride: string | null
}

// Imperative bodies live outside the hook: the React Compiler cannot lower
// `finally` clauses or value blocks inside try/catch, so keeping them here lets
// the hook itself compile.
async function restartChat(
  chatApi: ChatActions,
  target: ChatTarget,
  setRestarting: (v: boolean) => void
): Promise<void> {
  setRestarting(true)
  try {
    // Explicit eager spawn — user clicked "Restart", they want a live
    // subprocess immediately. chat.start hydrates if needed then
    // ensureSpawned. chat.hydrate alone would leave the session lazy.
    await chatApi.start(target)
  } catch (err) {
    toast(`Restart failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    setRestarting(false)
  }
}

async function runChatReset(
  chatApi: ChatActions,
  target: ChatTarget,
  inFlight: boolean,
  setResetting: (v: boolean) => void
): Promise<void> {
  try {
    await resetChat(chatApi, target, {
      interruptFirst: inFlight,
      onSuccess: () => toast('Chat reset'),
      onError: (err) => toast(`Reset failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  } catch {
    /* handled via onError */
  } finally {
    setResetting(false)
  }
}

function recordInFlightFlip(
  trpcClient: ReturnType<typeof useTRPCClient>,
  prev: boolean | null,
  inFlight: boolean,
  { tabId, taskId, mode }: { tabId: string; taskId: string; mode: string },
  state: ChatTimelineState
): void {
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
  shown = true,
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
  // 'now' = start, 'shown' = start once the task is on screen (effect below).
  const [startDecision, setStartDecision] = useState<'now' | 'shown' | null>(null)
  useEffect(() => {
    if (hydrating || autoStartedRef.current) return
    autoStartedRef.current = true
    // Not cancelled on re-render: the ref makes this one-shot, so a cancelled
    // query would never start the agent (`chatApi` identity can change per render).
    void trpcClient.settings.get
      .query({ key: AGENT_STARTUP_SETTING })
      .then((raw) => {
        if (!openState.isMain) {
          if (openState.agentState === 'running') setStartDecision('now')
          return
        }
        const rule = {
          mode: parseAgentStartupMode(raw),
          state: openState.agentState,
          isTemporary: openState.isTemporary
        }
        if (agentStartsOnOpen({ ...rule, shown: false })) setStartDecision('now')
        else if (agentStartsOnOpen({ ...rule, shown: true })) setStartDecision('shown')
      })
      .catch(() => {
        /* best-effort — the chat still spawns when the user types */
      })
  }, [hydrating, openState, trpcClient])
  const startFiredRef = useRef(false)
  useEffect(() => {
    if (startDecision === null || (startDecision === 'shown' && !shown)) return
    if (startFiredRef.current) return
    startFiredRef.current = true
    void chatApi.start({
      tabId,
      taskId,
      mode,
      cwd,
      providerFlagsOverride: providerFlagsOverride ?? null
    })
  }, [startDecision, shown, chatApi, tabId, taskId, mode, cwd, providerFlagsOverride])

  const handleRestart = useCallback(async () => {
    if (restarting) return
    await restartChat(
      chatApi,
      { tabId, taskId, mode, cwd, providerFlagsOverride: providerFlagsOverride ?? null },
      setRestarting
    )
  }, [restarting, chatApi, tabId, taskId, mode, cwd, providerFlagsOverride])

  const handleReset = useCallback(async () => {
    if (resetting) return
    setResetting(true)
    // Clear timeline + ended-state immediately so UI re-enables input while new session spawns.
    resetTimeline()
    setDraft('')
    void clearQueue()
    await runChatReset(
      chatApi,
      { tabId, taskId, mode, cwd, providerFlagsOverride: providerFlagsOverride ?? null },
      inFlight,
      setResetting
    )
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
    setDraft,
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
    recordInFlightFlip(trpcClient, prev, inFlight, { tabId, taskId, mode }, state)
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
