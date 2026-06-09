import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import { getProviderLastKilledAt, decideReviveMode } from '@slayzone/task/shared'

/**
 * Renderer-side conversation id read. Reads the server-computed
 * `currentConversationByMode` field which goes through the append-only
 * `task_conversations` ledger (honors manual-reset cutoff + provenance gate).
 *
 * Direct access to `provider_config.{mode}.conversationId` from the renderer
 * is rejected by the `lint:server-boundary` guard — that path bypasses the
 * provenance check and would re-introduce the clobber bug class.
 */
function readCurrentConversationId(
  task: Task | null | undefined,
  mode: string | undefined
): string | null {
  if (!task || !mode) return null
  return task.currentConversationByMode?.[mode] ?? null
}
import { SESSION_ID_COMMANDS, SESSION_ID_UNAVAILABLE } from '@slayzone/terminal/shared'
import { markSkipCache } from '@slayzone/terminal'

export interface UseTaskTerminalSessionParams {
  task: Task | null
  onTaskUpdated: (task: Task) => void
  shortcutActive: boolean | undefined
  getMainSessionId: (id: string) => string
  resetTaskState: (sessionId: string) => void
  subscribeSessionDetected: (sessionId: string, cb: (sessionId: string) => void) => () => void
  setTerminalKey: React.Dispatch<React.SetStateAction<number>>
}

export interface UseTaskTerminalSessionResult {
  sessionIdCommand: string | undefined
  showSessionBanner: boolean
  showUnavailableBanner: boolean
  detectedSessionId: string | null
  setSessionUnavailableDismissed: React.Dispatch<React.SetStateAction<string | null>>
  handleDetectSessionId: () => Promise<void>
  getConversationIdForMode: (t: Task) => string | null
  handleUpdateSessionId: () => Promise<void>
  handleRestartTerminal: () => Promise<void>
  handleStopAgent: () => Promise<void>
  handleResetTerminal: () => Promise<void>
  handleReattachTerminal: () => void
}

/**
 * Terminal session lifecycle: session-id discovery (detect/sync/persist), restart/reset/stop,
 * revive-on-respawn, and the CLI ensure-alive coalescing. Owns `detectedSessionId`; drives the
 * terminal remount via the `setTerminalKey` setter passed in by the parent.
 */
