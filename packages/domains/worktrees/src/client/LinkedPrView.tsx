import {
  ExternalLink,
  Unlink,
  ChevronDown,
  ChevronRight,
  GitMerge,
  Loader2,
  MessageSquare,
  Send,
  RefreshCw,
  ChevronsUpDown
} from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import {
  Button,
  IconButton,
  Checkbox,
  cn,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@slayzone/ui'
import type { GhPullRequest } from '../shared/types'
import { DiffView } from './DiffView'
import { GhMarkdown } from './GhMarkdown'
import { AuthorAvatar } from './pr-avatars'
import { PrStateIcon, PrStateBadge, ChecksBadge, ReviewBadge, DiffFileIcon } from './pr-badges'
import { CommitGroupItem, TimelineItem } from './pr-timeline'
import { formatRelativeTime } from './pr-utils'
import { useLinkedPrView } from './useLinkedPrView'

export function LinkedPrView({
  pr,
  projectPath,
  visible,
  onUnlink,
  onRefreshPr
}: {
  pr: GhPullRequest
  projectPath: string
  visible: boolean
  onUnlink: () => void
  onRefreshPr: () => Promise<void>
}) {
  const trpc = useTRPC()
  const openExternalMutation = useMutation(trpc.app.shell.openExternal.mutationOptions())
  const {
    comments,
    loadingComments,
    commentBody,
    submitting,
    commentError,
    scrollRef,
    textareaRef,
    collapsedIds,
    ghUser,
    editingId,
    editBody,
    setEditBody,
    editSubmitting,
    activeTab,
    setActiveTab,
    mergeOpen,
    setMergeOpen,
    mergeStrategy,
    setMergeStrategy,
    mergeDeleteBranch,
    setMergeDeleteBranch,
    mergeAuto,
    setMergeAuto,
    merging,
    mergeError,
    handleMerge,
    diffLoading,
    diffFiles,
    diffError,
    expandedFiles,
    loadDiff,
    toggleFileExpand,
    diffStats,
    refreshAll,
    handleTextareaChange,
    handleSubmitComment,
    handleReply,
    handleStartEdit,
    handleSaveEdit,
    handleCancelEdit,
    toggleCollapse,
    collapsableComments,
    collapseAll,
    expandAll,
    allCollapsed,
    groupedTimeline,
    visibleTimeline,
    hasOlderEntries,
    timelineLimit,
    setTimelineLimit,
    TIMELINE_PAGE_SIZE,
    unlinkOpen,
    setUnlinkOpen
  } = useLinkedPrView({ pr, projectPath, visible, onRefreshPr })

  return (
    <div className="h-full flex flex-col bg-surface-1 overflow-hidden">
      {/* Header + tabs */}
      <div className="shrink-0 border-b">
        <div className="px-4 pt-4 pb-3 space-y-1.5">
          {/* Title row: icon | title | badges */}
          <div className="flex items-center gap-2.5">
            <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
            <div className="flex-1 min-w-0 text-sm font-medium leading-snug truncate">
              {pr.title}{' '}
              <span className="text-xs text-muted-foreground font-normal">#{pr.number}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <PrStateBadge state={pr.state} isDraft={pr.isDraft} />
              {pr.statusCheckRollup && <ChecksBadge status={pr.statusCheckRollup} />}
              {pr.reviewDecision && <ReviewBadge decision={pr.reviewDecision} />}
              <div className="w-2" />
              {pr.state === 'OPEN' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton
                      aria-label="Merge"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() => setMergeOpen(true)}
                    >
                      <GitMerge className="h-3 w-3" />
                    </IconButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Merge PR</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton
                    aria-label="Refresh"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={refreshAll}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">Refresh</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton
                    aria-label="Open in browser"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() => openExternalMutation.mutate({ url: pr.url })}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">Open in browser</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton
                    aria-label="Unlink PR"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() => setUnlinkOpen(true)}
                  >
                    <Unlink className="h-3 w-3" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">Unlink PR</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {/* Meta row: author · branches */}
          <div className="flex items-center gap-1.5 pl-[26px] text-[11px] text-muted-foreground">
            <AuthorAvatar name={pr.author} size="sm" />
            <span className="font-medium">{pr.author}</span>
            <span className="mx-0.5">·</span>
            <span className="font-mono">{pr.headRefName}</span>
            <span>→</span>
            <span className="font-mono">{pr.baseRefName}</span>
          </div>
        </div>

        {/* Tab row with action buttons right-aligned */}
        <div className="flex items-center px-4">
          <button
            onClick={() => setActiveTab('description')}
            className={cn(
              'px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px',
              activeTab === 'description'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Description
          </button>
          <button
            onClick={() => setActiveTab('activity')}
            className={cn(
              'px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px',
              activeTab === 'activity'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Activity
            {comments.length > 0 && (
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                ({comments.length})
              </span>
            )}
          </button>
          <button
            onClick={() => {
              setActiveTab('files')
              loadDiff()
            }}
            className={cn(
              'px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px',
              activeTab === 'files'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Files
            {diffFiles.length > 0 && (
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                ({diffStats.files})
              </span>
            )}
          </button>

          {/* Expand/collapse for activity tab */}
          {activeTab === 'activity' && collapsableComments.length > 0 && (
            <button
              onClick={allCollapsed ? expandAll : collapseAll}
              className="flex items-center gap-1 ml-auto px-2 py-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronsUpDown className="h-3 w-3" />
              {allCollapsed ? 'Expand' : 'Collapse'}
            </button>
          )}
        </div>
      </div>

      {/* Unlink confirmation */}
      <AlertDialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink Pull Request</AlertDialogTitle>
            <AlertDialogDescription>
              Remove the link between this task and PR #{pr.number}? The pull request itself won't
              be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setUnlinkOpen(false)
                onUnlink()
              }}
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Merge dialog */}
      <AlertDialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge Pull Request #{pr.number}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 pt-2">
                {/* Strategy */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-foreground">Merge strategy</label>
                  <div className="flex gap-1">
                    {(['merge', 'squash', 'rebase'] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setMergeStrategy(s)}
                        className={cn(
                          'px-3 py-1.5 text-xs rounded-md border transition-colors',
                          mergeStrategy === s
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-transparent hover:bg-accent border-border'
                        )}
                      >
                        {s === 'merge'
                          ? 'Merge commit'
                          : s === 'squash'
                            ? 'Squash & merge'
                            : 'Rebase & merge'}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Options */}
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={mergeDeleteBranch}
                      onCheckedChange={(v) => setMergeDeleteBranch(!!v)}
                    />
                    Delete branch after merge
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox checked={mergeAuto} onCheckedChange={(v) => setMergeAuto(!!v)} />
                    Auto-merge when checks pass
                  </label>
                </div>
                {mergeError && (
                  <div className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">
                    {mergeError}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button size="sm" disabled={merging} onClick={handleMerge} className="gap-2">
              {merging ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitMerge className="h-3.5 w-3.5" />
              )}
              {merging ? 'Merging...' : mergeAuto ? 'Enable auto-merge' : 'Merge'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Tab content — all panels stay mounted, hidden via display:none to avoid reflow on switch */}
      <div className="flex-1 min-h-0 relative">
        <div
          ref={activeTab === 'description' ? scrollRef : undefined}
          className={cn(
            'absolute inset-0 overflow-y-auto',
            activeTab !== 'description' && 'hidden'
          )}
        >
          <div className="px-4 py-3">
            <div className="rounded-lg border bg-surface-3 overflow-hidden">
              {pr.body ? (
                <div className="px-3 py-2.5 text-xs">
                  <GhMarkdown>{pr.body}</GhMarkdown>
                </div>
              ) : (
                <p className="px-3 py-4 text-xs text-muted-foreground/60 italic">
                  No description provided.
                </p>
              )}
            </div>
          </div>
        </div>

        <div
          ref={activeTab === 'activity' ? scrollRef : undefined}
          className={cn('absolute inset-0 overflow-y-auto', activeTab !== 'activity' && 'hidden')}
        >
          <div className="px-4 py-3">
            <div className="space-y-0">
              {/* PR description as first timeline entry */}
              {pr.body && (
                <div className="relative flex gap-3 pb-0">
                  {/* Avatar + connector */}
                  <div className="relative shrink-0 flex flex-col items-center">
                    <div className="relative z-10">
                      <AuthorAvatar name={pr.author} />
                    </div>
                    {(comments.length > 0 || loadingComments) && (
                      <div className="flex-1 w-px bg-border mt-1" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 rounded-lg border bg-surface-3 overflow-hidden mb-4">
                    <div
                      className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b cursor-pointer"
                      onClick={() => toggleCollapse('__pr_body__')}
                    >
                      <span className="text-[11px] font-semibold">{pr.author}</span>
                      <span className="text-[10px] text-muted-foreground/60">
                        {formatRelativeTime(pr.createdAt)}
                      </span>
                      <span className="ml-auto shrink-0">
                        {collapsedIds.has('__pr_body__') ? (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        )}
                      </span>
                    </div>
                    {!collapsedIds.has('__pr_body__') && (
                      <div className="px-3 py-2 text-xs">
                        <GhMarkdown>{pr.body}</GhMarkdown>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {loadingComments ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : comments.length === 0 && !pr.body ? (
                <div className="py-6 text-center">
                  <MessageSquare className="h-5 w-5 mx-auto mb-1.5 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground/60">No activity yet</p>
                </div>
              ) : (
                <>
                  {hasOlderEntries && (
                    <div className="flex justify-center pb-3">
                      <button
                        onClick={() => setTimelineLimit((prev) => prev + TIMELINE_PAGE_SIZE)}
                        className="text-[11px] text-muted-foreground hover:text-foreground transition-colors px-3 py-1 rounded-md border border-border hover:bg-accent/30"
                      >
                        Show {Math.min(TIMELINE_PAGE_SIZE, groupedTimeline.length - timelineLimit)}{' '}
                        older entries
                      </button>
                    </div>
                  )}
                  {visibleTimeline.map((entry, i) =>
                    entry.kind === 'commits' ? (
                      <CommitGroupItem
                        key={`commits-${entry.commits[0].oid}`}
                        commits={entry.commits}
                        author={entry.author}
                        isLast={i === visibleTimeline.length - 1}
                      />
                    ) : (
                      <TimelineItem
                        key={entry.event.id}
                        comment={entry.event}
                        collapsed={collapsedIds.has(entry.event.id)}
                        onToggleCollapse={() => toggleCollapse(entry.event.id)}
                        onReply={() => handleReply(entry.event)}
                        isOwnComment={ghUser !== null && entry.event.author === ghUser}
                        isEditing={editingId === entry.event.id}
                        editBody={editingId === entry.event.id ? editBody : ''}
                        editSubmitting={editSubmitting}
                        onStartEdit={() => handleStartEdit(entry.event)}
                        onEditChange={setEditBody}
                        onSaveEdit={handleSaveEdit}
                        onCancelEdit={handleCancelEdit}
                        isLast={i === visibleTimeline.length - 1}
                      />
                    )
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div
          ref={activeTab === 'files' ? scrollRef : undefined}
          className={cn('absolute inset-0 overflow-y-auto', activeTab !== 'files' && 'hidden')}
        >
          <div className="py-2">
            {diffLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : diffError ? (
              <div className="px-4 py-2 text-xs text-destructive">{diffError}</div>
            ) : diffFiles.length === 0 ? (
              <div className="px-4 py-4 text-center text-xs text-muted-foreground">
                No file changes
              </div>
            ) : (
              <>
                <div className="px-4 pb-2 text-[10px] text-muted-foreground">
                  {diffStats.files} files
                  <span className="text-green-500 ml-1">+{diffStats.additions}</span>
                  <span className="text-red-500 ml-1">-{diffStats.deletions}</span>
                </div>
                <div className="space-y-0">
                  {diffFiles.map((file) => (
                    <div key={file.path}>
                      <button
                        onClick={() => toggleFileExpand(file.path)}
                        className="flex items-center gap-2 w-full px-4 py-1.5 text-[11px] hover:bg-accent/30 transition-colors"
                      >
                        {expandedFiles.has(file.path) ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        <DiffFileIcon file={file} />
                        <span className="font-mono truncate text-left">{file.path}</span>
                        <span className="ml-auto shrink-0 text-[10px]">
                          {file.additions > 0 && (
                            <span className="text-green-500">+{file.additions}</span>
                          )}
                          {file.deletions > 0 && (
                            <span className="text-red-500 ml-1">-{file.deletions}</span>
                          )}
                        </span>
                      </button>
                      {expandedFiles.has(file.path) && (
                        <div className="border-t border-b border-border/30 ml-4 mr-2 mb-1">
                          <DiffView diff={file} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Comment input */}
      <div className="shrink-0 border-t">
        <form onSubmit={handleSubmitComment} className="p-3">
          <div className="rounded-lg border bg-surface-3 focus-within:ring-1 focus-within:ring-ring transition-shadow">
            <textarea
              ref={textareaRef}
              value={commentBody}
              onChange={handleTextareaChange}
              placeholder="Leave a comment..."
              rows={2}
              className="block w-full bg-transparent px-3 pt-2.5 pb-1 text-xs resize-none focus:outline-none min-h-[52px] placeholder:text-muted-foreground/50"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSubmitComment(e)
                }
              }}
            />
            {commentError && (
              <div className="px-3 pt-1.5">
                <p className="text-[11px] text-destructive">{commentError}</p>
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[10px] text-muted-foreground/50">Markdown supported</span>
              <Button
                type="submit"
                size="sm"
                disabled={submitting || !commentBody.trim()}
                className="h-6 px-2.5 text-[11px] gap-1.5"
              >
                {submitting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                Comment
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
