import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { HubScope, useHubId, useHubOwnershipStore } from '@slayzone/transport/client'
import type {
  CrossHubMovePreview,
  MoveTasksToProjectResult,
  MoveToProjectPreview
} from '@slayzone/task-contracts'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  toast
} from '@slayzone/ui'
import { useTrack } from '@slayzone/telemetry/client'
import { useTRPC } from './trpc'

export interface MoveTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The tasks to move; all on one hub. */
  taskIds: string[]
  /** The project picked where the dialog was opened from (a menu's project list). */
  initialProjectId?: string
  /** Runs once the move is committed. */
  onMoved?: (result: MoveTasksToProjectResult) => void
  /** Projects on the app's OTHER hubs, by hub: offered when moving there is possible. */
  otherHubProjects?: OtherHubProjects[]
  /**
   * Starts a move to another hub (the app runs it in the background, with progress,
   * pause and resume). Absent: only projects of the tasks' own hub are offered.
   */
  onMoveToOtherHub?: (input: {
    targetHubId: string
    targetProjectId: string
    includeSubtasks: boolean
  }) => Promise<void>
}

export interface OtherHubProjects {
  hubId: string
  hubLabel: string
  projects: ReadonlyArray<{ id: string; name: string; color: string }>
}

/** A picked project on another hub: `hubId` + project id in one Select value. */
const OTHER_HUB_SEP = '\u0000'
const otherHubValue = (hubId: string, projectId: string): string =>
  `${hubId}${OTHER_HUB_SEP}${projectId}`
function parseTarget(value: string): { hubId: string | null; projectId: string } {
  const at = value.indexOf(OTHER_HUB_SEP)
  return at < 0
    ? { hubId: null, projectId: value }
    : { hubId: value.slice(0, at), projectId: value.slice(at + 1) }
}

/**
 * Every move to another project goes through here (board menus, the task palette,
 * the task's project field): the user picks the project, sees what the move does
 * — subtasks, detaching, tags, statuses, worktrees, sessions — and confirms. A move
 * can't be undone.
 *
 * It talks to the hub that holds the tasks (their `HubScope`), so the project list
 * is that hub's: a task moves only between projects of its own hub.
 */
export function MoveTaskDialog(props: MoveTaskDialogProps): React.JSX.Element {
  const { open, onOpenChange, taskIds } = props
  const ambientHubId = useHubId()
  // One string, so the store selector stays stable (a fresh array would re-render forever).
  const hubKey = useHubOwnershipStore((s) =>
    taskIds.map((id) => s.hubIdByTask.get(id) ?? '').join('\n')
  )
  const hubs = [...new Set(hubKey.split('\n'))]
  const taskHubId = hubs.length === 1 && hubs[0] ? hubs[0] : null
  const body =
    hubs.length > 1 ? (
      <MixedHubsBody onClose={() => onOpenChange(false)} />
    ) : (
      <MoveTaskDialogBody {...props} />
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        data-testid="move-task-dialog"
        // Focus the form, not the first control (the project picker), so Enter confirms
        // the project already picked. Done here, inside the dialog's focus trap, so a
        // menu closing behind it cannot keep the focus.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)
            ?.querySelector<HTMLElement>('[data-move-task-form]')
            ?.focus()
        }}
      >
        {taskHubId && taskHubId !== ambientHubId ? (
          <HubScope hubId={taskHubId}>{body}</HubScope>
        ) : (
          body
        )}
      </DialogContent>
    </Dialog>
  )
}

function MixedHubsBody({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Move to project</DialogTitle>
        <DialogDescription>
          These tasks are on different hubs. Move the tasks of one hub at a time.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  )
}

