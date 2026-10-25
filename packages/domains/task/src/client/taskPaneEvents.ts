/**
 * Task-targeted events for an open tab whose detail page is not mounted yet.
 *
 * A few events reach a task only through its mounted TaskDetailPage's own
 * subscription — `slay tasks browser` opening the panel / a new browser tab, an
 * artifact opened from the CLI, a respawn suggested after the task left a done
 * status. Hidden tabs hydrate a few seconds after a boot (see the app's
 * pane-hydration.ts), and any page mounts a beat after its tab opens, so such an
 * event can arrive while nobody listens and would be lost.
 *
 * `TaskPaneEventCatcher` listens on behalf of open tabs whose page is not live:
 * it holds the event here and hydrates the tab; the page takes its held events
 * when it mounts and runs them through the very handlers the live subscription
 * uses. Pages mark themselves live, so a mounted page is never double-served.
 */

export interface TaskPaneEventPayloads {
  'browser-ensure-panel-open': { taskId: string; url?: string | null; tabId?: string | null }
  'browser-create-tab': {
    taskId: string
    tabId: string
    url?: string | null
    background?: boolean
  }
  'open-artifact': { taskId: string; artifactId: string }
  'respawn-suggested': { taskId: string }
}

export type TaskPaneEventKind = keyof TaskPaneEventPayloads

export type TaskPaneEvent = {
  [K in TaskPaneEventKind]: { kind: K; payload: TaskPaneEventPayloads[K] }
}[TaskPaneEventKind]

/** A held event older than this is dropped (its tab never mounted — e.g. closed first). */
export const HELD_EVENT_TTL_MS = 30_000

interface Held {
  event: TaskPaneEvent
  at: number
}

const live = new Map<string, number>()
const held = new Map<string, Held[]>()

/** The task's page is mounted and subscribed. Returns the unmark (cleanup). */
export function markTaskPaneLive(taskId: string): () => void {
  live.set(taskId, (live.get(taskId) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const n = (live.get(taskId) ?? 1) - 1
    if (n <= 0) live.delete(taskId)
    else live.set(taskId, n)
  }
}

export function isTaskPaneLive(taskId: string): boolean {
  return live.has(taskId)
}

export function holdTaskPaneEvent(event: TaskPaneEvent, now: number = Date.now()): void {
  const taskId = event.payload.taskId
  const list = held.get(taskId) ?? []
  list.push({ event, at: now })
  held.set(taskId, list)
}

/**
 * Take (remove) the task's held events of the given kinds, oldest first. Expired
 * events are discarded.
 */
export function takeTaskPaneEvents(
  taskId: string,
  kinds: readonly TaskPaneEventKind[],
  now: number = Date.now()
): TaskPaneEvent[] {
  const list = held.get(taskId)
  if (!list) return []
  const taken: TaskPaneEvent[] = []
  const kept: Held[] = []
  for (const h of list) {
    if (now - h.at > HELD_EVENT_TTL_MS) continue
    if (kinds.includes(h.event.kind)) taken.push(h.event)
    else kept.push(h)
  }
  if (kept.length > 0) held.set(taskId, kept)
  else held.delete(taskId)
  return taken
}

/** Test seam. */
export function __resetTaskPaneEventsForTest(): void {
  live.clear()
  held.clear()
}
