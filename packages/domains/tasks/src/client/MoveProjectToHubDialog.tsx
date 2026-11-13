import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Project } from '@slayzone/projects-contracts'
import type { ProjectMovePreview } from '@slayzone/task-contracts'
import {
  HubScope,
  useFederationOrNull,
  useHubId,
  useHubIdForProject
} from '@slayzone/transport/client'
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
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast
} from '@slayzone/ui'
import { startProjectMove } from './cross-hub-moves'
import { useTRPC } from './trpc'

/**
 * Move a whole project to another hub the app is connected to: every task in it
 * (archived ones and subtasks too), its tags, automations, templates, settings and
 * icon, and — when kept — its agent sessions. The project keeps its id there. The
 * move runs in the background (`TaskMovesPanel`).
 */
export function MoveProjectToHubDialog({
  project,
  open,
  onOpenChange
}: {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const projectHubId = useHubIdForProject(project?.id ?? null)
  const ambientHubId = useHubId()
  let body: React.JSX.Element | null = null
  if (project && projectHubId) {
    body = (
      <MoveProjectBody
        project={project}
        sourceHubId={projectHubId}
        onClose={() => onOpenChange(false)}
      />
    )
    // The project's own hub answers the preview and runs the move's journal.
    if (projectHubId !== ambientHubId) body = <HubScope hubId={projectHubId}>{body}</HubScope>
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="move-project-dialog">
        {body}
      </DialogContent>
    </Dialog>
  )
}

function MoveProjectBody({
  project,
  sourceHubId,
  onClose
}: {
  project: Project
  sourceHubId: string
  onClose: () => void
}): React.JSX.Element {
  const trpc = useTRPC()
  const federation = useFederationOrNull()
  const otherHubs = (federation?.hubs ?? []).filter((h) => h.id !== sourceHubId)
  const [targetHubId, setTargetHubId] = useState(otherHubs.length === 1 ? otherHubs[0].id : '')
  const [includeSessions, setIncludeSessions] = useState(true)
  const [starting, setStarting] = useState(false)
  const { data: preview } = useQuery(
    trpc.taskMoves.projectPreview.queryOptions({ projectId: project.id })
  )
  const target = otherHubs.find((h) => h.id === targetHubId)
  const refused =
    preview !== undefined &&
    (preview.linkedToIntegration || preview.deletionPending || preview.alreadyMoving)
  const canMove = target !== undefined && preview !== undefined && !refused && !starting

  const confirm = (): void => {
    if (!canMove) return
    setStarting(true)
    startProjectMove({ sourceHubId, targetHubId, projectId: project.id, includeSessions })
      .then(() => onClose())
      .catch((error: unknown) => {
        setStarting(false)
        toast.error(`Couldn't move: ${error instanceof Error ? error.message : String(error)}`)
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
        <DialogTitle>Move “{project.name}” to another hub</DialogTitle>
        <DialogDescription>The project leaves this hub when the move is done.</DialogDescription>
      </DialogHeader>

      <Select value={targetHubId} onValueChange={setTargetHubId}>
        <SelectTrigger className="w-full" data-testid="move-project-hub-select">
          <SelectValue placeholder="Choose a hub" />
        </SelectTrigger>
        <SelectContent>
          {otherHubs.map((h) => (
            <SelectItem key={h.id} value={h.id}>
              {h.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {preview && (
        <ProjectMoveSummary
          preview={preview}
          hubLabel={target?.label ?? null}
          includeSessions={includeSessions}
          onIncludeSessionsChange={setIncludeSessions}
        />
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canMove} data-testid="move-project-confirm">
          {starting ? 'Moving…' : 'Move'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** What the project move carries and leaves, or why it cannot start. */
function ProjectMoveSummary({
  preview,
  hubLabel,
  includeSessions,
  onIncludeSessionsChange
}: {
  preview: ProjectMovePreview
  hubLabel: string | null
  includeSessions: boolean
  onIncludeSessionsChange: (value: boolean) => void
}): React.JSX.Element {
  const refusal = preview.linkedToIntegration
    ? 'This project is linked to an integration on this hub. Unlink it before moving it to another hub.'
    : preview.deletionPending
      ? 'A task of this project is still being deleted. Wait for the deletion to finish.'
      : preview.alreadyMoving
        ? 'This project, or a task of it, is already being moved to another hub.'
        : null
  if (refusal)
    return (
      <p className="text-sm text-destructive" data-testid="move-project-refused">
        {refusal}
      </p>
    )
  const tasks = preview.taskCount === 1 ? '1 task' : `${preview.taskCount} tasks`
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="move-project-summary">
      <div className="flex items-center gap-2">
        <Checkbox
          id="move-project-include-sessions"
          checked={includeSessions}
          onCheckedChange={(v) => onIncludeSessionsChange(v === true)}
          data-testid="move-project-include-sessions"
        />
        <Label htmlFor="move-project-include-sessions">Keep agent sessions</Label>
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
        <li>
          Moves {hubLabel ? `to ${hubLabel}` : 'to the hub you choose'}: {tasks} (archived ones and
          subtasks too), tags, automations, templates, test labels, settings, icon and history.
        </li>
        <li>
          {includeSessions
            ? 'Running agents stop. Their chats and session history go with the tasks.'
            : 'Running agents stop; agent sessions start fresh on the other hub.'}
        </li>
        {preview.externalBlockerCount > 0 && (
          <li>
            {preview.externalBlockerCount === 1
              ? 'A blocker with a task in another project becomes a link between the hubs.'
              : `${preview.externalBlockerCount} blockers with tasks in other projects become links between the hubs.`}
          </li>
        )}
        <li>
          Left behind: automation run history and running processes. The project arrives ungrouped;
          its folder is offered to that hub's default computer.
        </li>
        <li>
          The move runs in the background: you can pause and resume it. Until it is done, the
          project is locked.
        </li>
      </ul>
    </div>
  )
}
