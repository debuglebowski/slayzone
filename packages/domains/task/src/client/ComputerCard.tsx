import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
// The words every client shows for a computer choice (the mobile app too).
import {
  computerName,
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

interface ComputerCardProps {
  taskId: string
  /** The task's own binding — null = inherit the project default. */
  taskComputerId: string | null
  /** The project's default computer — null = local. Labels the inherit option. */
  projectDefaultComputerId: string | null
}

export function ComputerCard({
  taskId,
  taskComputerId,
  projectDefaultComputerId
}: ComputerCardProps): React.JSX.Element {
  const trpc = useTRPC()
  const computersQuery = useQuery(trpc.computers.list.queryOptions())
  const resolvedQuery = useQuery(trpc.computers.resolveTaskComputer.queryOptions({ taskId }))
  const setTaskComputer = useMutation(trpc.computers.setTaskComputer.mutationOptions())

  const computers = computersQuery.data ?? []

  // Local mirror of the task's binding so the select reflects the choice
  // immediately; re-sync when the task (or its persisted binding) changes.
  // Re-synced while rendering (not in an effect) so no commit shows a stale binding.
  const [binding, setBinding] = useState<string | null>(taskComputerId)
  const [syncedFrom, setSyncedFrom] = useState({ taskId, taskComputerId })
  if (syncedFrom.taskId !== taskId || syncedFrom.taskComputerId !== taskComputerId) {
    setSyncedFrom({ taskId, taskComputerId })
    setBinding(taskComputerId)
  }

  const nameFor = (id: string | null): string => computerName(computers, id)

  const handleChange = async (value: string): Promise<void> => {
    const computerId = value === INHERIT_VALUE ? null : value
    setBinding(computerId)
    await setTaskComputer.mutateAsync({ taskId, computerId }).catch((err: unknown) => {
      // The save failed, so the server still holds the persisted binding: show it again.
      setBinding(taskComputerId)
      throw err
    })
    await resolvedQuery.refetch()
  }

  // No computers enrolled → runs locally. Keep the card minimal (don't hide it).
  if (computers.length === 0) {
    return (
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Computer</label>
        <p className="text-sm text-muted-foreground">{NO_COMPUTERS_NOTE}</p>
      </div>
    )
  }

  const effectiveId = resolvedQuery.data?.computerId ?? null

  return (
    <div>
      <label className="mb-1 block text-sm text-muted-foreground">Computer</label>
      <Select value={binding ?? INHERIT_VALUE} onValueChange={handleChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_VALUE}>
            {inheritComputerLabel(nameFor(projectDefaultComputerId))}
          </SelectItem>
          {computers.map((computer) => (
            <SelectItem key={computer.id} value={computer.id}>
              {/* Offline is WARNED, never disabled: work aimed at an offline
                  computer queues until it returns, and binding a project to a
                  sleeping laptop is the normal case — disabling the option would
                  contradict the semantics. */}
              {computer.name}
              {computer.usable === false ? (
                <span className="text-muted-foreground ml-1.5 text-xs">{OFFLINE_MARK}</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">{runsOnLabel(nameFor(effectiveId))}</p>
    </div>
  )
}
