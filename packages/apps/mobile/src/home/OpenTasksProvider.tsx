/**
 * The tasks open as tabs on an iPad (`open-tasks.ts`), kept for the whole signed-in app
 * (`app/(tabs)/_layout.tsx`): the board's tab bar shows them, and a task link — a deep
 * link, a search result — opens its task as a tab there, as desktop does. Each tab keeps
 * the part shown (Details / Artifacts beside the agent).
 *
 * Shared with the desktop: each hub keeps the signed-in user's open tabs of its tasks
 * (`openTabs`), the same list the desktop's tab bar mirrors, so a task opened or closed
 * on one shows or goes on the other. Per hub (`HubOpenTabs`, in that hub's scope): its
 * list, read again when it changes elsewhere (`openTabs.onChanged`) and when the socket
 * comes back. A hub older than `openTabs` keeps the tabs opened on this device, as
 * before. Which tab is shown stays on the device. Only an iPad window (`useWide`): an
 * iPhone shows no tabs.
 *
 * Closing a temporary task's tab does what desktop does (`useCloseTaskTab`): the task
 * stays, its terminals stop.
 */
import { HubScope, useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import { findTaskRow, rowKey } from '../hub-board'
import { useHubFeeds } from '../hub-connections'
import { useWide } from '../layout'
import type { TaskSegment } from '../task/TaskPage'
import { useTRPC, useTRPCClient } from '../trpc'
import {
  closeTask,
  combineOpenTasks,
  openTask,
  type OpenTasks,
  sameTask,
  shownTab,
  type TaskRef
} from './open-tasks'

export interface TabView {
  segment: TaskSegment
}

export interface OpenTasksValue extends OpenTasks {
  open: (ref: TaskRef, view?: Partial<TabView>) => void
  close: (ref: TaskRef) => void
  /** null = the board. */
  activate: (ref: TaskRef | null) => void
  viewOf: (ref: TaskRef) => TabView
  setView: (ref: TaskRef, view: Partial<TabView>) => void
}

const DEFAULT_VIEW: TabView = { segment: 'details' }
const OpenTasksContext = createContext<OpenTasksValue | null>(null)

export function useOpenTasks(): OpenTasksValue {
  const value = useContext(OpenTasksContext)
  if (!value) throw new Error('useOpenTasks must be used within OpenTasksProvider')
  return value
}

/** One hub's shared tabs, as its `HubOpenTabs` reports them. */
interface HubTabs {
  /** null: the hub does not keep open tabs (older than `openTabs`) or has not answered. */
  list: readonly string[] | null
  open: (taskId: string) => void
  close: (taskId: string) => void
  /** Stops a task's terminals (`pty.killTask`) on this hub. */
  stopTerminals: (taskId: string) => Promise<unknown>
}

type ReportTabs = (hubId: string, tabs: HubTabs | null) => void

export function OpenTasksProvider({ children }: { children: ReactNode }) {
  const wide = useWide()
  const { feeds, clientFor } = useHubFeeds()
  const [local, setLocal] = useState<OpenTasks>({ tabs: [], active: null })
  const [synced, setSynced] = useState<ReadonlyMap<string, HubTabs>>(new Map())
  const [views, setViews] = useState<Record<string, TabView>>({})
  const report = useCallback<ReportTabs>((hubId, tabs) => {
    setSynced((prev) => {
      if (!tabs && !prev.has(hubId)) return prev
      const next = new Map(prev)
      if (tabs) next.set(hubId, tabs)
      else next.delete(hubId)
      return next
    })
  }, [])
  const hubIds = feeds.map((f) => f.hub.id)
  const lists = useMemo(
    () =>
      new Map(
        [...synced].flatMap(([hubId, tabs]) => (tabs.list ? [[hubId, tabs.list] as const] : []))
      ),
    [synced]
  )
  const tabs = combineOpenTasks(hubIds, lists, local.tabs)
  const active = shownTab(tabs, local.active)

  const viewOf = (ref: TaskRef): TabView => views[rowKey(ref.hubId, ref.taskId)] ?? DEFAULT_VIEW
  const setView = (ref: TaskRef, view: Partial<TabView>) =>
    setViews((v) => {
      const key = rowKey(ref.hubId, ref.taskId)
      return { ...v, [key]: { ...(v[key] ?? DEFAULT_VIEW), ...view } }
    })
  const isTemporary = (ref: TaskRef): boolean => {
    const feed = feeds.find((f) => f.hub.id === ref.hubId)
    return !!(feed && findTaskRow(feed, ref.taskId)?.task.is_temporary)
  }
  const value: OpenTasksValue = {
    tabs,
    active,
    open: (ref, view) => {
      const hub = synced.get(ref.hubId)
      if (hub?.list) {
        hub.open(ref.taskId)
        setLocal((s) => ({ ...s, active: ref }))
      } else setLocal((s) => openTask(s, ref))
      if (view) setView(ref, view)
    },
    close: (ref) => {
      // The tab after it (else before) shows when it was the one shown.
      const next = closeTask({ tabs, active }, ref).active
      const hub = synced.get(ref.hubId)
      if (hub?.list) hub.close(ref.taskId)
      setLocal((s) => ({
        tabs: s.tabs.filter((t) => !sameTask(t, ref)),
        active: sameTask(s.active, ref) ? next : s.active
      }))
      if (isTemporary(ref)) {
        // Desktop's close: the task stays, its terminals stop. The tab is already
        // gone, so a failed stop is not an error to show.
        void Promise.resolve()
          .then(() =>
            hub
              ? hub.stopTerminals(ref.taskId)
              : clientFor(ref.hubId).pty.killTask.mutate({ taskId: ref.taskId })
          )
          .catch(() => undefined)
      }
    },
    activate: (ref) => setLocal((s) => ({ ...s, active: ref })),
    viewOf,
    setView
  }
  return (
    <OpenTasksContext.Provider value={value}>
      {wide
        ? hubIds.map((hubId) => (
            <HubScope key={hubId} hubId={hubId}>
              <HubOpenTabs hubId={hubId} onReport={report} />
            </HubScope>
          ))
        : null}
      {children}
    </OpenTasksContext.Provider>
  )
}

/**
 * One hub's shared tabs: its list (`openTabs.list`), read again when another client of
 * the user changes it; open and close show at once and are then read back. A hub that
 * cannot answer (older than `openTabs`) reports no list: the device keeps its own tabs
 * of that hub. Must sit inside the hub's `HubScope`. Renders nothing.
 */
function HubOpenTabs({ hubId, onReport }: { hubId: string; onReport: ReportTabs }) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const listQ = useQuery(trpc.openTabs.list.queryOptions(undefined, { retry: 1 }))
  useSubscription(
    trpc.openTabs.onChanged.subscriptionOptions(undefined, {
      onData: () => void queryClient.invalidateQueries(trpc.openTabs.list.queryFilter())
    })
  )
  const data = listQ.data
  useEffect(() => {
    const write = (next: (list: string[]) => string[], send: () => Promise<unknown>) => {
      queryClient.setQueryData<string[]>(trpc.openTabs.list.queryKey(), (list) =>
        list ? next(list) : list
      )
      void send()
        .catch(() => undefined)
        .then(() => queryClient.invalidateQueries(trpc.openTabs.list.queryFilter()))
    }
    onReport(hubId, {
      list: data ?? null,
      stopTerminals: (taskId) => client.pty.killTask.mutate({ taskId }),
      open: (taskId) =>
        write(
          (list) => (list.includes(taskId) ? list : [...list, taskId]),
          () => client.openTabs.open.mutate({ taskId })
        ),
      close: (taskId) =>
        write(
          (list) => list.filter((id) => id !== taskId),
          () => client.openTabs.close.mutate({ taskId })
        )
    })
  }, [data, hubId, onReport, queryClient, client, trpc])
  // Signed out of, or the window narrowed: nothing of this hub stays shared.
  useEffect(() => () => onReport(hubId, null), [onReport, hubId])
  return null
}
