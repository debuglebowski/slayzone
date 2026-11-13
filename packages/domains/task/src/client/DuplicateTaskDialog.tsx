import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { HubScope, useHubId, useHubOwnershipStore } from '@slayzone/transport/client'
import type { DuplicateTaskResult } from '@slayzone/task-contracts'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast
} from '@slayzone/ui'
import { useTabStore } from '@slayzone/tabs-state'
import { useTrack } from '@slayzone/telemetry/client'
import { useTRPC } from './trpc'

export interface DuplicateTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: { id: string; title: string; project_id: string }
  /** Runs once the duplicate exists (after it is opened). */
  onDuplicated?: (result: DuplicateTaskResult) => void
}

/**
 * Duplicate a task as a fresh follow-up — typically once its branch is merged and
 * more work on the same topic remains. The user picks the project (the task's own
 * by default, any project of its hub) and the title; the copy keeps description,
 * priority, assignee, agent and tags, and starts fresh: default status, no subtasks,
 * worktree or sessions. It opens when created.
 *
 * Talks to the hub holding the task (its `HubScope`), so the projects offered are
 * that hub's.
 */
export function DuplicateTaskDialog(props: DuplicateTaskDialogProps): React.JSX.Element {
  const { open, onOpenChange, task } = props
  const ambientHubId = useHubId()
  const taskHubId = useHubOwnershipStore((s) => s.hubIdByTask.get(task.id))
  const body = <DuplicateTaskDialogBody {...props} />
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="duplicate-task-dialog">
        {taskHubId && taskHubId !== ambientHubId ? (
          <HubScope hubId={taskHubId}>{body}</HubScope>
        ) : (
          body
        )}
      </DialogContent>
    </Dialog>
  )
}

function DuplicateTaskDialogBody({
  task,
  onOpenChange,
  onDuplicated
}: DuplicateTaskDialogProps): React.JSX.Element {
  const trpc = useTRPC()
  const { trackTask } = useTrack()
  const [targetId, setTargetId] = useState(task.project_id)
  const [title, setTitle] = useState(task.title)
  const { data: projects } = useQuery(trpc.projects.list.queryOptions())
  const duplicate = useMutation(trpc.task.duplicate.mutationOptions())
  const canDuplicate = title.trim() !== '' && targetId !== '' && !duplicate.isPending

  const confirm = (): void => {
    if (!canDuplicate) return
    trackTask(task.id, 'task_duplicated')
    duplicate
      .mutateAsync({ taskId: task.id, targetProjectId: targetId, title: title.trim() })
      .then((result) => {
        onOpenChange(false)
        useTabStore.getState().openTask(result.taskId)
        onDuplicated?.(result)
      })
      .catch((error: unknown) => {
        toast.error(`Couldn't duplicate: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        confirm()
      }}
      className="flex flex-col gap-4"
    >
      <DialogHeader>
        <DialogTitle>Duplicate task</DialogTitle>
        <DialogDescription>
          A fresh task with the same description, priority, assignee, agent and tags. Subtasks,
          files, worktree and agent sessions stay with the original.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="duplicate-task-title">Title</Label>
        <Input
          id="duplicate-task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          data-testid="duplicate-task-title"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Project</Label>
        <Select value={targetId} onValueChange={setTargetId}>
          <SelectTrigger className="w-full" data-testid="duplicate-task-project-select">
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent>
            {(projects ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: p.color }}
                  />
                  {p.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canDuplicate} data-testid="duplicate-task-confirm">
          {duplicate.isPending ? 'Duplicating…' : 'Duplicate'}
        </Button>
      </DialogFooter>
    </form>
  )
}
