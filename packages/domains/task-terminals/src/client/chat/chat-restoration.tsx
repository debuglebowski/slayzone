import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { useQueryClient, type Query } from '@tanstack/react-query'
import { useStableCallback } from '@slayzone/ui'
import {
  defaultChatModeSettingKey,
  defaultChatModelSettingKey,
  defaultChatEffortSettingKey
} from '@slayzone/terminal-contracts'
import { chatRestorationQueueFor, type ChatRestorationTicket } from './chat-restoration-queue'
import { trackChatLoading } from './chat-loading'

export const ChatRestorationContext = createContext<ChatRestorationTicket | null>(null)
const untracked = <T,>(work: Promise<T>): Promise<T> => work
const idleSubscribe = (_cb: () => void) => () => undefined
const idleSnapshot = () => false

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
  return {
    snapshot: () => state,
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    start(active: boolean) {
      ticket = chatRestorationQueueFor(target.client).enqueue(active)
      off = ticket.subscribe(publish)
      publish()
    },
    setActive(active: boolean) {
      ticket?.setActive(active)
    },
    stop() {
      off?.()
      ticket?.cancel()
      ticket = null
      publish()
    }
  }
}

export function ChatRestorationBoundary({
  client,
  taskId,
  tabId,
  active,
  children
}: {
  client: object
  taskId: string
  tabId: string
  active: boolean
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
  useEffect(() => {
    admission.start(initialActive())
    return () => admission.stop()
  }, [admission, initialActive])
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
        Loading chat…
      </div>
    )
  return (
    <ChatRestorationContext.Provider value={ticket}>{children}</ChatRestorationContext.Provider>
  )
}

export function useChatRestorationTracker() {
  const ticket = useContext(ChatRestorationContext)
  return ticket?.track ?? untracked
}

/** Include query reads and lifecycle state between consecutive asynchronous startup stages. */
export function useChatRestorationPending(pending: boolean): void {
  const ticket = useContext(ChatRestorationContext)
  useEffect(() => (pending ? ticket?.hold() : undefined), [pending, ticket])
}

/** Track actual query promises, so unmounting cannot free capacity while reads still run. */
export function useChatRestorationQueries({
  taskId,
  tabId,
  mode
}: {
  taskId: string
  tabId: string
  mode: string
}): void {
  const client = useQueryClient()
  const ticket = useContext(ChatRestorationContext)
  const restoring = useSyncExternalStore(
    ticket?.subscribe ?? idleSubscribe,
    ticket?.restoring ?? idleSnapshot,
    idleSnapshot
  )
  useEffect(() => {
    if (!ticket || !restoring) return
    const settings = new Set([
      defaultChatModeSettingKey(mode),
      defaultChatModelSettingKey(mode),
      defaultChatEffortSettingKey(mode)
    ])
    const seen = new WeakSet<Promise<unknown>>()
    const inspecting = new Set<Query>()
    const inspect = (query: Query) => {
      const input = (
        query.queryKey[1] as
          | { input?: { taskId?: string; tabId?: string; key?: string } }
          | undefined
      )?.input
      if (input?.taskId !== taskId && input?.tabId !== tabId && !settings.has(input?.key ?? ''))
        return
      if (query.state.fetchStatus === 'idle' || inspecting.has(query)) return
      // The fetch event precedes TanStack assigning query.promise. Hold now, then
      // capture the actual promise after fetch() returns, even if we unmount first.
      const release = ticket.hold()
      inspecting.add(query)
      queueMicrotask(() => {
        inspecting.delete(query)
        const promise = query.promise
        if (promise && !seen.has(promise)) {
          seen.add(promise)
          void ticket.track(promise).catch(() => undefined) // The consumer presents errors.
        }
        release()
      })
    }
    const cache = client.getQueryCache()
    const stop = cache.subscribe((event) => inspect(event.query))
    for (const query of cache.getAll()) inspect(query)
    return stop
  }, [client, ticket, restoring, taskId, tabId, mode])
}
