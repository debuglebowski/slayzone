import type { ComputerMovePreview } from '@slayzone/task-contracts'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@slayzone/ui'

export function ComputerMoveDialog(props: {
  preview: ComputerMovePreview | null
  source: string
  destination: string
  allowFresh: boolean
  onAllowFresh(value: boolean): void
  pending: boolean
  error: string | null
  onClose(): void
  onConfirm(): void
}) {
  const { preview } = props
  const fresh = preview?.agents.filter((a) => !a.canResume) ?? []
  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to computer</DialogTitle>
          <DialogDescription>
            Move this task from {props.source} to {props.destination}. The task stays in its
            project. Subtasks keep their current computer.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {preview?.blockers.map((blocker) => (
            <p key={blocker} role="alert" className="text-destructive">
              {blocker}
            </p>
          ))}
          <p>
            Running agents, terminals and task processes will stop before transfer. Start them again
            on {props.destination} when the move finishes.
          </p>
          {preview?.hasFiles && (
            <p>
              Copies the task’s worktree and custom folder, including staged, uncommitted and
              ignored files. A new branch is created on the destination so existing branches stay
              safe.
            </p>
          )}
          <p>
            Supported agent history and terminal scrollback transfer too. Source files stay intact
            as a recovery copy.
          </p>
          <p>
            Installed dependencies and absolute symlinks may need updating for the destination’s
            operating system.
          </p>
          {preview?.agents.map((agent) => (
            <p key={agent.tabId}>
              <strong>{agent.label}:</strong>{' '}
              {agent.canResume ? 'Session can resume after the move.' : agent.reason}
            </p>
          ))}
          {fresh.length > 0 && (
            <label className="flex items-start gap-2" htmlFor="computer-move-fresh-sessions">
              <Checkbox
                id="computer-move-fresh-sessions"
                checked={props.allowFresh}
                onCheckedChange={(value) => props.onAllowFresh(value === true)}
              />
              Start unsupported agent sessions fresh on the destination. Their original history
              stays on the source computer.
            </label>
          )}
          {props.error && (
            <p role="alert" className="text-destructive">
              {props.error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.pending}>
            Cancel
          </Button>
          <Button
            onClick={props.onConfirm}
            disabled={props.pending || !preview?.ready || (fresh.length > 0 && !props.allowFresh)}
          >
            {props.pending ? 'Starting move…' : `Move to ${props.destination}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
