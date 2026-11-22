import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../trpc'
import { useStableCallback } from '@slayzone/ui'
import { chatRestorationQueueFor, type ChatRestorationTicket } from './chat-restoration-queue'
import { trackChatLoading } from './chat-loading'

const ChatRestorationContext = createContext<ChatRestorationTicket | null>(null)
type ComputerReadiness = 'checking' | 'waiting' | 'ready'
const untracked = <T,>(work: Promise<T>): Promise<T> => work

type Admission = { ticket: ChatRestorationTicket | null; ready: boolean }
const EMPTY_ADMISSION: Admission = { ticket: null, ready: false }

/** Allocate after commit, publish through an external store, dispose on unmount. */
function createAdmission(target: { client: object; taskId: string; tabId: string }) {
  let ticket: ChatRestorationTicket | null = null
  let state = EMPTY_ADMISSION
  let off: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = () => {
    const ready = ticket?.ready() ?? false
    if (state.ticket === ticket && state.ready === ready) return
    state = { ticket, ready }
    for (const cb of [...listeners]) cb()
  }
  const stop = () => {
    off?.()
    off = undefined
    ticket?.cancel()
    ticket = null
    publish()
  }
  return {
    snapshot: () => state,
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    start(active: boolean) {
      if (ticket) return
      ticket = chatRestorationQueueFor(target.client).enqueue(active)
      off = ticket.subscribe(publish)
      publish()
    },
    setActive(active: boolean) {
      ticket?.setActive(active)
    },
    defer() {
      if (ticket && !ticket.ready()) stop()
    },
    stop
  }
}

export function ChatRestorationBoundary({
  client,
  taskId,
  tabId,
  active,
  computerReadiness = 'ready',
  children
}: {
  client: object
  taskId: string
  tabId: string
  active: boolean
  computerReadiness?: ComputerReadiness
  children: ReactNode
}) {
  const initialActive = useStableCallback(() => active)
  const admission = useMemo(
    () => createAdmission({ client, taskId, tabId }),
    [client, taskId, tabId]
  )
  const { ticket, ready } = useSyncExternalStore(
    admission.subscribe,
    admission.snapshot,
    () => EMPTY_ADMISSION
  )
  useEffect(() => () => admission.stop(), [admission])
  useEffect(() => {
    if (computerReadiness === 'ready') admission.start(initialActive())
    else admission.defer()
  }, [admission, computerReadiness, initialActive])
  useEffect(() => admission.setActive(active), [admission, active])
  useEffect(() => {
    if (ready) ticket?.mounted()
  }, [ticket, ready])
  useEffect(() => (!ready ? trackChatLoading() : undefined), [ready])
  if (!ready || !ticket)
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        {computerReadiness === 'waiting' ? 'Waiting for computer…' : 'Loading chat…'}
      </div>
    )
  return (
    <ChatRestorationContext.Provider value={ticket}>{children}</ChatRestorationContext.Provider>
  )
}

/** Resolve metadata outside the history queue. Only known startup waits are retried. */
export function useChatHistoryReadiness(tabId: string): ComputerReadiness {
  const trpc = useTRPC()
  const query = useQuery({
    ...trpc.chat.availability.queryOptions({ tabId }),
    enabled: Boolean(tabId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: ({ state }) =>
      state.status !== 'error' && state.data?.historyWaiting ? 2_000 : false,
    refetchIntervalInBackground: true
  })
  // Unknown readiness and older hubs use the normal open and its recovery UI.
  if (!tabId || query.isError || query.fetchStatus === 'paused') return 'ready'
  if (query.data?.historyWaiting) return 'waiting'
  return query.isPending ? 'checking' : 'ready'
}

export function useChatHistoryTracker() {
  const ticket = useContext(ChatRestorationContext)
  return ticket?.track ?? untracked
}

const notQueued = (): number | null => null

/** How long this chat waited for its restoration slot (open-timing diagnostic). */
export function useChatRestorationQueuedMs(): () => number | null {
  const ticket = useContext(ChatRestorationContext)
  return ticket?.queuedMs ?? notQueued
}
