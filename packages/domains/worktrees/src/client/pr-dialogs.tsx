import type React from 'react'
import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { GitPullRequest, Loader2 } from 'lucide-react'
import {
  Button,
  Input,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@slayzone/ui'
import type { Task } from '@slayzone/task/shared'
import { PrStateIcon } from './pr-badges'

// --- Create PR dialog ---

export function CreatePrDialog({
  open,
  onOpenChange,
  task,
  projectPath,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task
  projectPath: string
  onCreated: (url: string) => void
}) {
  const trpc = useTRPC()
  const targetPath = task.worktree_path ?? projectPath
  const [baseBranch, setBaseBranch] = useState(task.worktree_parent_branch ?? '')
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createPrMutation = useMutation(trpc.worktrees.createPr.mutationOptions())

  // Resolve default branch when worktree_parent_branch is not set
  const defaultBranchQuery = useQuery(
    trpc.worktrees.getDefaultBranch.queryOptions(
      { path: projectPath },
      { enabled: open && !task.worktree_parent_branch }
    )
  )
  useEffect(() => {
    if (!open || task.worktree_parent_branch) return
    if (defaultBranchQuery.isSuccess) setBaseBranch(defaultBranchQuery.data ?? 'main')
    else if (defaultBranchQuery.isError) setBaseBranch('main')
  }, [open, task.worktree_parent_branch, defaultBranchQuery.isSuccess, defaultBranchQuery.isError, defaultBranchQuery.data])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !baseBranch) return
    setCreating(true)
    setError(null)
    try {
      const result = await createPrMutation.mutateAsync({
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Pull Request</DialogTitle>
          <DialogDescription>
            Into <span className="font-mono font-medium text-foreground">{baseBranch}</span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
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

          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={draft} onCheckedChange={(v) => setDraft(!!v)} />
            Create as draft
          </label>

          {error && (
            <div className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <Button
            type="submit"
            size="sm"
            disabled={creating || !title.trim() || !baseBranch}
            className="gap-2"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitPullRequest className="h-3.5 w-3.5" />
            )}
            {creating ? 'Creating...' : 'Create Pull Request'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// --- Link existing PR dialog ---

export function LinkPrDialog({
  open,
  onOpenChange,
  projectPath,
  onLink,
  error
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  onLink: (url: string) => void
  error: string | null
}) {
  const trpc = useTRPC()
  const prsQuery = useQuery(
    trpc.worktrees.listOpenPrs.queryOptions({ repoPath: projectPath }, { enabled: open })
  )
  const prs = prsQuery.data ?? []
  const loading = prsQuery.isFetching
  const fetchError = prsQuery.error
    ? prsQuery.error instanceof Error
      ? prsQuery.error.message
      : String(prsQuery.error)
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link Pull Request</DialogTitle>
          <DialogDescription>Select an open pull request to link to this task</DialogDescription>
        </DialogHeader>

        {(error || fetchError) && (
          <div className="text-xs text-destructive">{error || fetchError}</div>
        )}

        <div className="max-h-[50vh] overflow-y-auto -mx-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : prs.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No open pull requests
            </div>
          ) : (
            <div className="py-1">
              {prs.map((pr) => (
                <button
                  key={pr.number}
                  onClick={() => onLink(pr.url)}
                  className="flex items-start gap-3 w-full px-4 py-2.5 text-left hover:bg-accent/50 transition-colors rounded-md"
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
      </DialogContent>
    </Dialog>
  )
}
