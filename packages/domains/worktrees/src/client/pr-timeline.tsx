import {
  ChevronDown,
  ChevronRight,
  Check,
  Loader2,
  Reply,
  Pencil,
  File,
  GitCommitHorizontal
} from 'lucide-react'
import {
  Button,
  cn,
  Tooltip,
  TooltipTrigger,
  TooltipContent
} from '@slayzone/ui'
import type { GhPrComment, GhPrCommit, GhPrTimelineEvent } from '../shared/types'
import { GhMarkdown } from './GhMarkdown'
import { AuthorAvatar } from './pr-avatars'
import { ReviewInlineBadge, reviewActionLabel } from './pr-badges'
import { formatRelativeTime } from './pr-utils'

// --- Grouped timeline entries ---

export type GroupedTimelineEntry =
  | { kind: 'event'; event: GhPrComment }
  | { kind: 'commits'; commits: GhPrCommit[]; author: string }

export function groupTimelineEvents(events: GhPrTimelineEvent[]): GroupedTimelineEntry[] {
  const groups: GroupedTimelineEntry[] = []
  let pendingCommits: GhPrCommit[] = []

  const flushCommits = () => {
    if (pendingCommits.length === 0) return
    // Group by author
    const byAuthor = new Map<string, GhPrCommit[]>()
    for (const c of pendingCommits) {
      const list = byAuthor.get(c.author) ?? []
      list.push(c)
      byAuthor.set(c.author, list)
    }
    for (const [author, commits] of byAuthor) {
      groups.push({ kind: 'commits', commits, author })
    }
    pendingCommits = []
  }

  for (const event of events) {
    if (event.type === 'commit') {
      pendingCommits.push(event)
    } else {
      flushCommits()
      groups.push({ kind: 'event', event })
    }
  }
  flushCommits()
  return groups
}

// --- Commit group timeline item ---

export function CommitGroupItem({
  commits,
  author,
  isLast
}: {
  commits: GhPrCommit[]
  author: string
  isLast: boolean
}) {
  return (
    <div className="relative flex gap-3 pb-0">
      <div className="relative shrink-0 flex flex-col items-center">
        <div className="relative z-10">
          <AuthorAvatar name={author} />
        </div>
        {!isLast && <div className="flex-1 w-px bg-border mt-1" />}
      </div>
      <div className="flex-1 min-w-0 mb-4">
        <div className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">{author}</span> added {commits.length}{' '}
          commit{commits.length !== 1 && 's'}
        </div>
        <div className="mt-1.5 space-y-0.5 pl-1">
          {commits.map((c) => (
            <div
              key={c.oid}
              className="flex items-center gap-2 text-[11px] text-muted-foreground truncate"
            >
              <GitCommitHorizontal className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              <span className="text-foreground/70 truncate">{c.messageHeadline}</span>
              <code className="shrink-0 text-[10px] font-mono text-muted-foreground/60">
                {c.oid.slice(0, 7)}
              </code>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// --- Timeline item ---

export function TimelineItem({
  comment,
  collapsed,
  onToggleCollapse,
  onReply,
  isOwnComment,
  isEditing,
  editBody,
  editSubmitting,
  onStartEdit,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  isLast
}: {
  comment: GhPrComment
  collapsed: boolean
  onToggleCollapse: () => void
  onReply: () => void
  isOwnComment: boolean
  isEditing: boolean
  editBody: string
  editSubmitting: boolean
  onStartEdit: () => void
  onEditChange: (body: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  isLast: boolean
}) {
  const isReviewAction = comment.type === 'review' && !comment.body
  const timeAgo = formatRelativeTime(comment.createdAt)

  if (isReviewAction) {
    return (
      <div className="relative flex gap-3 pb-0">
        <div className="relative shrink-0 flex flex-col items-center">
          <div className="relative z-10">
            <AuthorAvatar name={comment.author} />
          </div>
          {!isLast && <div className="flex-1 w-px bg-border mt-1" />}
        </div>
        <div className="flex-1 min-w-0 mb-4">
          <span className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground/80">{comment.author}</span>{' '}
            {reviewActionLabel(comment.reviewState)}
            <span className="ml-1.5 text-muted-foreground/60">{timeAgo}</span>
          </span>
          {comment.reviewFiles && comment.reviewFiles.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {comment.reviewFiles.map((file) => (
                <div
                  key={file}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground truncate"
                >
                  <File className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                  <span className="font-mono truncate">{file.split('/').pop()}</span>
                  <span className="text-[10px] text-muted-foreground/40 truncate hidden sm:inline">
                    {file}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex gap-3 pb-0">
      {/* Avatar + connector */}
      <div className="relative shrink-0 flex flex-col items-center">
        <div className="relative z-10">
          <AuthorAvatar name={comment.author} />
        </div>
        {!isLast && <div className="flex-1 w-px bg-border mt-1" />}
      </div>

      {/* Comment card */}
      <div className="flex-1 min-w-0 rounded-lg border bg-surface-3 overflow-hidden mb-4">
        {/* Comment header */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b cursor-pointer"
          onClick={onToggleCollapse}
        >
          <span className="text-[11px] font-semibold">{comment.author}</span>
          {comment.type === 'review' && comment.reviewState && (
            <ReviewInlineBadge state={comment.reviewState} />
          )}
          <span className="text-[10px] text-muted-foreground/60">{timeAgo}</span>
          {/* Action buttons */}
          {!collapsed && (
            <div className="ml-auto flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onReply}
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Reply className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Quote reply</TooltipContent>
              </Tooltip>
              {isOwnComment && comment.type === 'comment' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={onStartEdit}
                      className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Edit</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
          <span className={cn('shrink-0', collapsed && 'ml-auto')}>
            {collapsed ? (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            )}
          </span>
        </div>

        {/* Comment body */}
        {!collapsed &&
          (isEditing ? (
            <div className="px-3 py-2 space-y-2">
              <textarea
                value={editBody}
                onChange={(e) => onEditChange(e.target.value)}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-xs resize-y min-h-[60px] focus:outline-none focus:ring-1 focus:ring-ring"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    onSaveEdit()
                  }
                  if (e.key === 'Escape') onCancelEdit()
                }}
              />
              <div className="flex gap-2 justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px]"
                  onClick={onCancelEdit}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-6 text-[11px] gap-1"
                  disabled={editSubmitting || !editBody.trim()}
                  onClick={onSaveEdit}
                >
                  {editSubmitting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="px-3 py-2 text-xs">
              <GhMarkdown>{comment.body}</GhMarkdown>
            </div>
          ))}
        {comment.reviewFiles && comment.reviewFiles.length > 0 && (
          <div className="border-t px-3 py-1.5 space-y-0.5">
            {comment.reviewFiles.map((file) => (
              <div
                key={file}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground truncate"
              >
                <File className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                <span className="font-mono truncate">{file}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
