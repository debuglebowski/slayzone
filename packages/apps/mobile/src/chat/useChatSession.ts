/**
 * One chat tab's live session on its hub: the timeline (desktop's reducer), kept in
 * step by `ChatSync`, and the calls that act on the tab. Must sit inside the `HubScope`
 * of the hub that owns the task. Desktop's counterpart:
 * `packages/domains/terminal/src/client/useChatSession.ts`.
 *
 * Lifecycle:
 * 1. Subscribe `chat.onEvent({tabIds:[tabId]})` — filtered on the hub, never the hub's
 *    whole chat traffic. Its `onStarted` (the hub has the subscription; tRPC sends it
 *    again on every reconnect) starts a load, so no event can slip between the load's
 *    snapshot and the subscription:
 *      - first: `chat.hydrate` (loads the persisted history into a skeleton on the
 *        hub; spawns nothing), then `chat.getReplay` from -1;
 *      - after a reconnect: `chat.getReplay` after the newest applied event (catch-up),
 *        or a full load when a reply was streaming (its fragments cannot be merged) or
 *        the hub's log went backwards.
 *    Events arriving meanwhile are queued and applied after, deduped by seq.
 * 2. `chat.onExit` (unfiltered on the hub; filtered here) ends the process state.
 * 3. The agent process starts lazily on the first send (`chat.send` spawns it).
 * 4. Unmount: unsubscribe only. The session lives on in the hub.
 */
import {
  type ChatAttachment,
  chatCapabilitiesForMode,
  type PermissionDecision,
  type StopResult
} from '@slayzone/terminal-contracts'
import {
  type ChatTimelineState,
  initialState,
  isTurnOpen,
  reducer
} from '@slayzone/terminal/reducer'
import { useSubscription } from '@slayzone/transport/client'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { messageContent } from './attachments'
import { ChatSync, type ChatWireEvent, type ChatWireExit, type LocalMessage } from './chat-sync'
import { newMessageId } from './ids'
import { useStableCallback } from './useStableCallback'
import { useTRPC, useTRPCClient } from '../trpc'

/** What identifies the tab on its hub (`chat.hydrate`'s input, `chatCreateOpts`). */
export interface ChatTarget {
  tabId: string
  taskId: string
  mode: string
  /** The folder the tab runs in (`chat-cwd.ts`): the hub keys the tab by it. */
  cwd: string
  /** Null: the hub falls back to the task's own flags, as desktop's override does. */
  providerFlagsOverride: string | null
}

export interface ChatSessionApi {
  state: ChatTimelineState
  inFlight: boolean
  /** No load has finished yet (the first paint waits for the history). */
  hydrating: boolean
  /** Why the last load failed; null = it did not. */
  loadError: string | null
  /** Load the whole history again. */
  reload: () => void
  /** Request ids whose answer is on its way (their buttons are disabled). */
  submittingPrompts: ReadonlySet<string>
  /** Shows at once, tracked to delivery; a failure stays on screen with Retry. */
  sendMessage: (text: string, files?: readonly ChatAttachment[]) => Promise<void>
  /** Send a failed message again (same id: never delivered twice). */
  retryMessage: (id: string) => Promise<void>
  /** False when the request is no longer pending (or its answer is already on its way). */
  respondPermission: (args: {
    requestId: string
    decision: PermissionDecision
    optionId?: string
  }) => Promise<boolean>
  interrupt: () => Promise<void>
  /** Stop the turn; when nothing came back yet the message is withdrawn (`popped`). */
  abortAndPop: () => Promise<StopResult>
  /** Clear the timeline here at once (before a reset this client asked for). */
  resetLocal: () => void
}

/** The next animation frame (a timer where there is none). */
function requestFrame(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => cb())
  return setTimeout(cb, 16) as unknown as number
}
function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Messages this client sent that the hub may not have (kept across a full reload). */
function localMessages(state: ChatTimelineState): LocalMessage[] {
  const out: LocalMessage[] = []
  for (const it of state.timeline) {
    if (it.kind !== 'user-text' || !it.id) continue
    if (it.optimistic || it.delivery === 'failed') {
      out.push({
        id: it.id,
        text: it.text,
        failed: it.delivery === 'failed' ? (it.deliveryError ?? 'Not sent') : null
      })
    }
  }
  return out
}

/** A reply is streaming: its fragments can only be redrawn from scratch. */
function streaming(state: ChatTimelineState): boolean {
  return state.currentStreamMessageId !== null || state.openBlocks.size > 0 || state.live.length > 0
}

