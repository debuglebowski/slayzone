import { Check, AlertCircle } from 'lucide-react'
import type { SyncHealth } from '../shared'
import { toSyncBadgeLabel } from './sync-view-model'

// ============================================================
// StatusBadge
// ============================================================

export function StatusBadge({ syncHealth }: { syncHealth: SyncHealth }) {
  const health = syncHealth
  if (health === 'synced')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-700 dark:text-green-300">
        <Check className="size-3" /> {toSyncBadgeLabel(health)}
      </span>
    )
  if (health === 'stale')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
        <AlertCircle className="size-3" /> {toSyncBadgeLabel(health)}
      </span>
    )
  if (health === 'unmanaged') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {toSyncBadgeLabel(health)}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {toSyncBadgeLabel(health)}
    </span>
  )
}