export function useTaskTerminalSession({
  task,
  onTaskUpdated,
  shortcutActive,
  getMainSessionId,
  resetTaskState,
  subscribeSessionDetected,
  setTerminalKey
}: UseTaskTerminalSessionParams): UseTaskTerminalSessionResult {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const updateTask = useMutation(trpc.task.update.mutationOptions())
  // Detected session ID from /status command
  const [detectedSessionId, setDetectedSessionId] = useState<string | null>(null)

  // Session ID discovery: providers that don't support --session-id at creation
  const sessionIdCommand = task ? SESSION_ID_COMMANDS[task.terminal_mode] : undefined
  const showSessionBanner =
    !!sessionIdCommand &&
    !!task &&
    !readCurrentConversationId(task, task.terminal_mode) &&
    !detectedSessionId

  // Providers where session ID detection is not possible
  const sessionIdUnavailable = !!task && SESSION_ID_UNAVAILABLE.includes(task.terminal_mode)
  const [sessionUnavailableDismissed, setSessionUnavailableDismissed] = useState<string | null>(
    null
  )
  const showUnavailableBanner =
    sessionIdUnavailable &&
    !readCurrentConversationId(task, task?.terminal_mode) &&
    sessionUnavailableDismissed !== task?.id

  const handleDetectSessionId = useCallback(async () => {
    if (!task || !sessionIdCommand) return
    const sid = getMainSessionId(task.id)
    const exists = await trpcClient.pty.exists.query({ sessionId: sid })
    if (!exists) return
    await trpcClient.pty.write.mutate({ sessionId: sid, data: sessionIdCommand + '\r' })
  }, [task, sessionIdCommand, getMainSessionId, trpcClient])

  const getConversationIdForMode = useCallback((t: Task): string | null => {
    return readCurrentConversationId(t, t.terminal_mode)
  }, [])

  // Subscribe to session detected events
  useEffect(() => {
    if (!task) return
    return subscribeSessionDetected(getMainSessionId(task.id), (id) => {
      const current = getConversationIdForMode(task)
      if (id !== current) {
        setDetectedSessionId(id)
      }
    })
  }, [task, subscribeSessionDetected, getMainSessionId, getConversationIdForMode])

  // Update DB with detected session ID
  const handleUpdateSessionId = useCallback(async () => {
    if (!task || !detectedSessionId) return
    const updated = await updateTask.mutateAsync({
      id: task.id,
      providerConfig: { [task.terminal_mode]: { conversationId: detectedSessionId } }
    })
    onTaskUpdated(updated)
    setDetectedSessionId(null)
  }, [task, detectedSessionId, onTaskUpdated, updateTask])

  const handleUpdateSessionIdRef = useRef(handleUpdateSessionId)
  useEffect(() => {
    handleUpdateSessionIdRef.current = handleUpdateSessionId
  }, [handleUpdateSessionId])

  // Cmd+Shift+U: sync detected session ID to DB (only when this task is active and banner is showing)
  useSubscription(
    trpc.menu.onSyncSessionId.subscriptionOptions(undefined, {
      enabled: !!shortcutActive,
      onData: () => {
        void handleUpdateSessionIdRef.current()
      }
    })
  )

  // Persist detected conversation IDs immediately for modes that need session discovery.
  useEffect(() => {
    if (!task || !detectedSessionId || !sessionIdCommand) return
    if (getConversationIdForMode(task) === detectedSessionId) {
      setDetectedSessionId(null)
      return
    }

    let cancelled = false
    void (async () => {
      const updated = await updateTask.mutateAsync({
        id: task.id,
        providerConfig: { [task.terminal_mode]: { conversationId: detectedSessionId } }
      })
      if (cancelled) return
      onTaskUpdated(updated)
      setDetectedSessionId(null)
    })()

    return () => {
      cancelled = true
    }
  }, [task, detectedSessionId, sessionIdCommand, onTaskUpdated, getConversationIdForMode, updateTask])

  // Restart terminal (kill PTY, remount, keep session for --resume)
  const handleRestartTerminal = useCallback(async () => {
    if (!task) return
    const mainSessionId = getMainSessionId(task.id)
    resetTaskState(mainSessionId)
    await trpcClient.pty.kill.mutate({ sessionId: mainSessionId })
    await new Promise((r) => setTimeout(r, 100))
    markSkipCache(mainSessionId)
    setTerminalKey((k) => k + 1)
  }, [task, resetTaskState, getMainSessionId, trpcClient, setTerminalKey])

  // Power-off agent (kill PTY only — no remount; user clicks Retry to resume)
  const handleStopAgent = useCallback(async () => {
    if (!task) return
    const mainSessionId = getMainSessionId(task.id)
    resetTaskState(mainSessionId)
    await trpcClient.pty.kill.mutate({ sessionId: mainSessionId })
  }, [task, resetTaskState, getMainSessionId, trpcClient])

  // Reset terminal (kill PTY, clear session ID, remount fresh)
  const handleResetTerminal = useCallback(async () => {
    if (!task) return
    const mainSessionId = getMainSessionId(task.id)
    resetTaskState(mainSessionId)
    await trpcClient.pty.kill.mutate({ sessionId: mainSessionId })
    // Clear session ID so new session starts fresh
    const updated = await updateTask.mutateAsync({
      id: task.id,
      providerConfig: { [task.terminal_mode]: { conversationId: null } }
    })
    onTaskUpdated(updated)
    await new Promise((r) => setTimeout(r, 100))
    markSkipCache(mainSessionId)
    setTerminalKey((k) => k + 1)
  }, [task, resetTaskState, onTaskUpdated, getMainSessionId, trpcClient, updateTask, setTerminalKey])

  // Revive: when main broadcasts pty:respawn-suggested for this task (after a
  // terminal → non-terminal status transition), remount the terminal so the user
  // can keep typing without clicking Retry. See GitHub issue #77.
  // Plain shell mode is skipped — no conversation model, respawning a shell would
  // surprise the user. Hot bounces resume the existing conversation; cold (>30 min)
  // bounces start a fresh one.
  useSubscription(
    trpc.pty.onRespawnSuggested.subscriptionOptions(undefined, {
      enabled: !!task,
      onData: async ({ taskId }) => {
        if (!task) return
        if (taskId !== task.id) return
        if (task.terminal_mode === 'terminal') return
        const sid = getMainSessionId(task.id)
        // Idempotent: if a PTY is already alive, another listener (or the user) beat
        // us to it — skip to avoid a double-spawn.
        try {
          if (await trpcClient.pty.exists.query({ sessionId: sid })) return
        } catch {
          return
        }
        const killedAt = getProviderLastKilledAt(task.provider_config, task.terminal_mode)
        // Unknown kill time defaults to RESUME (non-destructive). A cold start is
        // destructive — it clears the conversation id — so it requires positive
        // evidence the task sat past the threshold. See decideReviveMode / RC2.
        if (decideReviveMode(killedAt, Date.now()) === 'fresh') {
          await handleResetTerminal()
        } else {
          await handleRestartTerminal()
        }
      }
    })
  )

  // Ensure-alive: CLI-triggered (`slay pty respawn` w/ force=true, or
  // `slay pty start` / `slay tasks open --start` / auto-start w/ force=false).
  // Each REST call gets a unique reqId from main. We dedupe stale retries
  // (race: ack in-flight while main fires one more retry) by tracking handled
  // reqIds. Concurrent reqIds arriving during an in-flight run are coalesced —
  // they all receive the current run's outcome (idempotent).
  const ensureAliveInFlightRef = useRef(false)
  const ensureAlivePendingReqsRef = useRef<Set<number>>(new Set())
  const ensureAliveHandledReqsRef = useRef<number[]>([])
  // The `pty.onEnsureAlive` subscription and the `pty.ackEnsureAlive` mutation
  // share the same main-process pty emitter/ops, so the reqId received here is
  // the same one main expects on the ack round-trip.
  useSubscription(
    trpc.pty.onEnsureAlive.subscriptionOptions(undefined, {
      enabled: !!task,
      onData: async ({ taskId, reqId, force }) => {
        if (!task) return
        if (taskId !== task.id) return
        // Stale retry for an already-completed reqId — re-ack idempotently.
        if (ensureAliveHandledReqsRef.current.includes(reqId)) {
          void trpcClient.pty.ackEnsureAlive.mutate({ reqId, result: 'ok' })
          return
        }
        // Fast path for non-forced ensure when PTY already alive — no work, no
        // coalescing. Main's `hasPty` short-circuit usually catches this before
        // the broadcast, but a race during spawn can land us here.
        if (!force) {
          const sid = getMainSessionId(task.id)
          try {
            if (await trpcClient.pty.exists.query({ sessionId: sid })) {
              ensureAliveHandledReqsRef.current.push(reqId)
              void trpcClient.pty.ackEnsureAlive.mutate({ reqId, result: 'already-alive' })
              return
            }
          } catch {
            void trpcClient.pty.ackEnsureAlive.mutate({ reqId, result: 'error' })
            return
          }
        }
        // In-flight: coalesce. The current run's result will ack this reqId too.
        if (ensureAliveInFlightRef.current) {
          ensureAlivePendingReqsRef.current.add(reqId)
          return
        }
        ensureAliveInFlightRef.current = true
        ensureAlivePendingReqsRef.current.add(reqId)
        let result: 'ok' | 'error' = 'error'
        try {
          if (force) {
            await handleRestartTerminal()
            result = 'ok'
          } else {
            // Server has flipped `terminal_tabs.was_spawned=1` and broadcast
            // `tabs:changed`, so useTaskTerminals will re-fetch and TerminalStarter
            // will auto-mount <Terminal>, which spawns via pty:create IPC. Poll
            // pty.exists until alive or timeout.
            const sid = getMainSessionId(task.id)
            const deadline = Date.now() + 5000
            while (Date.now() < deadline) {
              try {
                if (await trpcClient.pty.exists.query({ sessionId: sid })) {
                  result = 'ok'
                  break
                }
              } catch {
                break
              }
              await new Promise((r) => setTimeout(r, 100))
            }
          }
        } finally {
          const reqs = [...ensureAlivePendingReqsRef.current]
          ensureAlivePendingReqsRef.current.clear()
          for (const r of reqs) {
            ensureAliveHandledReqsRef.current.push(r)
            void trpcClient.pty.ackEnsureAlive.mutate({ reqId: r, result })
          }
          if (ensureAliveHandledReqsRef.current.length > 100) {
            ensureAliveHandledReqsRef.current = ensureAliveHandledReqsRef.current.slice(-50)
          }
          ensureAliveInFlightRef.current = false
        }
      }
    })
  )

  // Re-attach terminal (remount without killing PTY - reuses cached terminal)
  const handleReattachTerminal = useCallback(() => {
    if (!task) return
    setTerminalKey((k) => k + 1)
  }, [task])

  return {
    sessionIdCommand,
    showSessionBanner,
    showUnavailableBanner,
    detectedSessionId,
    setSessionUnavailableDismissed,
    handleDetectSessionId,
    getConversationIdForMode,
    handleUpdateSessionId,
    handleRestartTerminal,
    handleStopAgent,
    handleResetTerminal,
    handleReattachTerminal
  }
}
