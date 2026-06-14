import type { SlayzoneDb } from '@slayzone/platform'
import type { TypedEmitter } from '@slayzone/platform/events'
import type { MenuEventMap } from '../../../app-deps'

interface StoredTab {
  id: string
  agentTouched?: boolean
  [k: string]: unknown
}
interface StoredState {
  tabs?: StoredTab[]
  activeTabId?: string | null
}

/**
 * Flip `agentTouched: true` on the matching tab inside `tasks.browser_tabs` JSON.
 * Sticky + idempotent: no-op when already true or when tab not found.
 *
 * Also announces the trip so the renderer can optimistically stamp the flag
 * onto its local tabs state. This closes a race where the renderer's own
 * writeback of the tabs JSON (URL/title updates fired by `did-navigate`) lands
 * AFTER this server-side write and clobbers the flag — once the renderer
 * mirrors the flag locally, any subsequent writeback preserves it.
 *
 * Delivery rides the `menuEvents` bus (→ `menu.onBrowserAgentTouched` tRPC
 * subscription, the renderer's only path now that preload is bootstrap-only).
 * The legacy `browser:agent-touched` `webContents.send` is kept for IPC
 * coexistence, mirroring the dual-emit in `new-tab.ts` / `shared.ts`.
 */
export async function markTabAgentTouched(
  db: SlayzoneDb,
  notifyRenderer: () => void,
  taskId: string,
  tabId: string | null,
  legacyBroadcast?: (channel: string, ...args: unknown[]) => void,
  menu?: TypedEmitter<MenuEventMap>
): Promise<void> {
  if (!tabId) return
  // Always announce: even if the DB row already has the flag, the renderer
  // may still be holding stale local state that drops it on next writeback.
  menu?.emit('browser-agent-touched', { taskId, tabId })
  legacyBroadcast?.('browser:agent-touched', { taskId, tabId })

  const row = (await db.prepare('SELECT browser_tabs FROM tasks WHERE id = ?').get(taskId)) as
    | { browser_tabs: string | null }
    | undefined
  if (!row?.browser_tabs) return

  let state: StoredState
  try {
    state = JSON.parse(row.browser_tabs) as StoredState
  } catch {
    return
  }
  const tabs = state.tabs
  if (!Array.isArray(tabs)) return

  const tab = tabs.find((t) => t?.id === tabId)
  if (!tab) return
  if (tab.agentTouched === true) return

  tab.agentTouched = true
  await db
    .prepare('UPDATE tasks SET browser_tabs = ? WHERE id = ?')
    .run(JSON.stringify(state), taskId)
  notifyRenderer()
}
