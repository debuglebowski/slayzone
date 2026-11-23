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
 *        hub; spawns nothing), then the projected tail (legacy peers use `chat.getReplay`);
 *      - after a reconnect: `chat.getReplay` after the newest applied event (catch-up),
 *        or a full load when a reply was streaming (its fragments cannot be merged) or
 *        the hub's log went backwards.
 *    Events arriving meanwhile are queued and applied after, deduped by seq.
 * 2. `chat.onExit` (unfiltered on the hub; filtered here) ends the process state.
 * 3. The agent process starts lazily on the first send (`chat.send` spawns it). A send
 *    waits for the tab's latest hydrate (`SessionReadyGate`, shared with desktop).
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
  type TimelineItem,
  initialState,
  isTurnOpen,
  reducer
} from '@slayzone/terminal/reducer'
import {
  chatViaDirect,
  readInitialChatHistory,
  wantedTimelinePages,
  pageHasUnloaded,
  PAGES_PER_REQUEST,
  readReplayPages,
  timelinePagesAll,
  type ChatPaging,
  type OpenedChatHistory
} from '@slayzone/terminal/chat-direct'
import {
  readCompleteToolDetail,
  shareToolDetailReads,
  type ChatToolDetailReader
} from '@slayzone/terminal/chat-tool-details'
import { SessionReadyGate } from '@slayzone/terminal/chat-session-ready'
import {
  afterNextPaint,
  createChatOpenTimer,
  reportChatOpenTiming
} from '@slayzone/terminal/chat-open-timing'
import {
  hubSupportsToolPreviews,
  useDirectLease,
  useSubscription
} from '@slayzone/transport/client'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { messageContent } from './attachments'
import {
  ChatSync,
  type ChatReplay,
  type ChatWireEvent,
  type ChatWireExit,
  type LocalMessage
} from './chat-sync'
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

export interface OlderChatHistory {
  loading: boolean
  error: string | null
  load: () => void
}

