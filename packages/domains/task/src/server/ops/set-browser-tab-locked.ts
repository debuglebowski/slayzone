import type { SlayzoneDb } from '@slayzone/platform'
import type { OpDeps } from './shared.js'

interface StoredTab {
  id: string
  locked?: boolean
  [k: string]: unknown
}
interface StoredState {
  tabs?: StoredTab[]
  activeTabId?: string | null
}

/**
 * Dedicated write path for `browser_tabs[].locked`. Generic updateTask strips
 * incoming `locked` to prevent stale renderer writebacks from clobbering it —
 * this op is the only place renderers/server are allowed to mutate the flag.
 */
export async function setBrowserTabLockedOp(
  db: SlayzoneDb,
  taskId: string,
  tabId: string,
  locked: boolean,
  deps: OpDeps
): Promise<boolean> {
  const row = await db.get<{ browser_tabs: string | null }>(
    'SELECT browser_tabs FROM tasks WHERE id = ?',
    [taskId]
  )
  if (!row?.browser_tabs) return false

  let state: StoredState
  try {
    state = JSON.parse(row.browser_tabs) as StoredState
  } catch {
    return false
  }
  const tabs = state.tabs
  if (!Array.isArray(tabs)) return false

  const tab = tabs.find((t) => t?.id === tabId)
  if (!tab) return false
  if (!!tab.locked === locked) return true

  tab.locked = locked
  await db.run('UPDATE tasks SET browser_tabs = ? WHERE id = ?', [JSON.stringify(state), taskId])
  deps.onMutation?.()
  return true
}
