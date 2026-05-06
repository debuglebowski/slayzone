import { validateColumns, type ColumnConfig, type WorkflowCategory } from '@slayzone/workflow'
import { slugifyStatusName, type IntegrationProvider, type ProviderStatus, type StatusDiff } from '../shared'
import { getAdapter } from './adapters'

export interface StatusSyncResult {
  columns: ColumnConfig[]
  /** Maps provider status ID -> local column ID (handles dedup + sort) */
  providerIdToColumnId: Map<string, string>
}

export function providerStatusesToColumns(
  provider: IntegrationProvider,
  statuses: ProviderStatus[]
): StatusSyncResult {
  const adapter = getAdapter(provider)
  const columns: ColumnConfig[] = statuses.map((status, index) => {
    const category: WorkflowCategory = adapter.remoteStatusToCategory(status)
    const color = adapter.mapColor(status.color)

    return {
      id: slugifyStatusName(status.name),
      label: status.name,
      color,
      position: status.position ?? index,
      category
    }
  })

  // Deduplicate IDs and track the final ID per provider status
  const seen = new Set<string>()
  const providerIdToColumnId = new Map<string, string>()

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]
    const providerStatusId = statuses[i].id
    if (seen.has(col.id)) {
      let suffix = 2
      while (seen.has(`${col.id}_${suffix}`)) suffix++
      col.id = `${col.id}_${suffix}`
    }
    seen.add(col.id)
    providerIdToColumnId.set(providerStatusId, col.id)
  }

  // validateColumns sorts by category — column IDs are stable through sort
  const validated = validateColumns(columns)

  return { columns: validated, providerIdToColumnId }
}

/**
 * Compute diff between current and incoming columns using provider status IDs.
 * `currentIdMap`: local column id -> provider status id (from integration_state_mappings)
 * `incomingStatuses`: fresh provider statuses with their IDs
 */
export function computeStatusDiff(
  current: ColumnConfig[],
  incomingStatuses: ProviderStatus[],
  currentIdMap: Map<string, string>
): StatusDiff {
  // Build reverse map: provider status id -> current column
  const currentByProviderId = new Map<string, ColumnConfig>()
  for (const col of current) {
    const providerId = currentIdMap.get(col.id)
    if (providerId) currentByProviderId.set(providerId, col)
  }

  const added: ProviderStatus[] = []
  const removed: ColumnConfig[] = []
  const renamed: Array<{ old: ColumnConfig; new: ProviderStatus }> = []
  const matchedProviderIds = new Set<string>()

  for (const status of incomingStatuses) {
    const currentCol = currentByProviderId.get(status.id)
    if (!currentCol) {
      added.push(status)
    } else {
      matchedProviderIds.add(status.id)
      if (currentCol.label !== status.name) {
        renamed.push({ old: currentCol, new: status })
      }
    }
  }

  for (const col of current) {
    const providerId = currentIdMap.get(col.id)
    if (providerId && !matchedProviderIds.has(providerId)) {
      removed.push(col)
    }
  }

  return { added, removed, renamed }
}
