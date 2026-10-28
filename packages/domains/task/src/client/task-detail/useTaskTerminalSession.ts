import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import { getProviderLastKilledAt, decideReviveMode } from '@slayzone/task/shared'

import { SESSION_ID_COMMANDS, SESSION_ID_UNAVAILABLE } from '@slayzone/terminal/shared'
import { markSkipCache } from '@slayzone/terminal'
import { markForceStart, requestAgentStart } from '@slayzone/task-terminals'
import { useStableCallback } from '@slayzone/ui'
import { takeTaskPaneEvents } from '../taskPaneEvents'
import { readCurrentConversationId } from '../main-terminal-props'

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
  handleSwitchSession: (conversationId: string) => Promise<void>
  handleDeleteSession: (conversationId: string) => Promise<void>
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
  // `mutateAsync` only: it is stable for the hook's lifetime, while the useMutation()
  // result object is new on every render (see the persist effect below).
  const { mutateAsync: updateTask } = useMutation(trpc.task.update.mutationOptions())
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
    const updated = await updateTask({
      id: task.id,
      providerConfig: { [task.terminal_mode]: { conversationId: detectedSessionId } }
    })
    onTaskUpdated(updated)
    setDetectedSessionId(null)
  }, [task, detectedSessionId, onTaskUpdated, updateTask])

  const handleSyncSessionId = useStableCallback(() => {
    void handleUpdateSessionId()
  })

  // Cmd+Shift+U: sync detected session ID to DB (only when this task is active and banner is showing)
  useSubscription(
    trpc.menu.onSyncSessionId.subscriptionOptions(undefined, {
      enabled: !!shortcutActive,
      onData: handleSyncSessionId
    })
  )

  // Persist detected conversation IDs immediately for modes that need session
  // discovery. Deduped by a ref so the write fires EXACTLY ONCE per detected id.
  // This effect re-runs on every board refetch (`task` is a fresh object each time).
  // Persisting issues a task.update → server broadcasts task-updated → board refetch →
  // re-render. The old version started a NEW write on every such re-render and let the
  // cleanup's `cancelled` flag strand the terminal setDetectedSessionId(null), so the
  // write never cleared its own trigger → an infinite task.update loop that saturated
  // the tRPC WS app-wide (panels/terminals in OTHER tabs starved). The ref makes re-runs
  // no-ops while a write for the same id is outstanding, and the clear runs without a
  // cancel gate so the loop always terminates.
  // The deps must hold the stable `mutateAsync`, never the useMutation() result object:
  // that object is new on every render, and the mutation's own pending→error state
  // changes re-render this hook, so a failed write (ref reset for a retry) was re-issued
  // by the re-render its failure caused → an endless task.update retry loop. A failed
  // write now retries on the next real input change (e.g. the next board refetch).
  const persistedSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!task || !detectedSessionId || !sessionIdCommand) return
    if (getConversationIdForMode(task) === detectedSessionId) {
      // Stays in the effect (lint set-state-in-effect, accepted): the clear must
      // pair with the dedupe-ref reset (a ref write in render → Compiler skip),
      // and hiding the id instead of clearing it lets a stale id resurface after
      // "Start fresh" and be written back (phantom conv-id clobber).
      persistedSessionIdRef.current = null
      setDetectedSessionId(null)
      return
    }
    if (persistedSessionIdRef.current === detectedSessionId) return // write already issued for this id
    persistedSessionIdRef.current = detectedSessionId

    void (async () => {
      try {
        const updated = await updateTask({
          id: task.id,
          providerConfig: { [task.terminal_mode]: { conversationId: detectedSessionId } }
        })
        onTaskUpdated(updated)
      } catch {
        // Allow a retry on a transient failure.
        if (persistedSessionIdRef.current === detectedSessionId)
          persistedSessionIdRef.current = null
        return
      }
      // Clear regardless of render churn (no cancel gate — that's what stranded the
      // clear and spun the loop). Functional updater avoids clobbering a newer detect.
      setDetectedSessionId((cur) => (cur === detectedSessionId ? null : cur))
    })()
  }, [
    task,
    detectedSessionId,
    sessionIdCommand,
    onTaskUpdated,
    getConversationIdForMode,
    updateTask
  ])

  // Restart terminal (kill PTY, remount, keep session for --resume)
  const handleRestartTerminal = useCallback(async () => {
    if (!task) return
    const mainSessionId = getMainSessionId(task.id)
    resetTaskState(mainSessionId)
    // Claim the next TerminalStarter mount before killing: the kill's exit
    // handler records `agent_state='stopped'`, and the remount below would
    // otherwise decide from that and show the "Open <mode>" Start gate instead
    // of resuming.
    markForceStart(mainSessionId)
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

  // Reset terminal (kill PTY, clear session ID, remount fresh). Routes through
  // `task.resetConversation` (a `manual-reset` ledger write) — NOT a plain
  // provider_config null. The renderer's resume hint comes from the ledger-backed
  // `currentConversationByMode`; only a `session_resets` cutoff clears the honored
  // binding. Nulling provider_config alone left a phantom/stale id that survived
  // "Start fresh" and looped `--resume` on reopen. See conversation-healer.ts.
  const handleResetTerminal = useCallback(async () => {
    if (!task) return
    const mainSessionId = getMainSessionId(task.id)
    resetTaskState(mainSessionId)
    // See handleRestartTerminal — claim the next mount before the kill so the
    // recorded `stopped` state doesn't strand the user on the Start gate.
    markForceStart(mainSessionId)
    await trpcClient.pty.kill.mutate({ sessionId: mainSessionId })
    const updated = await trpcClient.task.resetConversation.mutate({
      id: task.id,
      mode: task.terminal_mode
    })
    onTaskUpdated(updated)
    await new Promise((r) => setTimeout(r, 100))
    markSkipCache(mainSessionId)
    setTerminalKey((k) => k + 1)
  }, [task, resetTaskState, onTaskUpdated, getMainSessionId, trpcClient, setTerminalKey])

  // Switch to an EARLIER session (sessions sidebar). Same kill→remount shape as
  // handleRestartTerminal — the difference is the mutation in the middle, which
  // appends a `user-selected` row so the ledger's honored "current" conversation
  // becomes the picked one BEFORE the remount reads it. That ordering is the
  // whole mechanism: the remounted terminal takes its resume hint from the task's
  // refreshed `currentConversationByMode`, so the respawn runs `--resume <picked>`
  // and the switch survives a reopen even if the agent never confirms.
  const handleSwitchSession = useCallback(
    async (conversationId: string) => {
      if (!task) return
      const mainSessionId = getMainSessionId(task.id)
      resetTaskState(mainSessionId)
      // See handleRestartTerminal — claim the next mount before the kill so the
      // recorded `stopped` state doesn't strand the user on the Start gate.
      markForceStart(mainSessionId)
      await trpcClient.pty.kill.mutate({ sessionId: mainSessionId })
      const updated = await trpcClient.task.switchConversation.mutate({
        id: task.id,
        mode: task.terminal_mode,
        conversationId
      })
      onTaskUpdated(updated)
      await new Promise((r) => setTimeout(r, 100))
      markSkipCache(mainSessionId)
      setTerminalKey((k) => k + 1)
    },
    [task, resetTaskState, onTaskUpdated, getMainSessionId, trpcClient, setTerminalKey]
  )

  // Delete a session from the task (sessions sidebar). No kill/remount: the
  // server refuses to delete the CURRENT session, so the live agent is never
  // running on what this removes. Only the task is refreshed — the sidebar list
  // itself refetches off `agentSessions.onChanged`.
  const handleDeleteSession = useCallback(
    async (conversationId: string) => {
      if (!task) return
      const updated = await trpcClient.task.deleteConversation.mutate({
        id: task.id,
        mode: task.terminal_mode,
        conversationId
      })
      onTaskUpdated(updated)
    },
    [task, onTaskUpdated, trpcClient]
  )

  // Revive: when main broadcasts pty:respawn-suggested for this task (after a
  // terminal → non-terminal status transition), remount the terminal so the user
  // can keep typing without clicking Retry. See GitHub issue #77.
  // Plain shell mode is skipped — no conversation model, respawning a shell would
  // surprise the user. Hot bounces resume the existing conversation; cold (>30 min)
  // bounces start a fresh one.
  const handleRespawnSuggested = useStableCallback(async ({ taskId }: { taskId: string }) => {
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
  })
  useSubscription(
    trpc.pty.onRespawnSuggested.subscriptionOptions(undefined, {
      enabled: !!task,
      onData: handleRespawnSuggested
    })
  )
  // A suggestion that arrived before this page mounted was held for it (see
  // taskPaneEvents.ts) — act on it now.
  const respawnTaskId = task?.id
  useEffect(() => {
    if (!respawnTaskId) return
    for (const ev of takeTaskPaneEvents(respawnTaskId, ['respawn-suggested'])) {
      if (ev.kind === 'respawn-suggested') void handleRespawnSuggested(ev.payload)
    }
  }, [respawnTaskId, handleRespawnSuggested])

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
  const handleEnsureAlive = useStableCallback(
    async ({ taskId, reqId, force }: { taskId: string; reqId: number; force: boolean }) => {
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
      const run = async (): Promise<void> => {
        if (force) {
          await handleRestartTerminal()
          result = 'ok'
        } else {
          // An explicit start (CLI cold-start): start the main agent whatever the
          // startup mode — a mounted TerminalStarter starts now, otherwise its
          // next mount does. <Terminal> then spawns via pty:create. Poll
          // pty.exists until alive or timeout.
          const sid = getMainSessionId(task.id)
          requestAgentStart(sid)
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
      }
      await run().finally(() => {
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
      })
    }
  )
  useSubscription(
    trpc.pty.onEnsureAlive.subscriptionOptions(undefined, {
      enabled: !!task,
      onData: handleEnsureAlive
    })
  )

  // Re-attach terminal (remount without killing PTY - reuses cached terminal)
  const handleReattachTerminal = useCallback(() => {
    if (!task) return
    setTerminalKey((k) => k + 1)
  }, [task, setTerminalKey])

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
    handleSwitchSession,
    handleDeleteSession,
    handleReattachTerminal
  }
}
