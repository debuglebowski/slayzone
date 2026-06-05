import {
  File,
  FilePlus,
  Link,
  Unlink,
  RefreshCw,
  Check,
  AlertCircle,
  Circle,
  Pencil,
  Trash2
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  fileTreeIndent,
  cn
} from '@slayzone/ui'
import type { CliProvider, ContextTreeEntry } from '../shared'
import { contextEntryToSyncHealth } from './sync-view-model'

function SyncBadge({ entry }: { entry: ContextTreeEntry }) {
  const health = entry.syncHealth
  if (health === 'synced') {
    return (
      <span
        className="flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400"
        title="Synced with source"
        aria-label="Synced with source"
      >
        <Check className="size-3" />
      </span>
    )
  }
  if (health === 'stale') {
    return (
      <span
        className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"
        title="Out of sync with source"
        aria-label="Out of sync with source"
      >
        <AlertCircle className="size-3" />
      </span>
    )
  }
  if (health !== 'unmanaged') return null
  return (
    <span
      className="flex items-center gap-1 text-[11px] text-muted-foreground"
      title="Unmanaged (File exists but not linked in Database)"
      aria-label="Unmanaged file"
    >
      <Circle className="size-3" />
    </span>
  )
}

function ProviderBadge({ provider }: { provider?: CliProvider }) {
  if (!provider) return null
  return (
    <span
      className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase text-muted-foreground"
      title={`Provider: ${provider}`}
      aria-label={`Provider: ${provider}`}
    >
      {provider}
    </span>
  )
}

interface ContextFileRowProps {
  entry: ContextTreeEntry
  name: string
  depth: number
  selected: boolean
  onOpen: (entry: ContextTreeEntry) => void
  onSync: (entry: ContextTreeEntry) => void
  onStartRename: (entry: ContextTreeEntry) => void
  onUnlink: (entry: ContextTreeEntry) => void
  onDelete: (entry: ContextTreeEntry) => void
}

export function ContextFileRow({
  entry,
  name,
  depth,
  selected,
  onOpen,
  onSync,
  onStartRename,
  onUnlink,
  onDelete
}: ContextFileRowProps) {
  const isStaleLinked = !!entry.linkedItemId && contextEntryToSyncHealth(entry) === 'stale'
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group flex w-full select-none items-center gap-1.5 rounded px-1 py-1 text-xs',
            selected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/50',
            !entry.exists && 'text-muted-foreground'
          )}
          style={{ paddingLeft: fileTreeIndent(depth) }}
        >
          <button
            className="flex min-w-0 flex-1 items-center gap-1.5"
            onClick={() => onOpen(entry)}
          >
            {entry.exists ? (
              <span title="File exists" aria-label="File exists">
                <File className="size-3.5 shrink-0" />
              </span>
            ) : (
              <span title="File not created" aria-label="File not created">
                <FilePlus className="size-3.5 shrink-0" />
              </span>
            )}
            <span className="min-w-0 truncate font-mono">{name}</span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <ProviderBadge provider={entry.provider} />
            {entry.linkedItemId && (
              <>
                <span title="Linked to library item" aria-label="Linked to library item">
                  <Link className="size-3 text-muted-foreground" />
                </span>
              </>
            )}
            <SyncBadge entry={entry} />
            {isStaleLinked && (
              <button
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  onSync(entry)
                }}
                title="Sync from library"
              >
                <RefreshCw className="size-3" />
              </button>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onStartRename(entry)}>
          <Pencil className="size-4" /> Rename
        </ContextMenuItem>
        {isStaleLinked && (
          <ContextMenuItem onSelect={() => onSync(entry)}>
            <RefreshCw className="size-4" /> Sync from library
          </ContextMenuItem>
        )}
        {entry.linkedItemId && (
          <ContextMenuItem onSelect={() => onUnlink(entry)}>
            <Unlink className="size-4" /> Unlink from library
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(entry)}>
          <Trash2 className="size-4" /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
