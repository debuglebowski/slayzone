import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { ListChecks, MessageSquare, SearchIcon, X } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects-contracts'
import { isTerminalStatus } from '@slayzone/projects-contracts'
import { SplitButton, SplitButtonItem } from '@slayzone/ui'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { Input, Textarea } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'
import { BlockerStatusIcon } from './BlockerStatusIcon'

interface BlockedBySectionProps {
  task: Task
  onUpdate: (task: Task) => void
  blockers: Task[]
  setBlockers: React.Dispatch<React.SetStateAction<Task[]>>
  columnsByProject: Map<string, Project['columns_config']>
  addBlockerSearch: string
  setAddBlockerSearch: React.Dispatch<React.SetStateAction<string>>
}

const selectTasks = (board: { tasks: Task[] }): Task[] => board.tasks

function matchesTaskSearch(task: Task, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return task.title.toLowerCase().includes(normalizedQuery)
}

export function BlockedBySection({
  task,
  onUpdate,
  blockers,
  setBlockers,
  columnsByProject,
  addBlockerSearch,
  setAddBlockerSearch
}: BlockedBySectionProps): React.JSX.Element {
  const trpc = useTRPC()
  const updateTask = useMutation(trpc.task.update.mutationOptions())
  const addBlocker = useMutation(trpc.task.addBlocker.mutationOptions())
  const removeBlocker = useMutation(trpc.task.removeBlocker.mutationOptions())
  const [blockerDialogOpen, setBlockerDialogOpen] = useState(false)
  const [commentDialogOpen, setCommentDialogOpen] = useState(false)
  const [blockedComment, setBlockedComment] = useState('')

  const handleAddBlocker = async (blockerTask: Task): Promise<void> => {
    await addBlocker.mutateAsync({ taskId: task.id, blockerTaskId: blockerTask.id })
    setBlockers([...blockers, blockerTask])
    setAddBlockerSearch('')
  }

  const handleRemoveBlocker = async (blockerTaskId: string): Promise<void> => {
    await removeBlocker.mutateAsync({ taskId: task.id, blockerTaskId })
    setBlockers(blockers.filter((b) => b.id !== blockerTaskId))
  }

  const handleSetBlocked = async (): Promise<void> => {
    track('task_blocked', {})
    const updated = await updateTask.mutateAsync({ id: task.id, isBlocked: true })
    onUpdate(updated)
  }

  const handleUnblock = async (): Promise<void> => {
    track('task_unblocked')
    const updated = await updateTask.mutateAsync({
      id: task.id,
      isBlocked: false,
      blockedComment: null
    })
    onUpdate(updated)
  }

  const handleSetBlockedWithComment = async (): Promise<void> => {
    track('task_blocked', { hasComment: 'true' })
    const updated = await updateTask.mutateAsync({
      id: task.id,
      isBlocked: true,
      blockedComment: blockedComment.trim() || null
    })
    onUpdate(updated)
    setCommentDialogOpen(false)
    setBlockedComment('')
  }

  return (
    <div>
      <label className="mb-1 block text-sm text-muted-foreground">Blocked By</label>
      {task.blocked_comment && (
        <div className="mb-2 flex items-start gap-2 rounded bg-muted/50 px-2 py-1.5 text-sm text-muted-foreground">
          <span className="flex-1 whitespace-pre-wrap">{task.blocked_comment}</span>
          <button
            onClick={async () => {
              const updated = await updateTask.mutateAsync({
                id: task.id,
                blockedComment: null
              })
              onUpdate(updated)
            }}
            className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {blockers.length > 0 && (
        <div className="mb-2 space-y-1">
          {blockers.map((blocker) => (
            <div
              key={blocker.id}
              className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-sm"
            >
              <BlockerStatusIcon
                task={blocker}
                columns={columnsByProject.get(blocker.project_id)}
              />
              <span className="flex-1 truncate">{blocker.title}</span>
              <button
                onClick={() => handleRemoveBlocker(blocker.id)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Split button: Set blocked / Unblock */}
      <SplitButton
        onClick={task.is_blocked ? handleUnblock : handleSetBlocked}
        className="flex-1"
        menu={(close) => (
          <>
            <SplitButtonItem
              onClick={() => {
                close()
                setBlockerDialogOpen(true)
              }}
            >
              <ListChecks className="h-3 w-3 shrink-0 text-muted-foreground" />
              Set blocking task
            </SplitButtonItem>
            <SplitButtonItem
              onClick={() => {
                close()
                setBlockedComment(task.blocked_comment ?? '')
                setCommentDialogOpen(true)
              }}
            >
              <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
              Set blocked with comment
            </SplitButtonItem>
          </>
        )}
      >
        {task.is_blocked ? 'Unblock' : 'Set blocked'}
      </SplitButton>

      {/* Blocking task dialog */}
      <Dialog
        open={blockerDialogOpen}
        onOpenChange={(open) => {
          setBlockerDialogOpen(open)
          if (!open) setAddBlockerSearch('')
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add blocking task</DialogTitle>
          </DialogHeader>
          <BlockerPicker
            task={task}
            blockers={blockers}
            columnsByProject={columnsByProject}
            search={addBlockerSearch}
            setSearch={setAddBlockerSearch}
            onPick={(t) => {
              void handleAddBlocker(t)
              setBlockerDialogOpen(false)
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Blocked with comment dialog */}
      <Dialog
        open={commentDialogOpen}
        onOpenChange={(open) => {
          setCommentDialogOpen(open)
          if (!open) setBlockedComment('')
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Set blocked with comment</DialogTitle>
          </DialogHeader>
          <Textarea
            value={blockedComment}
            onChange={(e) => setBlockedComment(e.target.value)}
            placeholder="Why is this task blocked?"
            rows={3}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setCommentDialogOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSetBlockedWithComment}>
              Set blocked
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface BlockerPickerProps {
  task: Task
  blockers: Task[]
  columnsByProject: Map<string, Project['columns_config']>
  search: string
  setSearch: React.Dispatch<React.SetStateAction<string>>
  onPick: (task: Task) => void
}

/**
 * The add-blocker list. Mounted only while its dialog is open, so the whole-board
 * query it reads (every task) is subscribed — and structurally compared on each
 * board change — only then, not by every open task tab's sidebar.
 */
function BlockerPicker({
  task,
  blockers,
  columnsByProject,
  search,
  setSearch,
  onPick
}: BlockerPickerProps): React.JSX.Element {
  const trpc = useTRPC()
  // Read from the board query the app already holds (`task.loadBoardData` — the
  // same rows `task.getAll` returns) rather than a second multi-MB cache entry.
  const allTasksQuery = useQuery(
    trpc.task.loadBoardData.queryOptions(undefined, { staleTime: 30_000, select: selectTasks })
  )
  const availableBlockers = (allTasksQuery.data ?? []).filter(
    (t) =>
      t.id !== task.id &&
      !blockers.some((b) => b.id === t.id) &&
      !isTerminalStatus(t.status, columnsByProject.get(t.project_id))
  )
  const filteredAvailableBlockers = availableBlockers.filter((blocker) =>
    matchesTaskSearch(blocker, search)
  )

  if (availableBlockers.length === 0) {
    return <p className="text-sm text-muted-foreground">No tasks available</p>
  }
  return (
    <div className="space-y-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search available blockers"
          placeholder="Search tasks..."
          className="h-8 pl-8 text-sm"
        />
      </div>
      {filteredAvailableBlockers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks match your search</p>
      ) : (
        <div className="max-h-[200px] space-y-1 overflow-y-auto">
          {filteredAvailableBlockers.map((t) => (
            <button
              key={t.id}
              onClick={() => onPick(t)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
            >
              <BlockerStatusIcon task={t} columns={columnsByProject.get(t.project_id)} />
              <span className="line-clamp-1 flex-1">{t.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
