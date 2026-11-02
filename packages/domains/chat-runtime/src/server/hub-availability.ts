import type { SlayzoneDb } from '@slayzone/platform'
import type { ChatAvailability } from '@slayzone/terminal-contracts'
import type { ChatOwnershipStore } from './hub-ownership'

/** Metadata only: checking availability must never migrate or fall back to hub content. */
export function createChatAvailability(opts: {
  db: SlayzoneDb
  ownership: ChatOwnershipStore
  resolveComputer(taskId: string): Promise<string | null>
  connected(computerId: string): boolean
  hasLiveTask(taskId: string): Promise<boolean>
  gate?(computerId: string, taskId: string): Promise<void>
}) {
  return async (tabId: string): Promise<ChatAvailability> => {
    const tab = await opts.db.get<{ task_id: string; state: string | null }>(
      'SELECT t.task_id,l.state FROM terminal_tabs t LEFT JOIN chat_task_lifecycle l ON l.task_id=t.task_id WHERE t.id=?',
      [tabId]
    )
    if (!tab) throw new Error('Unknown chat tab')
    const owner = await opts.ownership.forTab(tabId)
    const recorded =
      !owner?.computerId && !owner?.destinationComputerId
        ? await opts.db.get<{ computer_id: string }>(
            'SELECT computer_id FROM chat_workspace_changes WHERE tab_id=? AND computer_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1',
            [tabId]
          )
        : null
    const id =
      owner?.destinationComputerId ??
      owner?.computerId ??
      recorded?.computer_id ??
      (await opts.resolveComputer(tab.task_id))
    let computer: ChatAvailability['computer'] = null
    if (id) {
      await opts.gate?.(id, tab.task_id)
      const row = await opts.db.get<{ name: string }>('SELECT name FROM computers WHERE id=?', [id])
      computer = { id, name: row?.name ?? 'Computer' }
    }
    if (tab.state === 'deleted' || owner?.state === 'deleted') return { state: 'deleted', computer }
    if (tab.state === 'paused') return { state: 'paused', computer }
    if (!computer) return { state: 'unassigned', computer: null }
    if (!opts.connected(computer.id)) return { state: 'offline', computer }
    if (!owner) return { state: 'preparing', computer }
    if (owner.state !== 'active' || owner.cleanupPending)
      return { state: 'migrating', computer, waitingForAgents: await opts.hasLiveTask(tab.task_id) }
    return { state: 'ready', computer }
  }
}