function MoveTaskDialogBody({
  taskIds,
  initialProjectId,
  onOpenChange,
  onMoved,
  otherHubProjects,
  onMoveToOtherHub
}: MoveTaskDialogProps): React.JSX.Element {
  const trpc = useTRPC()
  const { trackTask } = useTrack()
  const otherHubs = onMoveToOtherHub ? (otherHubProjects ?? []) : []
  const initialOtherHub = otherHubs.find((h) => h.projects.some((p) => p.id === initialProjectId))
  const [targetValue, setTargetValue] = useState(
    initialProjectId
      ? initialOtherHub
        ? otherHubValue(initialOtherHub.hubId, initialProjectId)
        : initialProjectId
      : ''
  )
  const { hubId: targetHubId, projectId: targetId } = parseTarget(targetValue)
  const crossHub = targetHubId !== null
  const [includeSubtasks, setIncludeSubtasks] = useState(true)
  /** Agent tabs the user un-ticked: every other tab that can keep its session does. */
  const [freshTabIds, setFreshTabIds] = useState<ReadonlySet<string>>(new Set())
  const { data: projects } = useQuery(trpc.projects.list.queryOptions())
  const previewQuery = useQuery(
    trpc.task.movePreview.queryOptions(
      { taskIds, targetProjectId: targetId, includeSubtasks },
      { enabled: targetId !== '' && !crossHub }
    )
  )
  const preview = previewQuery.data
  const { data: crossPreview } = useQuery(
    trpc.taskMoves.preview.queryOptions({ taskIds }, { enabled: crossHub })
  )
  const move = useMutation(trpc.task.moveToProject.mutationOptions())
  const [starting, setStarting] = useState(false)
  const otherHub = otherHubs.find((h) => h.hubId === targetHubId)
  const target = crossHub
    ? otherHub?.projects.find((p) => p.id === targetId)
    : projects?.find((p) => p.id === targetId)
  const nothingToMove = preview !== undefined && preview.taskCount === 0
  const canMove = crossHub
    ? target !== undefined &&
      crossPreview !== undefined &&
      !crossPreview.linkedToIntegration &&
      !crossPreview.alreadyMoving &&
      !starting
    : target !== undefined && preview !== undefined && !nothingToMove && !move.isPending

  const confirm = (): void => {
    if (!canMove) return
    for (const id of taskIds) trackTask(id, 'task_moved_to_project')
    if (crossHub && targetHubId && onMoveToOtherHub) {
      setStarting(true)
      onMoveToOtherHub({ targetHubId, targetProjectId: targetId, includeSubtasks })
        .then(() => onOpenChange(false))
        .catch((error: unknown) => {
          setStarting(false)
          toast.error(`Couldn't move: ${error instanceof Error ? error.message : String(error)}`)
        })
      return
    }
    move
      .mutateAsync({
        taskIds,
        targetProjectId: targetId,
        includeSubtasks,
        keepSessionTabIds: (preview?.sessions ?? [])
          .filter((t) => t.canKeep && !freshTabIds.has(t.tabId))
          .map((t) => t.tabId)
      })
      .then((result) => {
        onOpenChange(false)
        onMoved?.(result)
      })
      .catch((error: unknown) => {
        toast.error(`Couldn't move: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  const count = taskIds.length
  return (
    <form
      data-move-task-form
      tabIndex={-1}
      onSubmit={(e) => {
        e.preventDefault()
        confirm()
      }}
      // Enter anywhere but a control confirms (focus starts on the form itself).
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault()
          confirm()
        }
      }}
      className="flex flex-col gap-4 outline-none"
    >
      <DialogHeader>
        <DialogTitle>
          {count === 1 ? 'Move task to project' : `Move ${count} tasks to project`}
        </DialogTitle>
        <DialogDescription>This can't be undone.</DialogDescription>
      </DialogHeader>

      <Select value={targetValue} onValueChange={setTargetValue}>
        <SelectTrigger className="w-full" data-testid="move-task-project-select">
          <SelectValue placeholder="Choose a project" />
        </SelectTrigger>
        <SelectContent>
          {otherHubs.length > 0 ? (
            <>
              <SelectGroup>
                <SelectLabel>This hub</SelectLabel>
                {(projects ?? []).map((p) => (
                  <ProjectItem key={p.id} value={p.id} name={p.name} color={p.color} />
                ))}
              </SelectGroup>
              {otherHubs.map((h) => (
                <SelectGroup key={h.hubId}>
                  <SelectLabel>{h.hubLabel}</SelectLabel>
                  {h.projects.map((p) => (
                    <ProjectItem
                      key={p.id}
                      value={otherHubValue(h.hubId, p.id)}
                      name={p.name}
                      color={p.color}
                    />
                  ))}
                </SelectGroup>
              ))}
            </>
          ) : (
            (projects ?? []).map((p) => (
              <ProjectItem key={p.id} value={p.id} name={p.name} color={p.color} />
            ))
          )}
        </SelectContent>
      </Select>

      {crossHub && crossPreview && target && otherHub && (
        <CrossHubSummary
          preview={crossPreview}
          hubLabel={otherHub.hubLabel}
          targetName={target.name}
          includeSubtasks={includeSubtasks}
          onIncludeSubtasksChange={setIncludeSubtasks}
        />
      )}

      {!crossHub && preview && target && (
        <MoveSummary
          preview={preview}
          targetName={target.name}
          includeSubtasks={includeSubtasks}
          onIncludeSubtasksChange={setIncludeSubtasks}
          freshTabIds={freshTabIds}
          onKeepSessionChange={(tabId, keep) =>
            setFreshTabIds((prev) => {
              const next = new Set(prev)
              if (keep) next.delete(tabId)
              else next.add(tabId)
              return next
            })
          }
        />
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canMove} data-testid="move-task-confirm">
          {move.isPending || starting ? 'Moving…' : 'Move'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ProjectItem({
  value,
  name,
  color
}: {
  value: string
  name: string
  color: string
}): React.JSX.Element {
  return (
    <SelectItem value={value}>
      <span className="flex items-center gap-2">
        <span className="inline-block size-2 rounded-full" style={{ backgroundColor: color }} />
        {name}
      </span>
    </SelectItem>
  )
}

/** A move to another hub: what it carries, what it leaves, and that it runs on its own. */
function CrossHubSummary({
  preview,
  hubLabel,
  targetName,
  includeSubtasks,
  onIncludeSubtasksChange
}: {
  preview: CrossHubMovePreview
  hubLabel: string
  targetName: string
  includeSubtasks: boolean
  onIncludeSubtasksChange: (value: boolean) => void
}): React.JSX.Element {
  if (preview.linkedToIntegration)
    return (
      <p className="text-sm text-destructive" data-testid="move-task-cross-hub-refused">
        A task here is linked to an integration on this hub. Unlink it before moving it to another
        hub.
      </p>
    )
  if (preview.alreadyMoving)
    return (
      <p className="text-sm text-destructive" data-testid="move-task-cross-hub-refused">
        A task here is already being moved to another hub.
      </p>
    )
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="move-task-cross-hub-summary">
      {preview.subtaskCount > 0 && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="move-task-include-subtasks"
            checked={includeSubtasks}
            onCheckedChange={(v) => onIncludeSubtasksChange(v === true)}
            data-testid="move-task-include-subtasks"
          />
          <Label htmlFor="move-task-include-subtasks">
            Bring subtasks ({preview.subtaskCount})
          </Label>
        </div>
      )}
      <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
        <li>
          Moves to {targetName} on {hubLabel}: the tasks, their tabs, tags, files and history.
        </li>
        <li>Running agents stop; agent sessions start fresh on the other hub.</li>
        {preview.externalBlockerCount > 0 && (
          <li>
            {preview.externalBlockerCount === 1
              ? 'A blocker with a task that stays here becomes a link between the hubs.'
              : `${preview.externalBlockerCount} blockers with tasks that stay here become links between the hubs.`}
          </li>
        )}
        <li>
          The move runs in the background: you can pause and resume it. Until it is done, the tasks
          are locked.
        </li>
      </ul>
    </div>
  )
}

function MoveSummary({
  preview,
  targetName,
  includeSubtasks,
  onIncludeSubtasksChange,
  freshTabIds,
  onKeepSessionChange
}: {
  preview: MoveToProjectPreview
  targetName: string
  includeSubtasks: boolean
  onIncludeSubtasksChange: (value: boolean) => void
  freshTabIds: ReadonlySet<string>
  onKeepSessionChange: (tabId: string, keep: boolean) => void
}): React.JSX.Element {
  if (preview.taskCount === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="move-task-already-there">
        Already in {targetName}.
      </p>
    )
  const shownStatusChanges = preview.statusChanges.slice(0, 5)
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="move-task-summary">
      {preview.detachedFrom.length > 0 && (
        <div
          className="rounded-md border border-border bg-muted p-3"
          data-testid="move-task-detach-notice"
        >
          {preview.detachedFrom.length === 1 ? (
            <>
              “{preview.detachedFrom[0].title}” is a subtask of “
              {preview.detachedFrom[0].parentTitle}”. Moving it detaches it from its parent: it
              becomes a top-level task in {targetName}.
            </>
          ) : (
            <>
              {preview.detachedFrom.length} of these tasks are subtasks. Moving them detaches them
              from their parents: they become top-level tasks in {targetName}.
            </>
          )}
        </div>
      )}

      {preview.subtaskCount > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id="move-task-include-subtasks"
              checked={includeSubtasks}
              onCheckedChange={(v) => onIncludeSubtasksChange(v === true)}
              data-testid="move-task-include-subtasks"
            />
            <Label htmlFor="move-task-include-subtasks">
              Bring subtasks ({preview.subtaskCount})
            </Label>
          </div>
          {!includeSubtasks && (
            <p className="pl-6 text-muted-foreground">
              They stay where they are and become top-level tasks.
            </p>
          )}
        </div>
      )}

      {preview.sessions.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="move-task-sessions">
          <span className="font-medium">Agent sessions</span>
          <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
            {preview.sessions.map((tab) => {
              const id = `move-task-keep-${tab.tabId}`
              const multiTask = new Set(preview.sessions.map((t) => t.taskId)).size > 1
              return (
                <div key={tab.tabId} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={tab.canKeep && !freshTabIds.has(tab.tabId)}
                      disabled={!tab.canKeep}
                      onCheckedChange={(v) => onKeepSessionChange(tab.tabId, v === true)}
                      data-testid={`move-task-keep-session-${tab.tabId}`}
                    />
                    <Label
                      htmlFor={id}
                      className={tab.canKeep ? undefined : 'text-muted-foreground'}
                    >
                      Keep {tab.tabLabel}
                      {multiTask ? ` (${tab.taskTitle})` : ''}
                    </Label>
                  </div>
                  {tab.reason && <p className="pl-6 text-muted-foreground">{tab.reason}.</p>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
        <li>
          Running agents stop.
          {preview.sessions.length > 0
            ? ' A kept session continues in the new folder when its agent starts again; the others start fresh.'
            : ''}
        </li>
        {preview.worktreeCount > 0 && (
          <li>
            {preview.worktreeCount === 1
              ? 'The worktree is detached (its folder stays on disk).'
              : `${preview.worktreeCount} worktrees are detached (their folders stay on disk).`}
          </li>
        )}
        {preview.tagsToCreate.length > 0 && (
          <li>
            New tags in {targetName}: {preview.tagsToCreate.join(', ')}
          </li>
        )}
        {shownStatusChanges.map((c) => (
          <li key={c.taskId}>
            “{c.title}”: status {c.fromLabel} → {c.toLabel}
          </li>
        ))}
        {preview.statusChanges.length > shownStatusChanges.length && (
          <li>{preview.statusChanges.length - shownStatusChanges.length} more status changes</li>
        )}
      </ul>
    </div>
  )
}

/**
 * The projects a task can move to: those on the hub holding it (the first of
 * `taskIds`). A project lives in one hub's database, so another hub's project is
 * never a move target. Without ownership known yet (no board loaded), every project.
 */
export function useProjectsOnTaskHub<P extends { id: string }>(
  projects: readonly P[],
  taskIds: readonly string[]
): P[] {
  const taskHub = useHubOwnershipStore((s) => s.hubIdByTask.get(taskIds[0] ?? ''))
  const hubIdByProject = useHubOwnershipStore((s) => s.hubIdByProject)
  if (taskHub === undefined) return [...projects]
  return projects.filter((p) => hubIdByProject.get(p.id) === taskHub)
}
