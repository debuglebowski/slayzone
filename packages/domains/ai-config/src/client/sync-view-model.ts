import type { CliProvider, SyncHealth, SyncReason } from '../shared'

export interface ProviderSyncEntry {
  syncHealth: SyncHealth
  syncReason?: SyncReason | null
}

export interface ProviderGroupEntry {
  path: string
  syncHealth: SyncHealth
  syncReason: SyncReason | null
  diskContent?: string
}

export interface ProviderGroup {
  key: string
  providers: CliProvider[]
  path: string
  syncHealth: SyncHealth
  syncReason: SyncReason | null
  diskContent: string | null
}

export function groupProvidersByPath(
  providers: Partial<Record<CliProvider, ProviderGroupEntry>>,
  order: ReadonlyArray<CliProvider>
): ProviderGroup[] {
  const byPath = new Map<string, ProviderGroup>()
  const groupsInOrder: ProviderGroup[] = []

  for (const provider of order) {
    const entry = providers[provider]
    if (!entry) continue
    if (entry.syncReason === 'not_linked' && entry.syncHealth !== 'unmanaged') continue

    const key = entry.path
    const existing = byPath.get(key)
    if (existing) {
      existing.providers.push(provider)
      continue
    }
    const group: ProviderGroup = {
      key,
      providers: [provider],
      path: entry.path,
      syncHealth: entry.syncHealth,
      syncReason: entry.syncReason,
      diskContent: entry.diskContent ?? null
    }
    byPath.set(key, group)
    groupsInOrder.push(group)
  }

  return groupsInOrder
}

export function aggregateProviderSyncHealth(
  providers: Partial<Record<CliProvider, ProviderSyncEntry>>
): SyncHealth {
  const healths = Object.values(providers)
    .filter((provider) => {
      if (!provider) return false
      if (provider.syncReason !== 'not_linked') return true
      return provider.syncHealth === 'unmanaged'
    })
    .map((provider) => provider.syncHealth)

  if (healths.length === 0) return 'not_synced'
  if (healths.some((health) => health === 'stale')) return 'stale'
  if (healths.every((health) => health === 'synced')) return 'synced'
  if (healths.some((health) => health === 'not_synced')) return 'not_synced'
  if (healths.some((health) => health === 'unmanaged')) return 'unmanaged'
  return 'not_synced'
}

export function toSyncBadgeLabel(syncHealth: SyncHealth): string {
  if (syncHealth === 'synced') return 'Synced'
  if (syncHealth === 'stale') return 'Stale'
  if (syncHealth === 'unmanaged') return 'Unmanaged'
  return 'Not synced'
}
