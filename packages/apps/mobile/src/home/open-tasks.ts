/**
 * The tasks open as tabs on an iPad (desktop's tab bar), as plain data: open shows a
 * task (adding its tab once), close removes its tab and, if it was shown, shows the
 * tab after it (else the one before; none left = the board). `active` null = the board.
 * A task is named by hub AND id (hubs may share ids, `hub-board.ts`).
 */
export interface TaskRef {
  hubId: string
  taskId: string
}

export interface OpenTasks {
  tabs: TaskRef[]
  active: TaskRef | null
}

export const sameTask = (a: TaskRef | null, b: TaskRef | null): boolean =>
  !!a && !!b && a.hubId === b.hubId && a.taskId === b.taskId

export function openTask(state: OpenTasks, ref: TaskRef): OpenTasks {
  const tabs = state.tabs.some((t) => sameTask(t, ref)) ? state.tabs : [...state.tabs, ref]
  return { tabs, active: ref }
}

export function closeTask(state: OpenTasks, ref: TaskRef): OpenTasks {
  const at = state.tabs.findIndex((t) => sameTask(t, ref))
  if (at === -1) return state
  const tabs = state.tabs.filter((_, i) => i !== at)
  if (!sameTask(state.active, ref)) return { tabs, active: state.active }
  return { tabs, active: tabs[at] ?? tabs[at - 1] ?? null }
}

/**
 * The tab bar when hubs keep the tabs (`openTabs`, shared with the user's desktop):
 * hub by hub in `hubIds` order, a hub that keeps them shows its list (`synced`), a hub
 * that does not (older than `openTabs`, or not loaded yet) the tabs opened on this
 * device (`local`).
 */
export function combineOpenTasks(
  hubIds: readonly string[],
  synced: ReadonlyMap<string, readonly string[]>,
  local: readonly TaskRef[]
): TaskRef[] {
  return hubIds.flatMap((hubId) => {
    const list = synced.get(hubId)
    return list ? list.map((taskId) => ({ hubId, taskId })) : local.filter((t) => t.hubId === hubId)
  })
}

/** The tab to show: `active` while it is still a tab (closed elsewhere = the board). */
export function shownTab(tabs: readonly TaskRef[], active: TaskRef | null): TaskRef | null {
  return active && tabs.some((t) => sameTask(t, active)) ? active : null
}
