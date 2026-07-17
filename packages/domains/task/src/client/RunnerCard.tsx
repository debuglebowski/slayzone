import { useState, useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'

/**
 * Per-task runner selector (hub/runner split, wave 3 UI).
 *
 * Backend model (see `runners` router / store):
 *   - `tasks.runner_id`          : NULL = inherit the project default; else pinned.
 *   - `projects.default_runner_id`: NULL = local/in-process; else a runner.
 *   - `resolveTaskRunner`        : the effective (coalesced) runner — null = local.
 *
 * The task's own binding is only ever {inherit | pinned-to-runner}: `setTaskRunner`
 * takes `string | null` where null = inherit. There is no separate "explicit local"
 * for a task (a non-null id that isn't a live runner would fail exec routing rather
 * than run locally) — "local" is expressed by the inherit option resolving to Local,
 * surfaced in the option label as "Inherit project default (Local)".
 *
 * When no runners are enrolled (none enrolled — the default), everything runs
 * locally, so the card degrades to a minimal muted note instead of an inert select.
 */

const INHERIT_VALUE = '__inherit__'

interface RunnerCardProps {
  taskId: string
  /** The task's own binding — null = inherit the project default. */
  taskRunnerId: string | null
  /** The project's default runner — null = local. Labels the inherit option. */
  projectDefaultRunnerId: string | null
}

export function RunnerCard({
  taskId,
  taskRunnerId,
  projectDefaultRunnerId
}: RunnerCardProps): React.JSX.Element {
  const trpc = useTRPC()
  const runnersQuery = useQuery(trpc.runners.list.queryOptions())
  const resolvedQuery = useQuery(trpc.runners.resolveTaskRunner.queryOptions({ taskId }))
  const setTaskRunner = useMutation(trpc.runners.setTaskRunner.mutationOptions())

  const runners = runnersQuery.data ?? []

  // Local mirror of the task's binding so the select reflects the choice
  // immediately; re-sync when the task (or its persisted binding) changes.
  const [binding, setBinding] = useState<string | null>(taskRunnerId)
  useEffect(() => {
    setBinding(taskRunnerId)
  }, [taskId, taskRunnerId])

  const nameFor = (id: string | null): string => {
    if (id == null) return 'Local'
    return runners.find((r) => r.id === id)?.name ?? 'Unknown runner'
  }

  const handleChange = async (value: string): Promise<void> => {
    const runnerId = value === INHERIT_VALUE ? null : value
    setBinding(runnerId)
    await setTaskRunner.mutateAsync({ taskId, runnerId })
    await resolvedQuery.refetch()
  }

  // No runners enrolled → runs locally. Keep the card minimal (don't hide it).
  if (runners.length === 0) {
    return (
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Runner</label>
        <p className="text-sm text-muted-foreground">No runners — runs locally</p>
      </div>
    )
  }

  const effectiveId = resolvedQuery.data?.runnerId ?? null

  return (
    <div>
      <label className="mb-1 block text-sm text-muted-foreground">Runner</label>
      <Select value={binding ?? INHERIT_VALUE} onValueChange={handleChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_VALUE}>
            Inherit project default ({nameFor(projectDefaultRunnerId)})
          </SelectItem>
          {runners.map((runner) => (
            <SelectItem key={runner.id} value={runner.id}>
              {runner.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">Runs on {nameFor(effectiveId)}</p>
    </div>
  )
}
