import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from './trpc'
import { Button } from '@slayzone/ui'
import type { ComputerMove, ComputerMovePreview } from '@slayzone/task-contracts'
import { ChangeComputerDialog } from './ChangeComputerDialog'
// The words every client shows for a computer choice (the mobile app too).
import {
  computerName,
  DISABLED_MARK,
  inheritComputerLabel,
  NO_COMPUTERS_NOTE,
  OFFLINE_MARK,
  runsOnLabel
} from '@slayzone/computers/labels'

/**
 * Per-task computer selector (hub/computer split, wave 3 UI).
 *
 * Backend model (see `computers` router / store):
 *   - `tasks.computer_id`          : NULL = inherit the project default; else pinned.
 *   - `projects.default_computer_id`: NULL = no explicit default (exec uses the
 *     connected default computer, else runs in-process); else a specific computer.
 *   - `resolveTaskComputer`        : the effective (coalesced) computer — null = local.
 *
 * The task's own binding is only ever {inherit | pinned-to-computer}: `setTaskComputer`
 * takes `string | null` where null = inherit. There is no separate "explicit local"
 * for a task (a non-null id that isn't a live computer would fail exec routing rather
 * than run locally) — "local" is expressed by the inherit option resolving to Local,
 * surfaced in the option label as "Inherit project default (Local)".
 *
 * When no computers are enrolled (none enrolled — the default), everything runs
 * locally, so the card degrades to a minimal muted note instead of an inert select.
 */

const INHERIT_VALUE = '__inherit__'
const MOVE_STEP_LABELS: Record<ComputerMove['step'], string> = {
  stop: 'Stopping running work',
  files: 'Copying files',
  activate: 'Preparing destination',
  sessions: 'Copying agent history',
  verify: 'Verifying transfer',
  commit: 'Switching computer',
  finish: 'Finishing move'
}

interface ComputerCardProps {
  taskId: string
  /** The task's project: its folder on a destination computer can be set from the move. */
  projectId: string
  /** The task's own binding — null = inherit the project default. */
  taskComputerId: string | null
  /** The project's default computer — null = local. Labels the inherit option. */
  projectDefaultComputerId: string | null
}

export function ComputerCard({ ...props }: ComputerCardProps): React.JSX.Element {
  const trpc = useTRPC()
  const computers = useQuery(trpc.computers.list.queryOptions()).data ?? []
  if (computers.length === 0)
    return (
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Computer</label>
        <p className="text-sm text-muted-foreground">{NO_COMPUTERS_NOTE}</p>
      </div>
    )
  return <ComputerCardControls key={props.taskId} {...props} computers={computers} />
}

