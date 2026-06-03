import { TypedEmitter } from '@slayzone/platform/events'

export interface TabsChangedPayload {
  taskId: string
  focusTabId?: string | null
}

export type TabsEventMap = {
  /** Emitted whenever a task's tabs change (create/split/rename/cold-start). */
  'tabs:changed': [payload: TabsChangedPayload]
}

/**
 * Domain event bus for terminal-tab changes. The REST `/api/tabs/*` routes +
 * the PTY cold-start path emit `tabs:changed` here; the tRPC
 * `taskTerminals.onChanged` subscription wraps it in an observable so each
 * renderer connection refetches its own list.
 *
 * The legacy `broadcastToWindows('tabs:changed')` IPC broadcast still runs in
 * parallel (dual-emit) until the renderer drops IPC (slice 5).
 */
export const tabsEvents = new TypedEmitter<TabsEventMap>()
