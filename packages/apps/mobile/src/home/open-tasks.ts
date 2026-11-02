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
