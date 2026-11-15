import { useEffect, useState } from 'react'
import { File, Folder, Lock } from 'lucide-react'
import type { ArchiveListing } from '../shared/types'
import { useTRPCClient } from './trpc'

/** `2048` → `2 KB`; `1536` → `1.5 KB`; under 1 KB in bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const shown = value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')
  return `${shown} ${units[unit]}`
}

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; listing: ArchiveListing }
  | { kind: 'error'; message: string }

/**
 * A zip artifact's entries. The hub reads only the archive's central directory
 * (`artifacts.listArchive`), so a large archive lists without being downloaded.
 */
export function ArchiveViewer({
  artifactId,
  contentVersion
}: {
  artifactId: string
  contentVersion: number
}) {
  const trpcClient = useTRPCClient()
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    trpcClient.artifacts.listArchive.query({ id: artifactId }).then(
      (listing) => {
        if (cancelled) return
        setState(
          listing
            ? { kind: 'ok', listing }
            : { kind: 'error', message: 'This archive no longer exists.' }
        )
      },
      (e: unknown) => {
        if (!cancelled)
          setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [trpcClient, artifactId, contentVersion, attempt])

  if (state.kind === 'loading')
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        Loading...
      </div>
    )
  if (state.kind === 'error')
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
        <span data-testid="archive-error" className="text-destructive">
          {state.message}
        </span>
        <button
          type="button"
          className="underline hover:text-foreground"
          onClick={() => {
            setState({ kind: 'loading' })
            setAttempt((n) => n + 1)
          }}
        >
          Retry
        </button>
      </div>
    )

  const { entries, totalEntries, totalSize } = state.listing
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div
        data-testid="archive-summary"
        className="shrink-0 px-4 py-2 border-b border-border text-xs text-muted-foreground"
      >
        {totalEntries} {totalEntries === 1 ? 'entry' : 'entries'} · {formatBytes(totalSize)}{' '}
        uncompressed
        {entries.length < totalEntries ? ` · showing the first ${entries.length}` : ''}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background text-muted-foreground">
            <tr className="text-left">
              <th className="px-4 py-1.5 font-medium">Name</th>
              <th className="px-4 py-1.5 font-medium text-right">Size</th>
              <th className="px-4 py-1.5 font-medium text-right">Packed</th>
              <th className="px-4 py-1.5 font-medium">Modified</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => {
              const Icon = entry.isDirectory ? Folder : File
              return (
                <tr
                  key={`${i}:${entry.path}`}
                  data-testid="archive-entry"
                  className="border-t border-border/50 hover:bg-muted/30"
                >
                  <td className="px-4 py-1 font-mono">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{entry.path}</span>
                      {entry.encrypted && (
                        <Lock
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-label="Encrypted"
                        />
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-1 text-right tabular-nums text-muted-foreground">
                    {entry.isDirectory ? '' : formatBytes(entry.size)}
                  </td>
                  <td className="px-4 py-1 text-right tabular-nums text-muted-foreground">
                    {entry.isDirectory ? '' : formatBytes(entry.compressedSize)}
                  </td>
                  <td className="px-4 py-1 tabular-nums text-muted-foreground whitespace-nowrap">
                    {entry.modified?.replace('T', ' ').slice(0, 16) ?? ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
