import { ArrowDownCircle, ArrowUpCircle, RefreshCw } from 'lucide-react'
import {
  Button,
  cn,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import type { CliProvider } from '../shared'
import { PROVIDER_LABELS } from '../shared/provider-registry'
import type { ProviderGroup } from './sync-view-model'

interface ContextItemEditorSyncProps {
  isStale: boolean
  providerGroups: ProviderGroup[]
  activeDiffProvider: CliProvider | null
  setActiveDiffProvider: (provider: CliProvider | null) => void
  syncingAll: boolean
  syncingProvider: CliProvider | null
  pullingProvider: CliProvider | null
  anySyncBusy: boolean
  handleSyncAllToDisk: () => Promise<void>
  handleSyncProvider: (provider: CliProvider) => Promise<void>
  handlePullProvider: (provider: CliProvider) => Promise<void>
  onSyncToDisk?: () => Promise<void>
  onSyncProviderToDisk?: (provider: CliProvider) => Promise<void>
  onPullProviderFromDisk?: (provider: CliProvider) => Promise<void>
}

export function ContextItemEditorSync({
  isStale,
  providerGroups,
  activeDiffProvider,
  setActiveDiffProvider,
  syncingAll,
  syncingProvider,
  pullingProvider,
  anySyncBusy,
  handleSyncAllToDisk,
  handleSyncProvider,
  handlePullProvider,
  onSyncToDisk,
  onSyncProviderToDisk,
  onPullProviderFromDisk
}: ContextItemEditorSyncProps) {
  if (!isStale) return null

  return (
    <div
      className="rounded border border-amber-500/30 bg-amber-500/5"
      data-testid="context-item-editor-stale-banner"
    >
      <div className="flex items-center justify-between gap-3 border-b border-amber-500/20 px-2.5 py-1.5">
        <div className="flex items-center gap-2 text-xs">
          <RefreshCw className="size-3.5 text-amber-500" />
          <span className="font-medium text-amber-500">Skill is out of sync</span>
        </div>
        {onSyncToDisk && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px] gap-1 border-amber-500/30"
            onClick={() => void handleSyncAllToDisk()}
            disabled={anySyncBusy}
            data-testid="context-item-editor-sync-all-to-disk"
          >
            <ArrowUpCircle className="size-3" />
            {syncingAll ? 'Syncing...' : 'Sync all'}
          </Button>
        )}
      </div>
      <div className="divide-y divide-amber-500/10">
        {providerGroups.map((group) => {
          const stale = group.syncHealth === 'stale'
          const representative = group.providers[0]
          const active =
            activeDiffProvider !== null && group.providers.includes(activeDiffProvider)
          const thisSyncing =
            syncingProvider !== null && group.providers.includes(syncingProvider)
          const thisPulling =
            pullingProvider !== null && group.providers.includes(pullingProvider)
          const label = group.providers.map((p) => PROVIDER_LABELS[p]).join(' / ')
          const testSuffix = group.providers.join('-')
          return (
            <div
              key={group.key}
              className="flex items-center justify-between gap-3 px-2.5 py-1.5"
              data-testid={`context-item-editor-provider-row-${testSuffix}`}
            >
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    stale
                      ? 'bg-amber-500'
                      : group.syncHealth === 'synced'
                        ? 'bg-emerald-500'
                        : 'bg-muted-foreground/40'
                  )}
                />
                <span className="font-medium">{label}</span>
                <span className="text-[11px] text-muted-foreground">{group.syncHealth}</span>
              </div>
              {stale && (
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={active ? 'default' : 'outline'}
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setActiveDiffProvider(active ? null : representative)}
                    data-testid={`context-item-editor-view-diff-${testSuffix}`}
                  >
                    {active ? 'Hide diff' : 'View diff'}
                  </Button>
                  {onPullProviderFromDisk && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1"
                          onClick={() => void handlePullProvider(representative)}
                          disabled={anySyncBusy}
                          data-testid={`context-item-editor-pull-provider-${testSuffix}`}
                        >
                          <ArrowDownCircle className="size-3" />
                          {thisPulling ? 'Pulling...' : 'File → Database'}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Overwrite skill content in the Database with the contents of {label}'s
                        File.
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {onSyncProviderToDisk && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1"
                          onClick={() => void handleSyncProvider(representative)}
                          disabled={anySyncBusy}
                          data-testid={`context-item-editor-sync-provider-${testSuffix}`}
                        >
                          <ArrowUpCircle className="size-3" />
                          {thisSyncing ? 'Syncing...' : 'Database → File'}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Overwrite {label}'s File with the current skill content from the
                        Database.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
