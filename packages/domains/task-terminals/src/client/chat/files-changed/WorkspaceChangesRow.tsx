import { useId, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FileDiff } from 'lucide-react'
import { parseUnifiedDiff } from '@slayzone/diff-view'
import type { WorkspaceFileDiff } from '@slayzone/terminal-contracts'
import type { TimelineItem } from '@slayzone/terminal/client'
import { cn } from '@slayzone/ui'
import { useTRPCClient } from '../../trpc'
import { useRowUiState } from '../row-ui-state'
import { ChatDiffView } from '../diff-comments/ChatDiffView'
import { useChatView } from '../ChatViewContext'
import { FilesChangedRow, useShowFileChange } from './FilesChangedRow'
import { relativeToCwd } from './relative-path'
import { turnChangeSources, type RecordedChanges } from './turn-changes'
import { AnswerFooterPanel } from '../answer-footer-panel'

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

function SavedFile({
  item,
  file,
  recorded,
  focusPath,
  renderRecordedFile,
  rootPath
}: {
  item: Row
  file: WorkspaceFileDiff
  rootPath?: string
  recorded?: RecordedChanges
  focusPath?: string
  renderRecordedFile?: (path: string) => ReactNode
}) {
  const { cwd, finalOnly } = useChatView()
  const [editsOpen, setEditsOpen] = useState(false)
  const show = useShowFileChange(item.captureId)
  const focused =
    !!focusPath &&
    (relativeToCwd(focusPath, rootPath ?? cwd) === file.path ||
      relativeToCwd(focusPath, rootPath ?? cwd) === file.oldPath)
  const toolFile = recorded?.files.find((change) => {
    const path = relativeToCwd(change.path, rootPath ?? cwd)
    return path === file.path || path === file.oldPath
  })
  const [open, setOpen] = useState(focused)
  const [wasFocused, setWasFocused] = useState(focused)
  if (wasFocused !== focused) {
    setWasFocused(focused)
    if (focused) setOpen(true)
  }
  return (
    <div
      className="border-t border-border/50"
      data-testid="chat-files-panel-file"
      data-path={file.path}
      ref={(node) => {
        if (node && focused) node.scrollIntoView?.({ block: 'start' })
      }}
    >
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
      {open && toolFile && (!finalOnly || renderRecordedFile) && (
        <button
          type="button"
          className="px-3 pb-2 text-xs underline"
          onClick={() => (finalOnly ? setEditsOpen(!editsOpen) : show(toolFile))}
        >
          View recorded edits
        </button>
      )}
      {open && editsOpen && toolFile && renderRecordedFile?.(toolFile.path)}
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

/** One turn summary: filesystem result takes precedence over tool activity. */
export function WorkspaceChangesRow({ item, embedded = false }: { item: Row; embedded?: boolean }) {
  const [open, setOpen] = useRowUiState('workspace-changes', false, false)
  const id = useId()
  const { filesPanel, timeline } = useChatView()
  const recorded = [...turnChangeSources(timeline)].find(
    ([row]) => row.captureId === item.captureId
  )?.[1]
  if (item.status === 'unavailable' && recorded) {
    return <FilesChangedRow item={recorded} embedded={embedded} captureId={item.captureId} />
  }
  // Failed capture + no recorded edits = nothing to show. An agent-cut turn keeps its card:
  // it is that turn's only "Turn interrupted" signal.
  if (item.status === 'unavailable' && !item.interrupted) return null
  // Nothing changed and nothing was edited: no card. Reverted edits keep their true zero.
  if (item.status === 'complete' && item.fileCount === 0 && !recorded) return null
  const label =
    item.status === 'pending'
      ? 'Checking changes…'
      : item.status === 'unavailable'
        ? 'Turn interrupted'
        : `${item.fileCount} file${item.fileCount === 1 ? '' : 's'} changed${item.status === 'partial' ? ' · partial' : ''}`
  return (
    <div className={embedded ? 'contents' : 'px-10 py-1'} data-testid="chat-files-changed">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (filesPanel ? filesPanel.open(undefined, item.captureId) : setOpen(!open))}
        className="flex w-fit max-w-full items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-3 py-1.5 text-left text-xs shadow-sm hover:bg-muted/40"
      >
        <FileDiff className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-medium">{label}</span>
        <ChevronRight className={cn('size-3 shrink-0', open && 'rotate-90')} />
      </button>
      {open && (
        <AnswerFooterPanel>
          <div id={id} className="order-3 min-w-0 basis-full">
            <WorkspaceChangesContent item={item} recorded={recorded} />
          </div>
        </AnswerFooterPanel>
      )}
    </div>
  )
}

/** Shared by inline disclosure and the existing files-changed panel. */
export function WorkspaceChangesContent({
  item,
  recorded,
  renderRecorded,
  focusPath,
  renderRecordedFile
}: {
  item: Row
  recorded?: RecordedChanges
  renderRecorded?: () => ReactNode
  renderRecordedFile?: (path: string) => ReactNode
  focusPath?: string
}) {
  const client = useTRPCClient()
  const query = useQuery({
    queryKey: ['chat-workspace-changes', item.tabId, item.captureId, item.status],
    queryFn: () =>
      client.chat.workspaceChanges.get.query({ tabId: item.tabId, captureId: item.captureId }),
    staleTime: item.status === 'pending' ? 0 : Infinity
  })
  const status = query.data?.status ?? item.status
  const reason = query.data?.reason ?? item.reason
  const fallback = status === 'unavailable' || query.isError || (!query.isPending && !query.data)
  return (
    <>
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {fallback
          ? 'Recorded edits only. Workspace capture unavailable.'
          : 'Net changes during this turn may include manual edits or other agents.'}
      </p>
      {reason && <p className="px-3 pb-2 text-xs text-muted-foreground">{reason}</p>}
      {fallback ? (
        <>
          {renderRecorded ? (
            renderRecorded()
          ) : recorded ? (
            <FilesChangedRow item={recorded} embedded captureId={item.captureId} />
          ) : null}
          {query.isError && (
            <button
              type="button"
              className="px-3 pb-3 text-xs underline"
              onClick={() => void query.refetch()}
            >
              Retry saved changes
            </button>
          )}
        </>
      ) : query.isPending ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">Loading saved changes…</p>
      ) : query.data ? (
        <>
          {status === 'partial' && (
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              Partial capture; some changes may be missing.
            </p>
          )}
          {query.data.files.map((file) => (
            <SavedFile
              key={file.path}
              item={item}
              file={file}
              recorded={recorded}
              rootPath={query.data?.rootPath}
              focusPath={focusPath}
              renderRecordedFile={renderRecordedFile}
            />
          ))}
          {!query.data.files.length && status === 'complete' && (
            <p className="px-3 pb-3 text-xs text-muted-foreground">
              No net changes during this turn.
            </p>
          )}
        </>
      ) : (
        <p className="px-3 pb-3 text-xs text-muted-foreground">Saved changes unavailable.</p>
      )}
    </>
  )
}