function ComputerCardControls({
  taskId,
  projectId,
  taskComputerId,
  projectDefaultComputerId,
  computers
}: ComputerCardProps & {
  computers: Array<{ id: string; name: string; disabledAt?: number | null; usable?: boolean }>
}): React.JSX.Element {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const currentTask = useRef<string | null>(taskId)
  useLayoutEffect(() => {
    currentTask.current = taskId
    return () => {
      currentTask.current = null
    }
  }, [taskId])
  const resolvedQuery = useQuery(trpc.computers.resolveTaskComputer.queryOptions({ taskId }))
  const setTaskComputer = useMutation(trpc.computers.setTaskComputer.mutationOptions())
  const moveQuery = useQuery({
    ...trpc.task.computerMove.queryOptions({ taskId }),
    refetchInterval: (query) =>
      query.state.data && ['running', 'failed'].includes(query.state.data.status) ? 1000 : false
  })
  const completedMoveId = moveQuery.data?.status === 'done' ? moveQuery.data.id : null
  const refetchResolved = resolvedQuery.refetch
  useEffect(() => {
    void refetchResolved()
  }, [completedMoveId, taskComputerId, projectDefaultComputerId, refetchResolved])
  const beginMove = useMutation(trpc.task.beginComputerMove.mutationOptions())
  const retryMove = useMutation(trpc.task.runComputerMove.mutationOptions())
  const cancelMove = useMutation(trpc.task.cancelComputerMove.mutationOptions())

  // The change dialog: the binding chosen in it (null = inherit), and what the hub
  // says that choice takes. Nothing is saved until the user confirms.
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<string | null>(taskComputerId)
  const [preview, setPreview] = useState<ComputerMovePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [allowFresh, setAllowFresh] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [saving, setSaving] = useState(false)
  const moving = moveQuery.data?.status === 'running' || moveQuery.data?.status === 'failed'

  const nameFor = (id: string | null): string => computerName(computers, id)
  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  const isCurrent = choice === taskComputerId

  const openDialog = (): void => {
    setChoice(taskComputerId)
    setPreview(null)
    setError(null)
    setAllowFresh(false)
    setOpen(true)
  }
  const closeDialog = (): void => {
    if (saving) return
    setOpen(false)
    setPreview(null)
    setError(null)
  }

  /** Ask the hub what moving to `computerId` takes; stale answers are dropped. */
  const check = async (computerId: string | null): Promise<void> => {
    setChecking(true)
    await client.task.computerMovePreview
      .query({ taskId, computerId })
      .then((next) => {
        if (currentTask.current === taskId) setPreview(next)
      })
      .catch((err: unknown) => {
        if (currentTask.current === taskId) setError(messageOf(err))
      })
      .then(() => {
        if (currentTask.current === taskId) setChecking(false)
      })
  }
  const choose = (value: string): void => {
    const computerId = value === INHERIT_VALUE ? null : value
    setChoice(computerId)
    setPreview(null)
    setError(null)
    setAllowFresh(false)
    if (computerId !== taskComputerId) void check(computerId)
  }

  const confirm = async (): Promise<void> => {
    if (!preview || isCurrent) return
    setError(null)
    setSaving(true)
    const run = async (): Promise<void> => {
      if (preview.requiresMigration) {
        await beginMove.mutateAsync({ taskId, computerId: choice, allowFreshSessions: allowFresh })
        await moveQuery.refetch()
      } else {
        await setTaskComputer.mutateAsync({ taskId, computerId: choice })
        await resolvedQuery.refetch()
      }
      if (currentTask.current === taskId) {
        setOpen(false)
        setPreview(null)
      }
    }
    await run()
      .catch((err: unknown) => {
        if (currentTask.current === taskId) setError(messageOf(err))
      })
      .then(() => {
        if (currentTask.current === taskId) setSaving(false)
      })
  }

  /** Set up the destination (a step), then show what it says now. */
  const prepare = async (step: () => Promise<unknown>): Promise<void> => {
    setError(null)
    setPreparing(true)
    const run = async (): Promise<void> => {
      const result = await step()
      const next =
        result && typeof result === 'object' && 'destinationComputerId' in result
          ? (result as ComputerMovePreview)
          : await client.task.computerMovePreview.query({ taskId, computerId: choice })
      if (currentTask.current === taskId) setPreview(next)
    }
    await run()
      .catch((err: unknown) => {
        if (currentTask.current === taskId) setError(messageOf(err))
      })
      .then(() => {
        if (currentTask.current === taskId) setPreparing(false)
      })
  }
  const chooseFolder = (path: string): void => {
    if (!preview) return
    const computerId = preview.destinationComputerId
    void prepare(() => client.workspace.setProjectPath.mutate({ computerId, projectId, path }))
  }
  const cloneRepository = (): void => {
    void prepare(() => client.task.cloneForComputerMove.mutate({ taskId, computerId: choice }))
  }

  const control = async (action: 'retry' | 'cancel') => {
    setMoveError(null)
    const mutation = action === 'retry' ? retryMove : cancelMove
    const run = async (): Promise<void> => {
      await mutation.mutateAsync({ taskId })
      await moveQuery.refetch()
      await resolvedQuery.refetch()
    }
    await run().catch((err: unknown) => setMoveError(messageOf(err)))
  }

  const effectiveId = resolvedQuery.data?.computerId ?? null
  const options = [
    { value: INHERIT_VALUE, label: inheritComputerLabel(nameFor(projectDefaultComputerId)) },
    ...computers.map((computer) => ({
      value: computer.id,
      label: computer.name,
      // A DISABLED computer (Settings → Connections) takes no new work, so nothing
      // new may be bound to it; the hub refuses. Offline is WARNED, never disabled:
      // work aimed at an offline computer queues until it returns.
      disabled: computer.disabledAt != null,
      mark:
        computer.disabledAt != null
          ? DISABLED_MARK
          : computer.usable === false
            ? OFFLINE_MARK
            : undefined
    }))
  ]

  return (
    <div>
      <p className="mb-1 block text-sm text-muted-foreground">Computer</p>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm">{runsOnLabel(nameFor(effectiveId))}</p>
        <Button variant="outline" size="sm" onClick={openDialog} disabled={moving}>
          Change computer…
        </Button>
      </div>
      {moveError && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {moveError}
        </p>
      )}
      {moving && moveQuery.data && (
        <div className="mt-2 space-y-2 text-sm" aria-live="polite">
          <p>
            Moving to {nameFor(moveQuery.data.destinationComputerId)} ·{' '}
            {MOVE_STEP_LABELS[moveQuery.data.step]}
          </p>
          {moveQuery.data.bytesTotal > 0 && (
            <progress
              className="w-full"
              aria-label="Workspace transfer"
              value={moveQuery.data.bytesDone}
              max={moveQuery.data.bytesTotal}
            />
          )}
          {moveQuery.data.error && (
            <p role="alert" className="text-destructive">
              {moveQuery.data.error}
            </p>
          )}
          {moveQuery.data.status === 'failed' && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void control('retry')}
                disabled={retryMove.isPending}
              >
                Retry move
              </Button>
              {moveQuery.data.step !== 'finish' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void control('cancel')}
                  disabled={cancelMove.isPending}
                >
                  Cancel move
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      <ChangeComputerDialog
        open={open}
        options={options}
        choice={choice ?? INHERIT_VALUE}
        onChoose={choose}
        choiceName={
          preview
            ? nameFor(preview.destinationComputerId)
            : nameFor(choice ?? projectDefaultComputerId)
        }
        sourceName={nameFor(preview?.sourceComputerId ?? effectiveId)}
        isCurrent={isCurrent}
        checking={checking}
        preview={preview}
        allowFresh={allowFresh}
        onAllowFresh={setAllowFresh}
        pending={saving}
        error={error}
        onClose={closeDialog}
        onConfirm={() => void confirm()}
        projectId={projectId}
        preparing={preparing}
        onChooseFolder={chooseFolder}
        onClone={cloneRepository}
      />
    </div>
  )
}
