import { useId, useState } from 'react'
import type { ComputerMoveDestination, ComputerMovePreview } from '@slayzone/task-contracts'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'

/**
 * Choose where a task runs. Picking a computer asks the hub what that takes: a
 * plain switch when nothing has to travel, else a move (files, agent history) —
 * and, when the destination is not set up for the project, the fix in place.
 */
export function ChangeComputerDialog(props: {
  open: boolean
  options: Array<{ value: string; label: string; disabled?: boolean; mark?: string }>
  /** The chosen option's value. */
  choice: string
  onChoose(value: string): void
  /** The computer the choice resolves to. */
  choiceName: string
  sourceName: string
  /** The choice is the task's binding already: nothing to do. */
  isCurrent: boolean
  checking: boolean
  preview: ComputerMovePreview | null
  allowFresh: boolean
  onAllowFresh(value: boolean): void
  pending: boolean
  error: string | null
  onClose(): void
  onConfirm(): void
  /** The task's project: the folder chosen here is recorded for it. */
  projectId: string
  /** Set up the destination: a step is running. */
  preparing: boolean
  onChooseFolder(path: string): void
  onClone(): void
}) {
  const { preview } = props
  const selectId = useId()
  const migrate = preview?.requiresMigration === true
  const fresh = migrate ? (preview?.agents.filter((a) => !a.canResume) ?? []) : []
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change computer</DialogTitle>
          <DialogDescription>
            {migrate
              ? `Moves this task from ${props.sourceName} to ${props.choiceName}. It stays in its project; subtasks keep their computer.`
              : 'Choose where this task runs.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <label htmlFor={selectId} className="mb-1 block text-muted-foreground">
              Computer
            </label>
            <Select
              value={props.choice}
              onValueChange={props.onChoose}
              disabled={props.pending || props.preparing}
            >
              <SelectTrigger id={selectId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {props.options.map((option) => (
                  <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                    {option.mark && (
                      <span className="text-muted-foreground ml-1.5 text-xs">{option.mark}</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {props.checking && <p className="text-muted-foreground">Checking {props.choiceName}…</p>}
          {preview?.blockers.map((blocker) => (
            <p key={blocker} className="text-destructive">
              {blocker}
            </p>
          ))}
          {preview?.destination && (
            <DestinationSetup
              destination={preview.destination}
              computerId={preview.destinationComputerId}
              computerName={props.choiceName}
              projectId={props.projectId}
              preparing={props.preparing}
              onChooseFolder={props.onChooseFolder}
              onClone={props.onClone}
            />
          )}
          {migrate && (
            <>
              <p>
                Running agents, terminals and processes stop first; start them again on{' '}
                {props.choiceName}.
                {preview?.hasFiles &&
                  ' The worktree and custom folder are copied, uncommitted and ignored files included, on a new branch.'}{' '}
                Supported agent history and scrollback come along; the source stays as a recovery
                copy.
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
            </>
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
            disabled={
              props.isCurrent ||
              props.checking ||
              props.pending ||
              props.preparing ||
              !preview?.ready ||
              (fresh.length > 0 && !props.allowFresh)
            }
          >
            {props.pending
              ? migrate
                ? 'Starting move…'
                : 'Switching…'
              : `${migrate ? 'Move' : 'Switch'} to ${props.choiceName}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What the destination lacks for this task, and the fix in place: choose the
 * project's folder on that computer, or clone the repository into it.
 */
function DestinationSetup(props: {
  destination: ComputerMoveDestination
  computerId: string
  computerName: string
  projectId: string
  preparing: boolean
  onChooseFolder(path: string): void
  onClone(): void
}) {
  const { destination: d } = props
  const [picking, setPicking] = useState(false)
  const repoMissing = d.repoRequired && !d.repoReady
  if (d.folderExists && !repoMissing) return null
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      {d.folder && repoMissing && d.cloneUrl ? (
        <p>
          Clone <code>{d.cloneUrl}</code> into <code>{d.repoPath ?? d.folder}</code>?
        </p>
      ) : d.folder && repoMissing ? (
        <p>
          The source repository has no remote. Check it out in <code>{d.repoPath ?? d.folder}</code>{' '}
          on {props.computerName}, or choose another folder.
        </p>
      ) : (
        <p>Choose where this project lives on {props.computerName}.</p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={props.preparing}
          onClick={() => setPicking(true)}
        >
          Choose folder…
        </Button>
        {d.folder && repoMissing && d.cloneUrl && (
          <Button size="sm" disabled={props.preparing} onClick={props.onClone}>
            {props.preparing ? 'Working…' : 'Clone repository'}
          </Button>
        )}
      </div>
      {picking && (
        <WorkspaceDirPicker
          open={picking}
          onOpenChange={setPicking}
          onSelect={(path) => {
            setPicking(false)
            props.onChooseFolder(path)
          }}
          target={{ computerId: props.computerId, projectId: props.projectId }}
          title={`Project folder on ${props.computerName}`}
          defaultPath={d.folder}
          allowCreate
        />
      )}
    </div>
  )
}
