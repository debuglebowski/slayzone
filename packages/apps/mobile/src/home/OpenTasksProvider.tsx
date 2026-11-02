/**
 * The tasks open as tabs on an iPad (`open-tasks.ts`), kept for the whole signed-in app
 * (`app/(tabs)/_layout.tsx`): the board's tab bar shows them, and a task link — a deep
 * link, a search result — opens its task as a tab there, as desktop does. Each tab keeps
 * the part shown (Details / Artifacts beside the agent) and its agent tab.
 */
import { createContext, type ReactNode, useContext, useState } from 'react'
import { rowKey } from '../hub-board'
import type { TaskSegment } from '../task/TaskPage'
import { closeTask, openTask, type OpenTasks, type TaskRef } from './open-tasks'

export interface TabView {
  segment: TaskSegment
  agentTabId: string | undefined
}

export interface OpenTasksValue extends OpenTasks {
  open: (ref: TaskRef, view?: Partial<TabView>) => void
  close: (ref: TaskRef) => void
  /** null = the board. */
  activate: (ref: TaskRef | null) => void
  viewOf: (ref: TaskRef) => TabView
  setView: (ref: TaskRef, view: Partial<TabView>) => void
}

const DEFAULT_VIEW: TabView = { segment: 'details', agentTabId: undefined }
const OpenTasksContext = createContext<OpenTasksValue | null>(null)

export function useOpenTasks(): OpenTasksValue {
  const value = useContext(OpenTasksContext)
  if (!value) throw new Error('useOpenTasks must be used within OpenTasksProvider')
  return value
}

export function OpenTasksProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OpenTasks>({ tabs: [], active: null })
  const [views, setViews] = useState<Record<string, TabView>>({})
  const viewOf = (ref: TaskRef): TabView => views[rowKey(ref.hubId, ref.taskId)] ?? DEFAULT_VIEW
  const setView = (ref: TaskRef, view: Partial<TabView>) =>
    setViews((v) => {
      const key = rowKey(ref.hubId, ref.taskId)
      return { ...v, [key]: { ...(v[key] ?? DEFAULT_VIEW), ...view } }
    })
  const value: OpenTasksValue = {
    ...state,
    open: (ref, view) => {
      setState((s) => openTask(s, ref))
      if (view) setView(ref, view)
    },
    close: (ref) => setState((s) => closeTask(s, ref)),
    activate: (ref) => setState((s) => ({ ...s, active: ref })),
    viewOf,
    setView
  }
  return <OpenTasksContext.Provider value={value}>{children}</OpenTasksContext.Provider>
}