export interface ChatSessionApi {
  state: ChatTimelineState
  inFlight: boolean
  /** No load has finished yet (the first paint waits for the history). */
  hydrating: boolean
  /** Loaded, but reconnecting or catching up: the turn state shown is the last known one. */
  reconnecting: boolean
  /** Why the last load failed; null = it did not. */
  loadError: string | null
  /** Reload the tail, keeping unsent messages. */
  reload: () => void
  olderHistory: OlderChatHistory | null
  loadHistoryRows: (rows: readonly number[]) => void
  readToolDetail: ChatToolDetailReader
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
    if (it?.kind !== 'user-text' || !it.id) continue
    if (it.optimistic || it.delivery === 'failed') {
      out.push(it)
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
  const [paging, setPaging] = useState<ChatPaging | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const pageGeneration = useRef(0)
  const loadingPages = useRef(new Set<number>())
  const invalidateHistoryReads = useCallback(() => {
    pageGeneration.current++
    loadingPages.current.clear()
  }, [])

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
  const cancelPaintTiming = useRef<(() => void) | undefined>(undefined)
  useEffect(
    () => () => {
      cancelPaintTiming.current?.()
      invalidateHistoryReads()
      sync.dispose()
    },
    [invalidateHistoryReads, sync]
  )
  // The tab's latest hydrate: the computer holds the tab's session only once it ran
  // there, and a send that overtakes it is refused ("No chat session for tab").
  const [sessionReady] = useState(() => new SessionReadyGate())

  const { tabId, taskId, mode, cwd, providerFlagsOverride } = target
  // The tab's direct link to the computer holding its history (docs/direct-link.md):
  // the event stream, the replay and permission answers go there; the hub otherwise.
  const { lease: direct, lost: directLost } = useDirectLease(trpcClient, {
    kind: 'chat',
    tabId,
    taskId
  })
  const chatIo = useMemo(
    () =>
      chatViaDirect(trpcClient, direct?.client ?? null, directLost, (withDisplay) =>
        hubSupportsToolPreviews(trpcClient, withDisplay)
      ),
    [trpcClient, direct, directLost]
  )
  const readToolDetailOnce = useStableCallback<
    Parameters<ChatToolDetailReader>,
    ReturnType<ChatToolDetailReader>
  >((ref, signal) => readCompleteToolDetail(chatIo, tabId, ref, signal))
  const [readToolDetail] = useState(() => shareToolDetailReads(readToolDetailOnce))
  const loadOnce = useCallback(
    async (first: 'full' | 'catch-up'): Promise<void> => {
      // A catch-up that finds the hub's log went backwards asks for a full load;
      // events that raced ahead of a load and show a gap ask for a catch-up.
      for (let kind: 'full' | 'catch-up' = first; ; ) {
        const ticket = sync.beginLoad(kind)
        // A full load's step timings (`chat-open-timing.ts`), reported once painted.
        const timer = kind === 'full' ? createChatOpenTimer() : null
        timer?.set('reload', sync.loadedOnce)
        if (kind === 'full') {
          cancelPaintTiming.current?.()
          invalidateHistoryReads()
          setLoadingHistory(false)
          setHistoryError(null)
          try {
            await sessionReady.track(
              trpcClient.chat.hydrate.mutate({ tabId, taskId, mode, cwd, providerFlagsOverride })
            )
            timer?.mark('hydrateMs')
          } catch (err) {
            timer?.set('hydrateFailed', true)
            // Shown in the chat (desktop does the same); the replay may still work.
            if (sync.isCurrent(ticket)) {
              dispatch({ type: 'event', event: { kind: 'error', message: message(err) } })
            }
          }
        }
        const stale = () => !sync.isCurrent(ticket)
        let replay: ChatReplay
        let paged: Extract<OpenedChatHistory, { kind: 'paged' }> | null = null
        try {
          if (stale()) return
          if (timer) {
            const history = await readInitialChatHistory(chatIo, tabId, timer, stale)
            if (!history || stale()) return
            replay = history
            if (history.kind === 'paged') paged = history
            timer.set('viaDirect', direct !== null)
          } else {
            const all = await readReplayPages(chatIo, tabId, ticket.afterSeq, stale)
            if (!all || stale()) return
            replay = all
          }
        } catch (err) {
          if (sync.failLoad(ticket) === 'done') {
            setLoadError(message(err))
            setHydrating(false)
          }
          return
        }
        if (kind === 'full') setPaging(paged?.paging ?? null)
        const keep = kind === 'full' ? localMessages(stateRef.current) : []
        const result = sync.completeLoad(ticket, replay, keep, paged ?? undefined)
        if (result === 'reload' || result === 'resync') {
          kind = result === 'reload' ? 'full' : 'catch-up'
          continue
        }
        if (result === 'done') {
          setLoadError(null)
          setHydrating(false)
          if (timer) {
            timer.mark('appliedMs')
            cancelPaintTiming.current?.()
            cancelPaintTiming.current = afterNextPaint(() => {
              cancelPaintTiming.current = undefined
              timer.mark('paintedMs')
              reportChatOpenTiming(trpcClient, { taskId, tabId, mode, client: 'mobile' }, timer)
            })
          }
        }
        return
      }
    },
    [
      sync,
      sessionReady,
      trpcClient,
      chatIo,
      direct,
      tabId,
      taskId,
      mode,
      cwd,
      providerFlagsOverride,
      invalidateHistoryReads
    ]
  )
  // A catch-up runs: the turn state shown is the last known one until it lands.
  const [catchingUp, setCatchingUp] = useState(false)
  const load = useCallback(
    (first: 'full' | 'catch-up'): Promise<void> => {
      if (first !== 'catch-up') return loadOnce(first)
      setCatchingUp(true)
      return loadOnce(first).finally(() => setCatchingUp(false))
    },
    [loadOnce]
  )

  // The subscription's handlers: fixed identities, run the latest code (they read refs).
  const onStarted = useStableCallback(() => {
    // First start: the whole history. A restart (reconnect): only what is new, unless
    // a reply was streaming when the socket dropped.
    const kind = !sync.loadedOnce || streaming(stateRef.current) ? 'full' : 'catch-up'
    void load(kind)
  })
  const onEvent = useStableCallback((msg: ChatWireEvent) => {
    const outcome = sync.receive(msg)
    // The log restarted elsewhere (a reset from another client): load it again.
    if (outcome === 'regressed') void load('full')
    // Missed something while connected (a dropped event, the computer restarted):
    // read what is new — the server's current turn status with it.
    else if (outcome === 'resync') void load('catch-up')
  })
  // The hub relays this tab only while it is not on the direct link; each switch
  // starts a subscription again, whose start catches up (`onStarted`).
  const hubStream = useSubscription(
    trpc.chat.onEvent.subscriptionOptions(
      { tabIds: [tabId] },
      { enabled: !direct, onStarted, onData: onEvent }
    )
  )
  useEffect(() => {
    if (!direct) return
    const sub = direct.client.chat.onEvent.subscribe(
      { tabId },
      {
        onStarted,
        onData: (msg) => onEvent(msg as ChatWireEvent),
        onError: directLost,
        onComplete: directLost
      }
    )
    return () => sub.unsubscribe()
  }, [direct, directLost, onStarted, onEvent, tabId])
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
        // Shown at once; sent once the tab's hydrate answered (a reload's too).
        await sessionReady.ready()
        await trpcClient.chat.send.mutate({
          tabId,
          message: { id, content },
          operationId: newMessageId()
        })
      } catch (err) {
        dispatch({ type: 'user-send-failed', id, error: message(err) })
        throw err
      }
    },
    [trpcClient, tabId, sessionReady]
  )

  const retryMessage = useCallback(
    async (id: string): Promise<void> => {
      const item = stateRef.current.timeline.find((it) => it?.kind === 'user-text' && it.id === id)
      if (!item || item.kind !== 'user-text') return
      dispatch({ type: 'user-retry', id })
      try {
        await sessionReady.ready()
        // The whole message: its files too (attached on desktop).
        await trpcClient.chat.send.mutate({
          tabId,
          operationId: newMessageId(),
          message: { id, content: messageContent(item.text, item.attachments ?? []) }
        })
      } catch (err) {
        dispatch({ type: 'user-send-failed', id, error: message(err) })
      }
    },
    [trpcClient, tabId, sessionReady]
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
      return chatIo.respondPermission({ tabId, args }).then(
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
    [chatIo, tabId]
  )

  const interrupt = useCallback(async () => {
    await trpcClient.chat.interrupt.mutate({ tabId, taskId, mode, cwd, providerFlagsOverride })
  }, [trpcClient, tabId, taskId, mode, cwd, providerFlagsOverride])

  const abortAndPop = useCallback(
    () => trpcClient.chat.abortAndPop.mutate({ tabId, taskId, mode, cwd, providerFlagsOverride }),
    [trpcClient, tabId, taskId, mode, cwd, providerFlagsOverride]
  )

  const reload = useCallback(() => void load('full'), [load])
  const resetLocal = useCallback(() => {
    invalidateHistoryReads()
    setPaging(null)
    setLoadingHistory(false)
    setHistoryError(null)
    sync.resetLocal()
  }, [invalidateHistoryReads, sync])

  const loadPages = useStableCallback((pages: readonly number[]): void => {
    if (!paging || sync.loading) return
    const { pageRows } = paging
    const waiting = loadingPages.current
    const wanted = wantedTimelinePages(pages, state.timeline, paging, waiting)
    if (!wanted.length) return
    const generation = pageGeneration.current
    const stale = () => generation !== pageGeneration.current
    const { appliedSeq: asOfSeq, rowsEpoch: epoch } = state
    for (const page of wanted) waiting.add(page)
    setLoadingHistory(true)
    setHistoryError(null)
    const read = async () => {
      for (let i = 0; i < wanted.length; i += PAGES_PER_REQUEST) {
        const res = await timelinePagesAll(
          chatIo,
          {
            tabId,
            pages: wanted.slice(i, i + PAGES_PER_REQUEST),
            asOfSeq,
            epoch,
            pageRows,
            ...(paging.toolPreviews ? { toolPreviews: true } : {}),
            ...(paging.windowed ? { display: { windowed: true } } : {})
          },
          stale
        )
        if (!res || stale()) return
        if (res.expired) {
          reload()
          return
        }
        for (const page of res.pages) {
          dispatch({
            type: 'rows-loaded',
            from: page.from,
            rows: page.rows as TimelineItem[],
            epoch
          })
        }
      }
    }
    void read()
      .catch((error: unknown) => {
        if (!stale()) setHistoryError(message(error))
      })
      .finally(() => {
        if (stale()) return
        for (const page of wanted) waiting.delete(page)
        setLoadingHistory(waiting.size > 0)
      })
  })
  const loadHistoryRows = useStableCallback((rows: readonly number[]) => {
    if (paging) loadPages([...new Set(rows.map((row) => Math.floor(row / paging.pageRows)))])
  })
  const stalledNeed = state.stalled?.need ?? null
  useEffect(() => {
    if (paging && stalledNeed !== null) loadHistoryRows([stalledNeed])
  }, [paging, stalledNeed, loadHistoryRows])

  const olderPage = useMemo(() => {
    if (!paging) return -1
    for (let page = paging.sealed - 1; page >= 0; page--) {
      if (pageHasUnloaded(state.timeline, page, paging.pageRows)) return page
    }
    return -1
  }, [paging, state.timeline])
  const loadEarlier = useStableCallback(() => {
    if (stalledNeed !== null) loadHistoryRows([stalledNeed])
    else loadPages([olderPage])
  })

  return {
    state,
    // Working: the user's turn, or one Claude Code started by itself (desktop's rule).
    inFlight: isTurnOpen(state),
    hydrating,
    // Loaded, but not in step with the hub: its stream reconnects (tRPC
    // `connecting`), or a catch-up reads what was missed. The turn state shown
    // is the last known one, not the server's.
    reconnecting: !hydrating && ((!direct && hubStream.status === 'connecting') || catchingUp),
    loadError,
    reload,
    olderHistory:
      olderPage < 0 ? null : { loading: loadingHistory, error: historyError, load: loadEarlier },
    loadHistoryRows,
    readToolDetail,
    submittingPrompts,
    sendMessage,
    retryMessage,
    respondPermission,
    interrupt,
    abortAndPop,
    resetLocal
  }
}