export function useChatSession(target: ChatTarget): ChatSessionApi {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  // Whether the provider starts turns by itself decides what reads as working.
  const [state, dispatch] = useReducer(reducer, target.mode, (mode: string) =>
    initialState({ agentStartedTurns: chatCapabilitiesForMode(mode).agentStartedTurns })
  )
  useEffect(() => {
    dispatch({
      type: 'configure',
      agentStartedTurns: chatCapabilitiesForMode(target.mode).agentStartedTurns
    })
  }, [target.mode])
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  const [hydrating, setHydrating] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // One engine per mounted tab (the caller keys this hook's component by tab + folder).
  const [sync] = useState(() => {
    let frame: number | null = null
    const engine: ChatSync = new ChatSync(target.tabId, {
      dispatch,
      requestFrame: () => {
        frame = requestFrame(() => {
          frame = null
          engine.flush()
        })
      },
      cancelFrame: () => {
        if (frame !== null) cancelFrame(frame)
        frame = null
      }
    })
    return engine
  })
  useEffect(() => () => sync.dispose(), [sync])

  const { tabId, taskId, mode, cwd, providerFlagsOverride } = target
  const load = useCallback(
    async (first: 'full' | 'catch-up'): Promise<void> => {
      // A catch-up that finds the hub's log went backwards asks for a full load.
      for (let kind = first; ; kind = 'full') {
        const keep = kind === 'full' ? localMessages(stateRef.current) : []
        const ticket = sync.beginLoad(kind)
        if (kind === 'full') {
          try {
            await trpcClient.chat.hydrate.mutate({
              tabId,
              taskId,
              mode,
              cwd,
              providerFlagsOverride
            })
          } catch (err) {
            // Shown in the chat (desktop does the same); the replay may still work.
            if (sync.isCurrent(ticket)) {
              dispatch({ type: 'event', event: { kind: 'error', message: message(err) } })
            }
          }
        }
        let replay: Awaited<ReturnType<typeof trpcClient.chat.getReplay.query>>
        try {
          replay = await trpcClient.chat.getReplay.query({ tabId, afterSeq: ticket.afterSeq })
        } catch (err) {
          if (sync.failLoad(ticket) === 'done') {
            setLoadError(message(err))
            setHydrating(false)
          }
          return
        }
        const result = sync.completeLoad(ticket, replay, keep)
        if (result === 'reload') continue
        if (result === 'done') {
          setLoadError(null)
          setHydrating(false)
        }
        return
      }
    },
    [sync, trpcClient, tabId, taskId, mode, cwd, providerFlagsOverride]
  )

  // The subscription's handlers: fixed identities, run the latest code (they read refs).
  const onStarted = useStableCallback(() => {
    // First start: the whole history. A restart (reconnect): only what is new, unless
    // a reply was streaming when the socket dropped.
    const kind = !sync.loadedOnce || streaming(stateRef.current) ? 'full' : 'catch-up'
    void load(kind)
  })
  const onEvent = useStableCallback((msg: ChatWireEvent) => {
    // The log restarted elsewhere (a reset from another client): load it again.
    if (sync.receive(msg) === 'regressed') void load('full')
  })
  useSubscription(
    trpc.chat.onEvent.subscriptionOptions({ tabIds: [tabId] }, { onStarted, onData: onEvent })
  )
  const onExit = useCallback((msg: ChatWireExit) => sync.exit(msg), [sync])
  useSubscription(trpc.chat.onExit.subscriptionOptions(undefined, { onData: onExit }))

  const sendMessage = useCallback(
    async (text: string, files: readonly ChatAttachment[] = []): Promise<void> => {
      // The client mints the id: the bubble, the hub's `user-message`, its delivery
      // states and the CLI's message all carry it — a resend can never deliver twice.
      const id = newMessageId()
      const content = messageContent(text, files)
      dispatch({ type: 'user-sent', id, text, content })
      try {
        await trpcClient.chat.send.mutate({ tabId, message: { id, content } })
      } catch (err) {
        dispatch({ type: 'user-send-failed', id, error: message(err) })
        throw err
      }
    },
    [trpcClient, tabId]
  )

  const retryMessage = useCallback(
    async (id: string): Promise<void> => {
      const item = stateRef.current.timeline.find((it) => it.kind === 'user-text' && it.id === id)
      if (!item || item.kind !== 'user-text') return
      dispatch({ type: 'user-retry', id })
      try {
        // The whole message: its files too (attached on desktop).
        await trpcClient.chat.send.mutate({
          tabId,
          message: { id, content: messageContent(item.text, item.attachments ?? []) }
        })
      } catch (err) {
        dispatch({ type: 'user-send-failed', id, error: message(err) })
      }
    },
    [trpcClient, tabId]
  )

  // The ref is the synchronous double-tap guard; the state disables the buttons.
  const submittingRef = useRef<Set<string>>(new Set())
  const [submittingPrompts, setSubmittingPrompts] = useState<ReadonlySet<string>>(() => new Set())
  const respondPermission = useCallback(
    async (args: { requestId: string; decision: PermissionDecision; optionId?: string }) => {
      const { requestId } = args
      if (submittingRef.current.has(requestId)) return false
      submittingRef.current.add(requestId)
      setSubmittingPrompts(new Set(submittingRef.current))
      const settle = (): void => {
        submittingRef.current.delete(requestId)
        setSubmittingPrompts(new Set(submittingRef.current))
      }
      // The prompt flips to answered when the hub's `permission-resolved` arrives;
      // a refusal means the request is no longer pending there.
      return trpcClient.chat.respondPermission.mutate({ tabId, args }).then(
        (ok) => {
          settle()
          if (!ok) dispatch({ type: 'prompt-refused', requestId })
          return ok
        },
        (err: unknown) => {
          settle()
          throw err
        }
      )
    },
    [trpcClient, tabId]
  )

  const interrupt = useCallback(async () => {
    await trpcClient.chat.interrupt.mutate({ tabId, taskId, mode, cwd, providerFlagsOverride })
  }, [trpcClient, tabId, taskId, mode, cwd, providerFlagsOverride])

  const abortAndPop = useCallback(
    () => trpcClient.chat.abortAndPop.mutate({ tabId, taskId, mode, cwd, providerFlagsOverride }),
    [trpcClient, tabId, taskId, mode, cwd, providerFlagsOverride]
  )

  const reload = useCallback(() => void load('full'), [load])
  const resetLocal = useCallback(() => sync.resetLocal(), [sync])

  return {
    state,
    // Working: the user's turn, or one Claude Code started by itself (desktop's rule).
    inFlight: isTurnOpen(state),
    hydrating,
    loadError,
    reload,
    submittingPrompts,
    sendMessage,
    retryMessage,
    respondPermission,
    interrupt,
    abortAndPop,
    resetLocal
  }
}
