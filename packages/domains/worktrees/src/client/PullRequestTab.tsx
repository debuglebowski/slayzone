import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  ExternalLink,
  GitPullRequest,
  Link2,
  Plus,
  Loader2,
  Unlink,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Check,
  CircleDot,
  GitMerge,
  CircleX,
  CheckCircle2,
  XCircle,
  Clock,
  MessageSquare,
  Send,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  RefreshCw,
  Eye,
  Reply,
  Pencil,
  ChevronsUpDown,
  FilePlus2,
  FileX2,
  File
} from 'lucide-react'
import {
  Button,
  IconButton,
  Input,
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
  AlertDialogTitle,
} from '@slayzone/ui'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import type { GhPullRequest, GhPrComment, MergeStrategy } from '../shared/types'
import { DiffView } from './DiffView'
import { parseUnifiedDiff } from './parse-diff'
import type { FileDiff } from './parse-diff'
import { GhMarkdown } from './GhMarkdown'

interface PullRequestTabProps {
  task: Task
  projectPath: string | null
  visible: boolean
  onUpdateTask: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated: (task: Task) => void
}

type View = 'idle' | 'create' | 'link'

export function PullRequestTab({ task, projectPath, visible, onUpdateTask, onTaskUpdated }: PullRequestTabProps) {
  const [ghInstalled, setGhInstalled] = useState<boolean | null>(null)
  const [pr, setPr] = useState<GhPullRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('idle')
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined)

  // Check gh + fetch PR if linked
  useEffect(() => {
    if (!visible || !projectPath) return
    let cancelled = false
    ;(async () => {
      try {
        const installed = await window.api.git.checkGhInstalled()
        if (cancelled) return
        setGhInstalled(installed)
        if (!installed) { setLoading(false); return }

        if (task.pr_url) {
          const data = await window.api.git.getPrByUrl(projectPath, task.pr_url)
          if (!cancelled) setPr(data)
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [visible, projectPath, task.pr_url])

  // Poll PR status when linked
  useEffect(() => {
    if (!visible || !projectPath || !task.pr_url || !ghInstalled) return
    pollRef.current = setInterval(async () => {
      try {
        const data = await window.api.git.getPrByUrl(projectPath, task.pr_url!)
        if (data) setPr(data)
      } catch { /* ignore */ }
    }, 30000)
    return () => clearInterval(pollRef.current)
  }, [visible, projectPath, task.pr_url, ghInstalled])

  const handleUnlink = useCallback(async () => {
    const updated = await onUpdateTask({ id: task.id, prUrl: null })
    onTaskUpdated(updated)
    setPr(null)
    setView('idle')
  }, [task.id, onUpdateTask, onTaskUpdated])

  const handleLinkPr = useCallback(async (url: string) => {
    setError(null)
    try {
      const updated = await onUpdateTask({ id: task.id, prUrl: url })
      onTaskUpdated(updated)
      if (projectPath) {
        const data = await window.api.git.getPrByUrl(projectPath, url)
        setPr(data)
      }
      setView('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [task.id, projectPath, onUpdateTask, onTaskUpdated])

  const handleCreated = useCallback(async (url: string) => {
    const updated = await onUpdateTask({ id: task.id, prUrl: url })
    onTaskUpdated(updated)
    if (projectPath) {
      const data = await window.api.git.getPrByUrl(projectPath, url)
      setPr(data)
    }
    setView('idle')
  }, [task.id, projectPath, onUpdateTask, onTaskUpdated])

  if (!projectPath) {
    return <EmptyMessage>Set a project path to use PR features</EmptyMessage>
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (ghInstalled === false) {
    return (
      <div className="p-6 space-y-3">
        <div className="flex items-center gap-2 text-yellow-500">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-sm font-medium">GitHub CLI not found</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Install the GitHub CLI to create and manage pull requests:
        </p>
        <code className="block text-xs bg-muted px-3 py-2 rounded-md">
          brew install gh && gh auth login
        </code>
      </div>
    )
  }

  // PR is linked — show status
  if (task.pr_url && pr) {
    return <LinkedPrView pr={pr} projectPath={projectPath!} visible={visible} onUnlink={handleUnlink} onPrUpdated={setPr} />
  }
  if (task.pr_url && !pr) {
    return (
      <div className="p-6 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <a
            className="text-primary hover:underline truncate"
            href="#"
            onClick={(e) => { e.preventDefault(); window.api.shell.openExternal(task.pr_url!) }}
          >
            {task.pr_url}
          </a>
        </div>
        <Button variant="outline" size="sm" onClick={handleUnlink} className="gap-2">
          <Unlink className="h-3.5 w-3.5" /> Unlink
        </Button>
      </div>
    )
  }

  // No PR linked
  if (view === 'create') {
    return (
      <CreatePrForm
        task={task}
        projectPath={projectPath}
        onCreated={handleCreated}
        onCancel={() => setView('idle')}
      />
    )
  }

  if (view === 'link') {
    return (
      <LinkPrView
        projectPath={projectPath}
        onLink={handleLinkPr}
        onCancel={() => setView('idle')}
        error={error}
      />
    )
  }

  return (
    <div className="h-full flex items-center justify-center">
      <div className="space-y-3 text-center">
        <GitPullRequest className="h-8 w-8 text-muted-foreground mx-auto" />
        <p className="text-sm text-muted-foreground">No pull request linked</p>
        <div className="flex gap-2 justify-center">
          <Button variant="outline" size="sm" onClick={() => setView('create')} className="gap-2">
            <Plus className="h-3.5 w-3.5" /> Create PR
          </Button>
          <Button variant="outline" size="sm" onClick={() => setView('link')} className="gap-2">
            <Link2 className="h-3.5 w-3.5" /> Link Existing
          </Button>
        </div>
      </div>
    </div>
  )
}

// --- Linked PR view ---

function LinkedPrView({ pr, projectPath, visible, onUnlink, onPrUpdated }: {
  pr: GhPullRequest
  projectPath: string
  visible: boolean
  onUnlink: () => void
  onPrUpdated: (pr: GhPullRequest) => void
}) {
  const [comments, setComments] = useState<GhPrComment[]>([])
  const [loadingComments, setLoadingComments] = useState(true)
  const [commentBody, setCommentBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [ghUser, setGhUser] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [activeTab, setActiveTab] = useState<'description' | 'activity' | 'files'>('description')

  // Merge state
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>('squash')
  const [mergeDeleteBranch, setMergeDeleteBranch] = useState(true)
  const [mergeAuto, setMergeAuto] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)

  // Diff state
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffFiles, setDiffFiles] = useState<FileDiff[]>([])
  const [diffError, setDiffError] = useState<string | null>(null)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())

  const fetchComments = useCallback(async () => {
    try {
      const data = await window.api.git.getPrComments(projectPath, pr.number)
      setComments(data)
    } catch { /* ignore */ }
    setLoadingComments(false)
  }, [projectPath, pr.number])

  useEffect(() => {
    if (!visible) return
    fetchComments()
    const timer = setInterval(fetchComments, 30000)
    return () => clearInterval(timer)
  }, [visible, fetchComments])

  // Fetch gh user for edit button
  useEffect(() => {
    if (!visible) return
    ;(async () => {
      try {
        const user = await window.api.git.getGhUser(projectPath)
        setGhUser(user)
      } catch { /* ignore */ }
    })()
  }, [visible, projectPath])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [comments.length])

  // Auto-grow textarea
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCommentBody(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!commentBody.trim()) return
    setSubmitting(true)
    setCommentError(null)
    try {
      await window.api.git.addPrComment(projectPath, pr.number, commentBody.trim())
      setCommentBody('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      await fetchComments()
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'Failed to post comment')
    }
    setSubmitting(false)
  }

  const handleReply = useCallback((comment: GhPrComment) => {
    const quoted = comment.body.split('\n').map(l => `> ${l}`).join('\n')
    setCommentBody(`${quoted}\n\n@${comment.author} `)
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
      }
    }, 0)
  }, [])

  const handleStartEdit = useCallback((comment: GhPrComment) => {
    setEditingId(comment.id)
    setEditBody(comment.body)
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (!editingId || !editBody.trim()) return
    setEditSubmitting(true)
    try {
      await window.api.git.editPrComment({ repoPath: projectPath, commentId: editingId, body: editBody.trim() })
      setEditingId(null)
      setEditBody('')
      await fetchComments()
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'Failed to edit comment')
    }
    setEditSubmitting(false)
  }, [editingId, editBody, projectPath, fetchComments])

  const handleCancelEdit = useCallback(() => {
    setEditingId(null)
    setEditBody('')
  }, [])

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const collapseAll = useCallback(() => {
    setCollapsedIds(new Set(comments.filter(c => c.body).map(c => c.id)))
  }, [comments])

  const expandAll = useCallback(() => {
    setCollapsedIds(new Set())
  }, [])

  const allCollapsed = comments.filter(c => c.body).every(c => collapsedIds.has(c.id))

  // Merge
  const handleMerge = async () => {
    setMerging(true)
    setMergeError(null)
    try {
      await window.api.git.mergePr({
        repoPath: projectPath,
        prNumber: pr.number,
        strategy: mergeStrategy,
        deleteBranch: mergeDeleteBranch,
        auto: mergeAuto
      })
      setMergeOpen(false)
      // Re-fetch PR to get updated state
      const updated = await window.api.git.getPrByUrl(projectPath, pr.url)
      if (updated) onPrUpdated(updated)
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Failed to merge')
    }
    setMerging(false)
  }

  // Diff - lazy load
  const loadDiff = useCallback(async () => {
    if (diffFiles.length > 0 || diffLoading) return
    setDiffLoading(true)
    setDiffError(null)
    try {
      const raw = await window.api.git.getPrDiff(projectPath, pr.number)
      setDiffFiles(parseUnifiedDiff(raw))
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : 'Failed to load diff')
    }
    setDiffLoading(false)
  }, [diffFiles.length, diffLoading, projectPath, pr.number])

  const toggleFileExpand = useCallback((path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const diffStats = useMemo(() => {
    let additions = 0, deletions = 0
    for (const f of diffFiles) { additions += f.additions; deletions += f.deletions }
    return { files: diffFiles.length, additions, deletions }
  }, [diffFiles])

  const [unlinkOpen, setUnlinkOpen] = useState(false)

  return (
    <div className="h-full flex flex-col bg-surface-1 overflow-hidden">
      {/* Header + tabs */}
      <div className="shrink-0 border-b">
        <div className="px-4 pt-4 pb-3 space-y-1.5">
          {/* Title row: icon | title | badges */}
          <div className="flex items-center gap-2.5">
            <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
            <div className="flex-1 min-w-0 text-sm font-medium leading-snug truncate">
              {pr.title} <span className="text-xs text-muted-foreground font-normal">#{pr.number}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <PrStateBadge state={pr.state} isDraft={pr.isDraft} />
              {pr.statusCheckRollup && <ChecksBadge status={pr.statusCheckRollup} />}
              {pr.reviewDecision && <ReviewBadge decision={pr.reviewDecision} />}
              <div className="w-2" />
              {pr.state === 'OPEN' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton aria-label="Merge" variant="ghost" className="h-6 w-6" onClick={() => setMergeOpen(true)}>
                      <GitMerge className="h-3 w-3" />
                    </IconButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Merge PR</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton aria-label="Refresh" variant="ghost" className="h-6 w-6" onClick={fetchComments}>
                    <RefreshCw className="h-3 w-3" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">Refresh</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton aria-label="Open in browser" variant="ghost" className="h-6 w-6" onClick={() => window.api.shell.openExternal(pr.url)}>
                    <ExternalLink className="h-3 w-3" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">Open in browser</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton aria-label="Unlink PR" variant="ghost" className="h-6 w-6" onClick={() => setUnlinkOpen(true)}>
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
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">({comments.length})</span>
            )}
          </button>
          <button
            onClick={() => { setActiveTab('files'); loadDiff() }}
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
          {activeTab === 'activity' && comments.filter(c => c.body).length > 0 && (
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
              Remove the link between this task and PR #{pr.number}? The pull request itself won't be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setUnlinkOpen(false); onUnlink() }}>Unlink</AlertDialogAction>
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
                    {(['merge', 'squash', 'rebase'] as const).map(s => (
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
                        {s === 'merge' ? 'Merge commit' : s === 'squash' ? 'Squash & merge' : 'Rebase & merge'}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Options */}
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox checked={mergeDeleteBranch} onCheckedChange={(v) => setMergeDeleteBranch(!!v)} />
                    Delete branch after merge
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox checked={mergeAuto} onCheckedChange={(v) => setMergeAuto(!!v)} />
                    Auto-merge when checks pass
                  </label>
                </div>
                {mergeError && (
                  <div className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">{mergeError}</div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button size="sm" disabled={merging} onClick={handleMerge} className="gap-2">
              {merging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
              {merging ? 'Merging...' : mergeAuto ? 'Enable auto-merge' : 'Merge'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Tab content — all panels stay mounted, hidden via display:none to avoid reflow on switch */}
      <div className="flex-1 min-h-0 relative">
        <div ref={activeTab === 'description' ? scrollRef : undefined} className={cn('absolute inset-0 overflow-y-auto', activeTab !== 'description' && 'hidden')}>
            <div className="px-4 py-3">
              <div className="rounded-lg border bg-surface-2 overflow-hidden">
                {pr.body ? (
                  <div className="px-3 py-2.5 text-xs">
                    <GhMarkdown>{pr.body}</GhMarkdown>
                  </div>
                ) : (
                  <p className="px-3 py-4 text-xs text-muted-foreground/60 italic">No description provided.</p>
                )}
              </div>
            </div>
          </div>

        <div ref={activeTab === 'activity' ? scrollRef : undefined} className={cn('absolute inset-0 overflow-y-auto', activeTab !== 'activity' && 'hidden')}>
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
                  <div className="flex-1 min-w-0 rounded-lg border bg-surface-2 overflow-hidden mb-2">
                    <div
                      className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b cursor-pointer"
                      onClick={() => toggleCollapse('__pr_body__')}
                    >
                      {collapsedIds.has('__pr_body__')
                        ? <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                        : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                      }
                      <span className="text-[11px] font-semibold">{pr.author}</span>
                      <span className="text-[10px] text-muted-foreground/60">{formatRelativeTime(pr.createdAt)}</span>
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
                comments.map((comment, i) => (
                  <TimelineItem
                    key={comment.id}
                    comment={comment}
                    collapsed={collapsedIds.has(comment.id)}
                    onToggleCollapse={() => toggleCollapse(comment.id)}
                    onReply={() => handleReply(comment)}
                    isOwnComment={ghUser !== null && comment.author === ghUser}
                    isEditing={editingId === comment.id}
                    editBody={editingId === comment.id ? editBody : ''}
                    editSubmitting={editSubmitting}
                    onStartEdit={() => handleStartEdit(comment)}
                    onEditChange={setEditBody}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={handleCancelEdit}
                    isLast={i === comments.length - 1}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        <div ref={activeTab === 'files' ? scrollRef : undefined} className={cn('absolute inset-0 overflow-y-auto', activeTab !== 'files' && 'hidden')}>
            <div className="py-2">
              {diffLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : diffError ? (
                <div className="px-4 py-2 text-xs text-destructive">{diffError}</div>
              ) : diffFiles.length === 0 ? (
                <div className="px-4 py-4 text-center text-xs text-muted-foreground">No file changes</div>
              ) : (
                <>
                  <div className="px-4 pb-2 text-[10px] text-muted-foreground">
                    {diffStats.files} files
                    <span className="text-green-500 ml-1">+{diffStats.additions}</span>
                    <span className="text-red-500 ml-1">-{diffStats.deletions}</span>
                  </div>
                  <div className="space-y-0">
                    {diffFiles.map(file => (
                      <div key={file.path}>
                        <button
                          onClick={() => toggleFileExpand(file.path)}
                          className="flex items-center gap-2 w-full px-4 py-1.5 text-[11px] hover:bg-accent/30 transition-colors"
                        >
                          {expandedFiles.has(file.path) ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                          <DiffFileIcon file={file} />
                          <span className="font-mono truncate text-left">{file.path}</span>
                          <span className="ml-auto shrink-0 text-[10px]">
                            {file.additions > 0 && <span className="text-green-500">+{file.additions}</span>}
                            {file.deletions > 0 && <span className="text-red-500 ml-1">-{file.deletions}</span>}
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
          <div className="rounded-lg border bg-surface-2 focus-within:ring-1 focus-within:ring-ring transition-shadow">
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
                {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                Comment
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

// --- Timeline item ---

function TimelineItem({ comment, collapsed, onToggleCollapse, onReply, isOwnComment, isEditing, editBody, editSubmitting, onStartEdit, onEditChange, onSaveEdit, onCancelEdit, isLast }: {
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
      <div className="relative flex items-center gap-3 pb-0">
        <div className="relative shrink-0 flex flex-col items-center">
          <div className="relative z-10">
            <ReviewEventDot state={comment.reviewState} />
          </div>
          {!isLast && <div className="flex-1 w-px bg-border mt-1" />}
        </div>
        <span className="text-[11px] text-muted-foreground mb-2">
          <span className="font-medium text-foreground/80">{comment.author}</span>
          {' '}{reviewActionLabel(comment.reviewState)}
          <span className="ml-1.5 text-muted-foreground/60">{timeAgo}</span>
        </span>
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
      <div className="flex-1 min-w-0 rounded-lg border bg-surface-2 overflow-hidden mb-2">
        {/* Comment header */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b cursor-pointer"
          onClick={onToggleCollapse}
        >
          {collapsed
            ? <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          }
          <span className="text-[11px] font-semibold">{comment.author}</span>
          {comment.type === 'review' && comment.reviewState && (
            <ReviewInlineBadge state={comment.reviewState} />
          )}
          <span className="text-[10px] text-muted-foreground/60">{timeAgo}</span>
          {/* Action buttons */}
          {!collapsed && (
            <div className="ml-auto flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={onReply} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
                    <Reply className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Quote reply</TooltipContent>
              </Tooltip>
              {isOwnComment && comment.type === 'comment' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button onClick={onStartEdit} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
                      <Pencil className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Edit</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {/* Comment body */}
        {!collapsed && (
          isEditing ? (
            <div className="px-3 py-2 space-y-2">
              <textarea
                value={editBody}
                onChange={e => onEditChange(e.target.value)}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-xs resize-y min-h-[60px] focus:outline-none focus:ring-1 focus:ring-ring"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSaveEdit() }
                  if (e.key === 'Escape') onCancelEdit()
                }}
              />
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={onCancelEdit}>Cancel</Button>
                <Button size="sm" className="h-6 text-[11px] gap-1" disabled={editSubmitting || !editBody.trim()} onClick={onSaveEdit}>
                  {editSubmitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="px-3 py-2 text-xs">
              <GhMarkdown>{comment.body}</GhMarkdown>
            </div>
          )
        )}
      </div>
    </div>
  )
}

// --- Diff file icon ---

function DiffFileIcon({ file }: { file: FileDiff }) {
  if (file.isNew) return <FilePlus2 className="h-3 w-3 text-green-500 shrink-0" />
  if (file.isDeleted) return <FileX2 className="h-3 w-3 text-red-500 shrink-0" />
  return <File className="h-3 w-3 text-muted-foreground shrink-0" />
}

// --- Avatar ---

const avatarColors = [
  'bg-blue-500/20 text-blue-400',
  'bg-purple-500/20 text-purple-400',
  'bg-green-500/20 text-green-400',
  'bg-orange-500/20 text-orange-400',
  'bg-pink-500/20 text-pink-400',
  'bg-cyan-500/20 text-cyan-400',
  'bg-yellow-500/20 text-yellow-400',
  'bg-red-500/20 text-red-400',
]

function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return avatarColors[Math.abs(hash) % avatarColors.length]
}

function AuthorAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const initials = name.slice(0, 2).toUpperCase()
  return (
    <div className={cn(
      'rounded-full flex items-center justify-center font-bold select-none',
      size === 'sm' ? 'h-4 w-4 text-[7px]' : 'h-6 w-6 text-[9px]',
      avatarColor(name)
    )}>
      {initials}
    </div>
  )
}

// --- Review event dot ---

function ReviewEventDot({ state }: { state?: string }) {
  const base = 'h-6 w-6 rounded-full flex items-center justify-center'
  switch (state) {
    case 'APPROVED':
      return <div className={cn(base, 'bg-green-500/15')}><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /></div>
    case 'CHANGES_REQUESTED':
      return <div className={cn(base, 'bg-red-500/15')}><XCircle className="h-3.5 w-3.5 text-red-500" /></div>
    case 'COMMENTED':
      return <div className={cn(base, 'bg-muted')}><Eye className="h-3.5 w-3.5 text-muted-foreground" /></div>
    default:
      return <div className={cn(base, 'bg-muted')}><MessageSquare className="h-3.5 w-3.5 text-muted-foreground" /></div>
  }
}

function reviewActionLabel(state?: string): string {
  switch (state) {
    case 'APPROVED': return 'approved these changes'
    case 'CHANGES_REQUESTED': return 'requested changes'
    case 'COMMENTED': return 'left a review'
    case 'DISMISSED': return 'dismissed a review'
    default: return 'reviewed'
  }
}

function ReviewInlineBadge({ state }: { state: string }) {
  const config: Record<string, { label: string; className: string }> = {
    APPROVED: { label: 'Approved', className: 'text-green-500 bg-green-500/10 border-green-500/20' },
    CHANGES_REQUESTED: { label: 'Changes requested', className: 'text-red-500 bg-red-500/10 border-red-500/20' },
    COMMENTED: { label: 'Reviewed', className: 'text-muted-foreground bg-muted border-border' }
  }
  const c = config[state]
  if (!c) return null
  return (
    <span className={cn('px-1.5 py-px rounded text-[9px] font-medium border', c.className)}>
      {c.label}
    </span>
  )
}

// --- Status badges ---

function ChecksBadge({ status }: { status: GhPullRequest['statusCheckRollup'] }) {
  if (!status) return null
  const config: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
    SUCCESS: { icon: <CheckCircle2 className="h-3 w-3" />, label: 'Checks pass', className: 'text-green-500 bg-green-500/10' },
    FAILURE: { icon: <XCircle className="h-3 w-3" />, label: 'Checks failing', className: 'text-red-500 bg-red-500/10' },
    PENDING: { icon: <Clock className="h-3 w-3" />, label: 'Checks running', className: 'text-yellow-500 bg-yellow-500/10' }
  }
  const c = config[status]
  if (!c) return null
  return (
    <span className={cn('flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium', c.className)}>
      {c.icon} {c.label}
    </span>
  )
}

function ReviewBadge({ decision }: { decision: GhPullRequest['reviewDecision'] }) {
  if (!decision) return null
  const config: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
    APPROVED: { icon: <ShieldCheck className="h-3 w-3" />, label: 'Approved', className: 'text-green-500 bg-green-500/10' },
    CHANGES_REQUESTED: { icon: <ShieldAlert className="h-3 w-3" />, label: 'Changes requested', className: 'text-red-500 bg-red-500/10' },
    REVIEW_REQUIRED: { icon: <ShieldQuestion className="h-3 w-3" />, label: 'Review required', className: 'text-yellow-500 bg-yellow-500/10' }
  }
  const c = config[decision]
  if (!c) return null
  return (
    <span className={cn('flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium', c.className)}>
      {c.icon} {c.label}
    </span>
  )
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  return new Date(dateStr).toLocaleDateString()
}

// --- Create PR form ---

function CreatePrForm({ task, projectPath, onCreated, onCancel }: {
  task: Task
  projectPath: string
  onCreated: (url: string) => void
  onCancel: () => void
}) {
  const targetPath = task.worktree_path ?? projectPath
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState('')
  const [baseBranch, setBaseBranch] = useState(task.worktree_parent_branch ?? '')
  const [draft, setDraft] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showBranches, setShowBranches] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const list = await window.api.git.listBranches(projectPath)
        setBranches(list)
        if (!baseBranch && list.length > 0) {
          // Default to main/master if available
          const defaultBranch = list.find(b => b === 'main') ?? list.find(b => b === 'master') ?? list[0]
          setBaseBranch(defaultBranch)
        }
      } catch { /* ignore */ }
    })()
  }, [projectPath])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !baseBranch) return
    setCreating(true)
    setError(null)
    try {
      const result = await window.api.git.createPr({
        repoPath: targetPath,
        title: title.trim(),
        body: body.trim(),
        baseBranch,
        draft
      })
      onCreated(result.url)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Create Pull Request</h3>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="text-xs">
            Cancel
          </Button>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Title</label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="PR title..."
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Describe your changes..."
            rows={4}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm resize-y min-h-[80px] focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Base Branch</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowBranches(!showBranches)}
              className="flex items-center gap-2 w-full h-8 px-3 text-sm rounded-md border bg-transparent text-left hover:bg-muted/50"
            >
              <span className="flex-1 truncate">{baseBranch || 'Select branch...'}</span>
              <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            </button>
            {showBranches && (
              <div className="absolute z-10 mt-1 w-full max-h-40 overflow-y-auto rounded-md border bg-popover shadow-md">
                {branches.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    onClick={() => { setBaseBranch(branch); setShowBranches(false) }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent text-left"
                  >
                    {branch === baseBranch ? <Check className="h-3 w-3 text-primary" /> : <span className="w-3" />}
                    {branch}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={draft} onCheckedChange={(v) => setDraft(!!v)} />
          Create as draft
        </label>

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</div>
        )}

        <Button type="submit" size="sm" disabled={creating || !title.trim() || !baseBranch} className="gap-2">
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitPullRequest className="h-3.5 w-3.5" />}
          {creating ? 'Creating...' : 'Create Pull Request'}
        </Button>
      </form>
    </div>
  )
}

// --- Link existing PR ---

function LinkPrView({ projectPath, onLink, onCancel, error }: {
  projectPath: string
  onLink: (url: string) => void
  onCancel: () => void
  error: string | null
}) {
  const [prs, setPrs] = useState<GhPullRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const list = await window.api.git.listOpenPrs(projectPath)
        setPrs(list)
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [projectPath])

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-4 py-3 border-b flex items-center justify-between">
        <h3 className="text-sm font-medium">Link Pull Request</h3>
        <Button variant="ghost" size="sm" onClick={onCancel} className="text-xs">Cancel</Button>
      </div>

      {(error || fetchError) && (
        <div className="px-4 py-2 text-xs text-destructive">{error || fetchError}</div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : prs.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">No open pull requests</div>
        ) : (
          <div className="py-1">
            {prs.map((pr) => (
              <button
                key={pr.number}
                onClick={() => onLink(pr.url)}
                className="flex items-start gap-3 w-full px-4 py-2.5 text-left hover:bg-accent/50 transition-colors"
              >
                <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{pr.title}</div>
                  <div className="text-[10px] text-muted-foreground">
                    #{pr.number} · {pr.headRefName} → {pr.baseRefName} · {pr.author}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Shared helpers ---

function PrStateIcon({ state, isDraft }: { state: GhPullRequest['state']; isDraft: boolean }) {
  if (isDraft) return <GitPullRequest className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
  if (state === 'MERGED') return <GitMerge className="h-4 w-4 text-purple-500 shrink-0 mt-0.5" />
  if (state === 'CLOSED') return <CircleX className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
  return <CircleDot className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
}

function PrStateBadge({ state, isDraft }: { state: GhPullRequest['state']; isDraft: boolean }) {
  if (isDraft) {
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">Draft</span>
  }
  const styles: Record<string, string> = {
    OPEN: 'bg-green-500/10 text-green-500',
    MERGED: 'bg-purple-500/10 text-purple-500',
    CLOSED: 'bg-red-500/10 text-red-500'
  }
  return (
    <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-medium', styles[state] ?? '')}>
      {state.charAt(0) + state.slice(1).toLowerCase()}
    </span>
  )
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center">
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  )
}
