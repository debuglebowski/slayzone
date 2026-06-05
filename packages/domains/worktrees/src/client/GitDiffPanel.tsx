import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Minus,
  Undo2,
  ChevronRight,
  GitMerge,
  CheckCircle2,
  FileDiff,
  UnfoldVertical,
  FoldVertical
} from 'lucide-react'
import {
  Button,
  FileTree,
  cn,
  buttonVariants,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  PulseGrid,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@slayzone/ui'
import { useAppearance } from '@slayzone/settings/client'
import { DiffView } from './DiffView'
import type {
  ConfirmAction,
  FileEntry,
  GitDiffPanelHandle,
  GitDiffPanelProps
} from './GitDiffPanel.types'
import {
  STATUS_COLORS,
  HUGE_FILE_THRESHOLD,
  getEntryPath,
  cleanPromptForDisplay
} from './GitDiffPanel.utils'
import { FileListItem, HorizontalResizeHandle } from './GitDiffPanel.components'
import { useGitDiffCollapse } from './useGitDiffCollapse'
import { useGitDiffTurns } from './useGitDiffTurns'
import { useGitDiffData } from './useGitDiffData'
import { useGitDiffFolders } from './useGitDiffFolders'
import { useGitDiffSelection } from './useGitDiffSelection'
import { useGitDiffFlow } from './useGitDiffFlow'
import { useGitDiffActions } from './useGitDiffActions'
import { useGitDiffCommit } from './useGitDiffCommit'
import { useGitDiffLayout } from './useGitDiffLayout'

// Re-export so existing deep imports (`import { GitDiffPanel, type GitDiffPanelHandle }
// from './GitDiffPanel'`) keep working after the type moved to GitDiffPanel.types.
export type { GitDiffPanelHandle } from './GitDiffPanel.types'

export const GitDiffPanel = forwardRef<GitDiffPanelHandle, GitDiffPanelProps>(function GitDiffPanel(
  {
    task,
    projectPath,
    visible,
    pollIntervalMs = 5000,
    mergeState,
    onCommitAndContinueMerge,
    onAbortMerge
  },
  ref
) {
  const isMergeMode = mergeState === 'uncommitted'
  const {
    diffContextLines,
    diffIgnoreWhitespace,
    diffContinuousFlow,
    diffTreeCollapsed,
    diffSideBySide,
    diffWrap
  } = useAppearance()
  const targetPath = useMemo(
    () => task?.worktree_path ?? projectPath,
    [task?.worktree_path, projectPath]
  )

  // Continuous-flow per-file collapse set (persisted per task).
  const { collapsedFiles, setCollapsedFiles } = useGitDiffCollapse(task)

  // Agent-turn selection + the sha range it scopes the snapshot to.
  const { selectedTurnId, setSelectedTurnId, turns, fromSha, toSha, refreshTurns } =
    useGitDiffTurns(targetPath)

  // Shared snapshot + the whole diff read pipeline.
  const {
    snapshot,
    loading,
    fetchError,
    refreshRef,
    stagedEntries,
    unstagedEntries,
    flatEntries,
    stagedTree,
    unstagedTree,
    getDiffForEntry,
    hasAnyChanges
  } = useGitDiffData(targetPath, {
    visible,
    ignoreWhitespace: diffIgnoreWhitespace,
    contextLines: diffContextLines,
    pollIntervalMs,
    fromSha,
    toSha,
    onSnapshotChange: refreshTurns
  })

  useImperativeHandle(
    ref,
    () => ({
      refresh: () => {
        refreshRef.current()
      }
    }),
    [refreshRef]
  )

  // Sidebar folder-tree expansion (+ flattened visible list for keyboard nav).
  const { expandedFolders, toggleFolder, visibleFlatEntries } = useGitDiffFolders(
    stagedTree,
    unstagedTree
  )

  // Single-file selection for non-continuous-flow mode.
  const { selectedFile, handleSelectFile, handleKeyDown, selectedItemRef, selectedDiff } =
    useGitDiffSelection({ flatEntries, visibleFlatEntries, diffContinuousFlow, getDiffForEntry })

  // Continuous-flow virtualized diff list + sticky headers.
  const {
    flowEntries,
    flowRows,
    rowVirtualizer,
    flowScrollRef,
    activeStickyIndexRef,
    userToggledFilesRef
  } = useGitDiffFlow({
    flatEntries,
    getDiffForEntry,
    collapsedFiles,
    selectedFile,
    diffContinuousFlow
  })

  // Git mutation handlers.
  const { handleBulkAction, handleStageAction, handleDiscardFile, handleStageFolderAction } =
    useGitDiffActions({ targetPath, refreshRef })

  // Commit message + commit handler.
  const {
    commitMessage,
    setCommitMessage,
    committing,
    setCommitting,
    commitError,
    setCommitError,
    handleCommit
  } = useGitDiffCommit({ targetPath, stagedCount: stagedEntries.length, refreshRef })

  // Horizontal split sizing.
  const { fileListWidth, handleResize, splitContainerRef } = useGitDiffLayout(hasAnyChanges)

  const error = commitError ?? fetchError

  // Section header collapse toggles.
  const [stagedCollapsed, setStagedCollapsed] = useState(false)
  const [unstagedCollapsed, setUnstagedCollapsed] = useState(false)

  // Confirmation dialog for destructive actions.
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const confirmActionRef = useRef<ConfirmAction | null>(null)
  if (confirmAction) confirmActionRef.current = confirmAction

  const fileListRef = useRef<HTMLDivElement>(null)

  const isSelected = (entry: FileEntry) =>
    selectedFile?.path === entry.path && selectedFile?.source === entry.source

  const renderFileItem = useCallback(
    (entry: FileEntry, { name, depth }: { name: string; depth: number }) => {
      const diff = getDiffForEntry(entry)
      const selected = isSelected(entry)
      const canDiscard = entry.source === 'unstaged'
      return (
        <FileListItem
          entry={entry}
          displayName={name}
          selected={selected}
          additions={diff?.additions}
          deletions={diff?.deletions}
          onClick={() => handleSelectFile(entry.path, entry.source)}
          onAction={() => handleStageAction(entry.path, entry.source)}
          onDiscard={
            canDiscard
              ? () =>
                  setConfirmAction({
                    title: 'Discard Changes',
                    description: `Discard all changes to "${entry.path}"? This cannot be undone.`,
                    actionLabel: 'Discard',
                    destructive: true,
                    onConfirm: () => handleDiscardFile(entry.path, entry.status === '?')
                  })
              : undefined
          }
          itemRef={selected ? selectedItemRef : undefined}
          depth={depth}
        />
      )
    },
    [getDiffForEntry, selectedFile, handleSelectFile, handleStageAction, handleDiscardFile]
  )

  const stagedFolderActions = useCallback(
    (folder: { name: string; path: string }) => (
      <span
        className="shrink-0 opacity-0 group-hover/folder:opacity-100 hover:text-foreground text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
        onClick={(e) => {
          e.stopPropagation()
          handleStageFolderAction(folder.path, 'staged')
        }}
        title="Unstage folder"
      >
        <Minus className="size-3.5" />
      </span>
    ),
    [handleStageFolderAction]
  )

  const unstagedFolderActions = useCallback(
    (folder: { name: string; path: string }) => (
      <>
        <span
          className="shrink-0 opacity-0 group-hover/folder:opacity-100 hover:text-destructive text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation()
            setConfirmAction({
              title: 'Discard Folder Changes',
              description: `Discard all changes in "${folder.name}"? This cannot be undone.`,
              actionLabel: 'Discard',
              destructive: true,
              onConfirm: () => handleDiscardFile(folder.path)
            })
          }}
          title="Discard folder changes"
        >
          <Undo2 className="size-3.5" />
        </span>
        <span
          className="shrink-0 opacity-0 group-hover/folder:opacity-100 hover:text-foreground text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation()
            handleStageFolderAction(folder.path, 'unstaged')
          }}
          title="Stage folder"
        >
          <Plus className="size-3.5" />
        </span>
      </>
    ),
    [handleStageFolderAction, handleDiscardFile]
  )

  const commitInputBlock = (
    <div className="shrink-0 p-2 border-t space-y-1.5">
      <textarea
        className="w-full resize-none rounded border bg-transparent px-2 py-1.5 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        style={{ maxHeight: 120 }}
        placeholder="Commit message"
        rows={3}
        value={commitMessage}
        onChange={(e) => {
          setCommitMessage(e.target.value)
          const el = e.target
          el.style.height = 'auto'
          el.style.height = `${Math.min(el.scrollHeight, 120)}px`
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            handleCommit()
          }
        }}
      />
      {isMergeMode && onCommitAndContinueMerge ? (
        <Button
          variant="default"
          size="sm"
          className="w-full h-7 text-xs"
          disabled={committing}
          onClick={async () => {
            setCommitting(true)
            try {
              await onCommitAndContinueMerge()
            } catch (err) {
              setCommitError(err instanceof Error ? err.message : String(err))
            } finally {
              setCommitting(false)
            }
          }}
        >
          {committing ? 'Committing...' : 'Commit & Continue Merge'}
        </Button>
      ) : (
        <Button
          variant="default"
          size="sm"
          className="w-full h-7 text-xs"
          disabled={!commitMessage.trim() || stagedEntries.length === 0 || committing}
          onClick={handleCommit}
        >
          {committing
            ? 'Committing...'
            : `Commit${stagedEntries.length > 0 ? ` (${stagedEntries.length} staged)` : ''}`}
        </Button>
      )}
    </div>
  )

  return (
    <div data-testid="git-diff-panel" className="h-full flex flex-col">
      {/* Merge-mode banner */}
      {isMergeMode && (
        <div className="shrink-0 px-4 py-2 bg-purple-500/10 border-b flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GitMerge className="h-3.5 w-3.5 text-purple-400" />
            <span className="text-xs font-medium text-purple-300">
              Stage and commit your changes to continue the merge
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {onAbortMerge && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={() =>
                  setConfirmAction({
                    title: 'Abort Merge',
                    description: 'Abort the current merge? All merge progress will be lost.',
                    actionLabel: 'Abort',
                    destructive: true,
                    onConfirm: onAbortMerge
                  })
                }
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Turns chip row — panel-level so its DOM identity (and horizontal scroll
          position) survives snapshot key changes that swap the main-content branch
          below (selecting a turn re-keys useGitDiffSnapshot → momentary snapshot=null
          → main split unmounts). Keep mounted across dirty↔clean transitions; the
          "All turns" button is always meaningful when continuous-flow is on. */}
      {targetPath && diffContinuousFlow && (
        <TooltipProvider delayDuration={300}>
          <div className="shrink-0 h-9 flex items-center px-2 bg-muted/30 border-b">
            <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
              <button
                onClick={() => setSelectedTurnId('all')}
                className={cn(
                  'shrink-0 inline-flex items-center justify-center px-3 h-6 rounded-full text-[11px] leading-none font-medium border transition-colors',
                  selectedTurnId === 'all'
                    ? 'bg-muted text-foreground border-foreground/30'
                    : 'bg-background hover:bg-muted text-muted-foreground border-border'
                )}
              >
                All turns
              </button>
              {[...turns].reverse().map((t, idx) => {
                // Newest = highest number. With turns sorted oldest→newest,
                // reversed iteration starts at newest (idx 0) → n = length - idx.
                const n = turns.length - idx
                const active = selectedTurnId === t.id
                const promptClean = t.prompt_preview ? cleanPromptForDisplay(t.prompt_preview) : ''
                const hasTip = !!(t.task_title || promptClean)
                return (
                  <Tooltip key={t.id}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setSelectedTurnId(t.id)}
                        className={cn(
                          'shrink-0 inline-flex items-center justify-center px-3 h-6 rounded-full text-[11px] leading-none font-medium border transition-colors',
                          active
                            ? 'bg-muted text-foreground border-foreground/30'
                            : 'bg-background hover:bg-muted text-muted-foreground border-border'
                        )}
                      >
                        Turn {n}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="max-w-xs">
                      {hasTip ? (
                        <>
                          {t.task_title && <p className="text-sm font-semibold">{t.task_title}</p>}
                          {promptClean && (
                            <p
                              className={cn(
                                'text-xs italic line-clamp-4 break-words',
                                t.task_title && 'mt-1'
                              )}
                            >
                              {promptClean}
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-sm font-semibold">Turn {n}</p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
            {flatEntries.length > 0 && (
              <div className="shrink-0 flex items-center gap-0.5 pl-8">
                <button
                  onClick={() => {
                    // Mark every current file as user-toggled so auto-collapse
                    // of huge files stays overridden after Expand all.
                    for (const e of flatEntries)
                      userToggledFilesRef.current.add(`${e.source}:${e.path}`)
                    setCollapsedFiles(new Set())
                  }}
                  title="Expand all files"
                  className="size-6 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <UnfoldVertical className="size-3.5" />
                </button>
                <button
                  onClick={() => {
                    for (const e of flatEntries)
                      userToggledFilesRef.current.add(`${e.source}:${e.path}`)
                    setCollapsedFiles(new Set(flatEntries.map((e) => `${e.source}:${e.path}`)))
                  }}
                  title="Collapse all files"
                  className="size-6 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <FoldVertical className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        </TooltipProvider>
      )}

      {/* Empty states */}
      {!targetPath && (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-muted-foreground">
            Set a project path or worktree to view git diff
          </p>
        </div>
      )}

      {targetPath && !error && loading && !snapshot && (
        <div className="flex-1 min-h-0">
          <PulseGrid />
        </div>
      )}

      {targetPath && error && (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {targetPath && !error && !loading && snapshot && !hasAnyChanges && (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <CheckCircle2 className="size-10 opacity-30" />
            <div className="text-center">
              <p className="text-base font-medium text-foreground/60">Working tree clean</p>
              <p className="text-sm mt-0.5 opacity-60">No uncommitted changes</p>
            </div>
          </div>
        </div>
      )}

      {/* Main content: horizontal split */}
      {targetPath && !error && snapshot && hasAnyChanges && (
        <div ref={splitContainerRef} className="flex-1 min-h-0 flex">
          {/* Left: file lists + commit.
              Always shown in non-continuous-flow mode — the right pane needs a
              file selected to render anything, so the list must stay reachable.
              The `diff_tree_collapsed` toggle only applies in continuous-flow. */}
          {(!diffTreeCollapsed || !diffContinuousFlow) && (
            <div
              className="shrink-0 flex flex-col min-h-0 border-r"
              style={{ width: fileListWidth }}
            >
              <div
                ref={fileListRef}
                className="flex-1 min-h-0 overflow-y-auto outline-none"
                tabIndex={0}
                onKeyDown={handleKeyDown}
              >
                {/* Staged section */}
                {stagedEntries.length > 0 && (
                  <div>
                    <div
                      className="h-[30px] px-3 text-[11px] font-medium text-muted-foreground uppercase tracking-wide bg-muted border-b sticky top-0 z-10 flex items-center justify-between cursor-pointer select-none"
                      onClick={() => setStagedCollapsed((v) => !v)}
                    >
                      <span className="flex items-center gap-1">
                        <ChevronRight
                          className={cn(
                            'size-3 transition-transform',
                            !stagedCollapsed && 'rotate-90'
                          )}
                        />
                        Staged ({stagedEntries.length})
                      </span>
                      <button
                        className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded hover:bg-accent"
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmAction({
                            title: 'Unstage All',
                            description: `Unstage all ${stagedEntries.length} files?`,
                            actionLabel: 'Unstage All',
                            onConfirm: () => handleBulkAction('unstageAll')
                          })
                        }}
                        title="Unstage all"
                      >
                        <Minus className="size-3.5" />
                      </button>
                    </div>
                    {!stagedCollapsed && (
                      <FileTree
                        items={stagedEntries}
                        getPath={getEntryPath}
                        compress
                        expandedFolders={expandedFolders}
                        onToggleFolder={toggleFolder}
                        renderFile={renderFileItem}
                        folderActions={stagedFolderActions}
                      />
                    )}
                  </div>
                )}

                {/* Unstaged section */}
                {unstagedEntries.length > 0 && (
                  <div>
                    <div
                      className="h-[30px] px-3 text-[11px] font-medium text-muted-foreground uppercase tracking-wide bg-muted border-b sticky top-0 z-10 flex items-center justify-between cursor-pointer select-none"
                      onClick={() => setUnstagedCollapsed((v) => !v)}
                    >
                      <span className="flex items-center gap-1">
                        <ChevronRight
                          className={cn(
                            'size-3 transition-transform',
                            !unstagedCollapsed && 'rotate-90'
                          )}
                        />
                        Unstaged ({unstagedEntries.length})
                      </span>
                      <button
                        className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded hover:bg-accent"
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmAction({
                            title: 'Stage All',
                            description: `Stage all ${unstagedEntries.length} files?`,
                            actionLabel: 'Stage All',
                            onConfirm: () => handleBulkAction('stageAll')
                          })
                        }}
                        title="Stage all"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    </div>
                    {!unstagedCollapsed && (
                      <FileTree
                        items={unstagedEntries}
                        getPath={getEntryPath}
                        compress
                        expandedFolders={expandedFolders}
                        onToggleFolder={toggleFolder}
                        renderFile={renderFileItem}
                        folderActions={unstagedFolderActions}
                      />
                    )}
                  </div>
                )}
              </div>

              {/* Commit input — pinned to bottom of sidebar */}
              {commitInputBlock}
            </div>
          )}

          {/* Resize handle — match the file-list visibility condition. */}
          {(!diffTreeCollapsed || !diffContinuousFlow) && (
            <HorizontalResizeHandle onDrag={handleResize} />
          )}

          {/* Right: diff viewer */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {/* Body */}
            {diffContinuousFlow ? (
              <div className="flex-1 min-h-0 flex flex-col pt-2">
                {flowEntries.length === 0 ? (
                  <div className="flex-1 min-h-0 flex items-center justify-center p-6">
                    <p className="text-xs text-muted-foreground">No changes</p>
                  </div>
                ) : (
                  <div
                    ref={flowScrollRef}
                    className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-2"
                  >
                    <div
                      style={{
                        height: rowVirtualizer.getTotalSize(),
                        position: 'relative',
                        width: '100%'
                      }}
                    >
                      {rowVirtualizer.getVirtualItems().map((v) => {
                        const row = flowRows[v.index]
                        if (!row) return null
                        const { entry, diff, fileKey } = row
                        const userToggled = userToggledFilesRef.current.has(fileKey)
                        const explicitlyCollapsed = collapsedFiles.has(fileKey)
                        const autoCollapsed =
                          !userToggled && diff.additions + diff.deletions > HUGE_FILE_THRESHOLD
                        const collapsed = explicitlyCollapsed || autoCollapsed
                        const isActiveSticky = v.index === activeStickyIndexRef.current
                        const isHeader = row.kind === 'header'

                        // Sticky pattern: the active header uses `position: sticky`
                        // (no transform) so it pins at top: 0 of the scroll parent
                        // while its body scrolls. All other rows use the standard
                        // `position: absolute` + translateY placement.
                        const style: React.CSSProperties =
                          isHeader && isActiveSticky
                            ? {
                                position: 'sticky',
                                top: 0,
                                left: 0,
                                right: 0,
                                zIndex: 20
                              }
                            : {
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                right: 0,
                                transform: `translateY(${v.start}px)`
                              }

                        if (isHeader) {
                          return (
                            <div
                              key={v.key}
                              data-index={v.index}
                              ref={rowVirtualizer.measureElement}
                              style={collapsed ? { ...style, paddingBottom: 8 } : style}
                            >
                              <div
                                className={cn(
                                  'h-10 px-3 text-xs font-medium bg-muted border border-border flex items-center gap-2 cursor-pointer select-none hover:bg-muted/80',
                                  collapsed ? 'rounded-lg' : 'rounded-t-lg'
                                )}
                                onClick={() => {
                                  // Record user intent so auto-collapse won't override the toggle.
                                  userToggledFilesRef.current.add(fileKey)
                                  setCollapsedFiles((prev) => {
                                    const next = new Set(prev)
                                    // If currently collapsed (explicitly or auto), expand → remove from set.
                                    // Otherwise collapse → add to set.
                                    if (collapsed) next.delete(fileKey)
                                    else next.add(fileKey)
                                    return next
                                  })
                                }}
                              >
                                <ChevronRight
                                  className={cn(
                                    'size-3 shrink-0 transition-transform text-muted-foreground',
                                    !collapsed && 'rotate-90'
                                  )}
                                />
                                <span className={cn('font-bold', STATUS_COLORS[entry.status])}>
                                  {entry.status}
                                </span>
                                <span className="truncate">{entry.path}</span>
                                <span className="ml-auto text-[10px] text-muted-foreground tabular-nums space-x-1">
                                  {diff.additions > 0 && (
                                    <span className="text-green-600 dark:text-green-400">
                                      +{diff.additions}
                                    </span>
                                  )}
                                  {diff.deletions > 0 && (
                                    <span className="text-red-600 dark:text-red-400">
                                      -{diff.deletions}
                                    </span>
                                  )}
                                </span>
                              </div>
                            </div>
                          )
                        }

                        // Body row — only emitted for expanded files.
                        return (
                          <div
                            key={v.key}
                            data-index={v.index}
                            ref={rowVirtualizer.measureElement}
                            style={{ ...style, paddingBottom: 8 }}
                          >
                            <div className="overflow-hidden rounded-b-lg border-x border-b border-border bg-card shadow-sm">
                              <DiffView
                                diff={diff}
                                sideBySide={diffSideBySide}
                                wrap={diffWrap}
                                contextLines={diffContextLines}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                {!selectedFile && (
                  <div className="flex-1 flex items-center justify-center p-6">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <FileDiff className="size-10 opacity-30" />
                      <div className="text-center">
                        <p className="text-base font-medium text-foreground/60">No file selected</p>
                        <p className="text-sm mt-0.5 opacity-60">
                          Pick a file from the list to view its diff
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                {selectedFile && !selectedDiff && (
                  <div className="flex-1 flex items-center justify-center p-6">
                    <p className="text-xs text-muted-foreground">
                      {flatEntries.find(
                        (f) => f.path === selectedFile.path && f.source === selectedFile.source
                      )?.status === '?'
                        ? 'Loading...'
                        : 'No diff content'}
                    </p>
                  </div>
                )}
                {selectedFile && selectedDiff && (
                  <div className="flex-1 min-h-0 overflow-auto">
                    <DiffView
                      diff={selectedDiff}
                      sideBySide={diffSideBySide}
                      wrap={diffWrap}
                      contextLines={diffContextLines}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Confirmation dialog for destructive actions */}
      <AlertDialog
        open={!!confirmAction}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmActionRef.current?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmActionRef.current?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirmActionRef.current?.destructive
                  ? buttonVariants({ variant: 'destructive' })
                  : undefined
              }
              onClick={() => confirmActionRef.current?.onConfirm()}
            >
              {confirmActionRef.current?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
