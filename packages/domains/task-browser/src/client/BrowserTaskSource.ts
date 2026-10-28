import type { Task } from '@slayzone/task-contracts'

/**
 * Task data + writes the browser panel needs from task, which sits ABOVE
 * task-browser (task renders BrowserPanel). task-browser owns this contract;
 * task injects the implementation via registerBrowserTaskSource() when it loads
 * the panel module, so task-browser never calls `task.*` routes itself.
 */
export interface BrowserTaskSource {
  /**
   * Tasks offered as URL-import sources: the project's tasks when `projectId`
   * is set, else all tasks. Fetches only while `enabled`.
   */
  useImportTasks: (params: { projectId?: string; enabled: boolean }) => readonly Task[] | undefined
  /** Persist a browser tab's lock flag. The returned function must be stable. */
  useSetBrowserTabLocked: () => (input: { taskId: string; tabId: string; locked: boolean }) => void
}

let registered: BrowserTaskSource | null = null

/**
 * Called by task before BrowserPanel first renders. The panel calls the injected
 * hooks, so they must be the same functions for the app's lifetime, hence a
 * module-level registration (not a context). Re-registering the same object is
 * a no-op; a different one throws.
 */
export function registerBrowserTaskSource(source: BrowserTaskSource): void {
  if (registered && registered !== source) {
    throw new Error('registerBrowserTaskSource: browser task source is already registered')
  }
  registered = source
}

/** The registered source. Throws if task never called registerBrowserTaskSource. */
export function getBrowserTaskSource(): BrowserTaskSource {
  if (!registered) {
    throw new Error('getBrowserTaskSource: task must call registerBrowserTaskSource first')
  }
  return registered
}

/** The injected `useImportTasks` (fixed for the app's lifetime). */
export function useBrowserImportTasks(params: {
  projectId?: string
  enabled: boolean
}): readonly Task[] | undefined {
  return getBrowserTaskSource().useImportTasks(params)
}

/** The injected `useSetBrowserTabLocked` (fixed for the app's lifetime). */
export function useSetBrowserTabLocked(): (input: {
  taskId: string
  tabId: string
  locked: boolean
}) => void {
  return getBrowserTaskSource().useSetBrowserTabLocked()
}
