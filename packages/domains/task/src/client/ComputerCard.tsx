import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from './trpc'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import type { ComputerMove, ComputerMovePreview } from '@slayzone/task-contracts'
import { ComputerMoveDialog } from './ComputerMoveDialog'
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
  taskComputerId,
  projectDefaultComputerId,
  computers
}: ComputerCardProps & {
  computers: Array<{ id: string; name: string; disabledAt?: number | null; usable?: boolean }>
}): React.JSX.Element {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const selectId = useId()
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
  const [candidate, setCandidate] = useState<{
    computerId: string | null
    preview: ComputerMovePreview
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [allowFresh, setAllowFresh] = useState(false)
  const moving = moveQuery.data?.status === 'running' || moveQuery.data?.status === 'failed'

  // Local mirror of the task's binding so the select reflects the choice
  // immediately; re-sync when the task (or its persisted binding) changes.
  // Re-synced while rendering (not in an effect) so no commit shows a stale binding.
  const [binding, setBinding] = useState<string | null>(taskComputerId)
  const [syncedFrom, setSyncedFrom] = useState({ taskId, taskComputerId })
  if (syncedFrom.taskId !== taskId || syncedFrom.taskComputerId !== taskComputerId) {
    setSyncedFrom({ taskId, taskComputerId })
    setBinding(taskComputerId)
    if (syncedFrom.taskId !== taskId) {
      setCandidate(null)
      setError(null)
      setChecking(false)
      setAllowFresh(false)
    }
  }

  const nameFor = (id: string | null): string => computerName(computers, id)

  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  const handleChange = async (value: string): Promise<void> => {
    const computerId = value === INHERIT_VALUE ? null : value
    setError(null)
    setChecking(true)
    const switchComputer = async (): Promise<void> => {
      const preview = await client.task.computerMovePreview.query({ taskId, computerId })
      if (currentTask.current !== taskId) return
      if (preview.requiresMigration || !preview.ready) {
        setAllowFresh(false)
        setCandidate({ computerId, preview })
        return
      }
      setBinding(computerId)
      await setTaskComputer.mutateAsync({ taskId, computerId })
      await resolvedQuery.refetch()
    }
    await switchComputer()
      .catch((err: unknown) => {
        if (currentTask.current !== taskId) return
        setBinding(taskComputerId)
        setError(messageOf(err))
      })
      .then(() => {
        if (currentTask.current === taskId) setChecking(false)
      })
  }
  const confirm = async () => {
    if (!candidate) return
    setError(null)
    const start = async (): Promise<void> => {
      await beginMove.mutateAsync({
        taskId,
        computerId: candidate.computerId,
        allowFreshSessions: allowFresh
      })
      if (currentTask.current !== taskId) return
      setCandidate(null)
      await moveQuery.refetch()
    }
    await start().catch((err: unknown) => {
      if (currentTask.current === taskId) setError(messageOf(err))
    })
  }
  const control = async (action: 'retry' | 'cancel') => {
    setError(null)
    const mutation = action === 'retry' ? retryMove : cancelMove
    const run = async (): Promise<void> => {
      await mutation.mutateAsync({ taskId })
      await moveQuery.refetch()
      await resolvedQuery.refetch()
    }
    await run().catch((err: unknown) => setError(messageOf(err)))
  }

  const effectiveId = resolvedQuery.data?.computerId ?? null

  return (
    <div>
      <label htmlFor={selectId} className="mb-1 block text-sm text-muted-foreground">
        Computer
      </label>
      <Select
        value={binding ?? INHERIT_VALUE}
        onValueChange={handleChange}
        disabled={checking || moving}
      >
        <SelectTrigger id={selectId} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_VALUE}>
            {inheritComputerLabel(nameFor(projectDefaultComputerId))}
          </SelectItem>
          {computers.map((computer) => (
            <SelectItem
              key={computer.id}
              value={computer.id}
              // A DISABLED computer (Settings → Connections) takes no new work, so
              // nothing new may be bound to it; the hub refuses.
              disabled={computer.disabledAt != null}
            >
              {/* Offline is WARNED, never disabled: work aimed at an offline
                  computer queues until it returns, and binding a project to a
                  sleeping laptop is the normal case — disabling the option would
                  contradict the semantics. */}
              {computer.name}
              {computer.disabledAt != null ? (
                <span className="text-muted-foreground ml-1.5 text-xs">{DISABLED_MARK}</span>
              ) : computer.usable === false ? (
                <span className="text-muted-foreground ml-1.5 text-xs">{OFFLINE_MARK}</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">{runsOnLabel(nameFor(effectiveId))}</p>
      {checking && <p className="mt-1 text-xs text-muted-foreground">Checking destination…</p>}
      {error && !candidate && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
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
      <ComputerMoveDialog
        preview={candidate?.preview ?? null}
        source={nameFor(candidate?.preview.sourceComputerId ?? null)}
        destination={nameFor(candidate?.preview.destinationComputerId ?? null)}
        allowFresh={allowFresh}
        onAllowFresh={setAllowFresh}
        pending={beginMove.isPending}
        error={error}
        onClose={() => {
          setCandidate(null)
          setError(null)
        }}
        onConfirm={() => void confirm()}
      />
    </div>
  )
}
