import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FolderGit2 } from 'lucide-react'
import { parseUnifiedDiff } from '@slayzone/diff-view'
import type { WorkspaceFileDiff } from '@slayzone/terminal-contracts'
import type { TimelineItem } from '@slayzone/terminal/client'
import { cn } from '@slayzone/ui'
import { useTRPCClient } from '../../trpc'
import { useRowUiState } from '../row-ui-state'
import { ChatDiffView } from '../diff-comments/ChatDiffView'

type Row = Extract<TimelineItem, { kind: 'workspace-changes' }>

function SavedDiff({ item, file }: { item: Row; file: WorkspaceFileDiff }) {
  const client = useTRPCClient()
  const query = useQuery({
    queryKey: ['chat-workspace-diff', item.tabId, item.captureId, file.path],
    queryFn: () =>
      client.chat.workspaceChanges.getFileDiff.query({
        tabId: item.tabId,
        captureId: item.captureId,
        path: file.path
      }),
    staleTime: Infinity
  })
  if (query.isPending)
    return <p className="p-3 text-xs text-muted-foreground">Loading saved diff…</p>
  if (query.isError)
    return (
      <p className="p-3 text-xs text-muted-foreground">
        Couldn’t load saved diff.{' '}
        <button type="button" className="underline" onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    )
  const diffs = parseUnifiedDiff(query.data ?? '')
  return (
    <>
      {diffs.length ? (
        diffs.map((diff, index) => <ChatDiffView key={index} diff={diff} />)
      ) : (
        <p className="p-3 text-xs text-muted-foreground">No text diff available.</p>
      )}
    </>
  )
}

function SavedFile({ item, file }: { item: Row; file: WorkspaceFileDiff }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-border/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40"
      >
        <ChevronRight className={cn('size-3 shrink-0', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 break-all font-mono">
          {file.oldPath ? `${file.oldPath} → ` : ''}
          {file.path}
        </span>
        <span className="text-muted-foreground">{file.kind}</span>
        {file.additions !== null && (
          <span className="text-green-600 dark:text-green-400">+{file.additions}</span>
        )}
        {file.deletions !== null && (
          <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
        )}
      </button>
      {open &&
        (file.hasDiff ? (
          <SavedDiff item={item} file={file} />
        ) : (
          <p className="px-3 pb-3 text-xs text-muted-foreground">
            {file.binary
              ? 'Binary file; no text diff.'
              : file.omitted === 'size-limit'
                ? 'Text diff exceeded capture limits.'
                : 'Text diff unavailable.'}
          </p>
        ))}
    </div>
  )
}

/** Saved net changes during a turn, kept separate from exact file-tool activity. */
export function WorkspaceChangesRow({ item }: { item: Row }) {
  const [open, setOpen] = useRowUiState('workspace-changes', false, false)
  const id = useId()
  const client = useTRPCClient()
  const query = useQuery({
    queryKey: ['chat-workspace-changes', item.tabId, item.captureId, item.status],
    queryFn: () =>
      client.chat.workspaceChanges.get.query({ tabId: item.tabId, captureId: item.captureId }),
    enabled: open,
    staleTime: item.status === 'pending' ? 0 : Infinity
  })
  const status = query.data?.status ?? item.status
  const reason = query.data?.reason ?? item.reason
  const count = query.data?.files.length ?? item.fileCount
  return (
    <div
      className="mx-4 my-1 min-w-0 rounded-lg border border-border/50 sm:ml-14"
      data-testid="chat-workspace-changes"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40"
      >
        <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">Workspace changes during this turn</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {status === 'pending'
            ? 'Checking…'
            : status === 'unavailable'
              ? 'Unavailable'
              : `${count} ${count === 1 ? 'file' : 'files'}${status === 'partial' ? ' · partial' : ''}`}
        </span>
        <ChevronRight className={cn('size-3 shrink-0', open && 'rotate-90')} />
      </button>
      {open && (
        <div id={id}>
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Net changes between this turn’s start and end. Other tasks or manual edits may
            contribute.
          </p>
          {reason && <p className="px-3 pb-2 text-xs text-muted-foreground">{reason}</p>}
          {query.isPending ? (
            <p className="px-3 pb-3 text-xs text-muted-foreground">Loading saved changes…</p>
          ) : query.isError ? (
            <p className="px-3 pb-3 text-xs text-muted-foreground">
              Couldn’t load saved changes.{' '}
              <button type="button" className="underline" onClick={() => void query.refetch()}>
                Retry
              </button>
            </p>
          ) : query.data ? (
            <>
              {query.data.files.map((file) => (
                <SavedFile key={file.path} item={item} file={file} />
              ))}
              {!count && status === 'complete' && (
                <p className="px-3 pb-3 text-xs text-muted-foreground">
                  No workspace changes during this turn.
                </p>
              )}
            </>
          ) : (
            <p className="px-3 pb-3 text-xs text-muted-foreground">Saved changes unavailable.</p>
          )}
        </div>
      )}
    </div>
  )
}
