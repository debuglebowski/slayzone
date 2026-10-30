import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileDiff as FileDiffIcon, X } from 'lucide-react'
import { cn, IconButton } from '@slayzone/ui'
import type { TimelineRows, ToolInvocation } from '@slayzone/terminal/client'
import { ChatDiffView } from '../diff-comments/ChatDiffView'
import { CardBadge, FileLink } from '../tool-cards/links'
import { LineCounts } from './FilesChangedRow'
import { relativeToCwd } from './relative-path'
import {
  collectSessionFileChanges,
  combinedFileDiff,
  type CombinedFileDiff,
  type SessionFileChange
} from './session-file-changes'

/** Above this many files the sections start closed (the list stays scannable). */
const OPEN_ALL_UP_TO = 8

// Done calls never change, so a file's diff is keyed by its last call and how
// many calls it has: reopening the panel or a new event elsewhere reuses it.
const combinedCache = new WeakMap<ToolInvocation, { count: number; value: CombinedFileDiff }>()
function combinedOf(change: SessionFileChange): CombinedFileDiff {
  const last = change.edits[change.edits.length - 1].invocation
  const hit = combinedCache.get(last)
  if (hit && hit.count === change.edits.length) return hit.value
  const value = combinedFileDiff(change)
  combinedCache.set(last, { count: change.edits.length, value })
  return value
}

/**
 * Every file the agent's file tools changed in this conversation, each with one
 * diff from before its first change to after its last. Shell commands are
 * named, not guessed at: what they changed is not in the agent's stream.
 */
export function FilesChangedPanel({
  timeline,
  cwd,
  focusPath,
  focusSeq,
  onClose,
  className
}: {
  timeline: Readonly<TimelineRows>
  cwd: string
  /** The file to open and scroll to. */
  focusPath?: string
  /** Bumped on every request, so asking for the same file again scrolls to it again. */
  focusSeq?: number
  onClose: () => void
  className?: string
}) {
  const { files, shellCommands } = useMemo(() => collectSessionFileChanges(timeline), [timeline])
  const listRef = useRef<HTMLDivElement>(null)

  // Bring the asked-for file into view (each time a file is asked for).
  useEffect(() => {
    if (!focusPath) return
    const el = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-testid="chat-files-panel-file"]') ?? []
    ).find((s) => s.dataset.path === focusPath)
    el?.scrollIntoView?.({ block: 'start' })
  }, [focusPath, focusSeq])

  return (
    <aside
      data-testid="chat-files-panel"
      aria-label="Files changed"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault()
          onClose()
        }
      }}
      className={cn('flex min-h-0 flex-col bg-background focus:outline-none', className)}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <FileDiffIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Files changed</span>
        <span className="text-muted-foreground">{files.length}</span>
        <div className="flex-1" />
        <IconButton
          variant="ghost"
          className="size-6"
          aria-label="Close files changed"
          data-testid="chat-files-panel-close"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </IconButton>
      </header>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-3 pt-2 text-[11px] text-muted-foreground">
          What the agent's file tools changed in this conversation, one diff per file.
        </p>
        {shellCommands > 0 && (
          <p
            data-testid="chat-files-panel-shell-note"
            className="px-3 pt-1 text-[11px] text-muted-foreground"
          >
            {shellCommands} shell command{shellCommands === 1 ? '' : 's'} ran too: files changed by
            shell commands can't be seen here.
          </p>
        )}
        {files.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No files changed yet.
          </p>
        ) : (
          <div className="py-2">
            {files.map((change) => (
              <FileSection
                key={change.path}
                change={change}
                cwd={cwd}
                defaultOpen={focusPath ? focusPath === change.path : files.length <= OPEN_ALL_UP_TO}
                focused={focusPath === change.path}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function FileSection({
  change,
  cwd,
  defaultOpen,
  focused
}: {
  change: SessionFileChange
  cwd: string
  defaultOpen: boolean
  focused: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  // Asked for again (a row's file) while the panel stays open: open it.
  const [wasFocused, setWasFocused] = useState(focused)
  if (focused !== wasFocused) {
    setWasFocused(focused)
    if (focused) setOpen(true)
  }
  const combined = combinedOf(change)
  const counts =
    combined.mode === 'combined'
      ? { additions: combined.diff.additions, deletions: combined.diff.deletions }
      : { additions: null, deletions: null }
  const edits = change.edits.length
  return (
    <section
      data-testid="chat-files-panel-file"
      data-path={change.path}
      className="border-b border-border/40 last:border-b-0"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 items-center gap-1.5 text-left"
          title={change.path}
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono text-[11px] [direction:rtl]">
            <bdi>{relativeToCwd(change.path, cwd)}</bdi>
          </span>
        </button>
        {change.created && <CardBadge>New</CardBadge>}
        <LineCounts {...counts} />
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {edits} edit{edits === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <FileLink path={change.path} label="Open" />
      </div>
      {open && <FileBody combined={combined} />}
    </section>
  )
}

function FileBody({ combined }: { combined: CombinedFileDiff }) {
  if (combined.mode === 'combined') {
    return (
      <div className="px-1 pb-2">
        {combined.outsideChanges && (
          <p
            data-testid="chat-files-panel-outside-note"
            className="px-2 pb-1 text-[11px] text-warning-foreground"
          >
            The file also changed between the agent's edits (a shell command, or you); the diff
            includes that.
          </p>
        )}
        <ChatDiffView diff={combined.diff} />
      </div>
    )
  }
  return (
    <div className="px-1 pb-2">
      <p
        data-testid="chat-files-panel-separate-note"
        className="px-2 pb-1 text-[11px] text-muted-foreground"
      >
        {combined.why === 'notebook'
          ? 'Notebook cell edits, one by one.'
          : "The file's content before these edits isn't known, so they are shown one by one."}
      </p>
      <div className="grid gap-1.5">
        {combined.edits.map(({ edit, diff }) =>
          diff ? (
            <ChatDiffView key={edit.toolUseId} diff={diff} />
          ) : (
            <p key={edit.toolUseId} className="px-2 text-[11px] text-muted-foreground">
              No diff for this edit.
            </p>
          )
        )}
      </div>
    </div>
  )
}
