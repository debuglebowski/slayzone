import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFederationOrNull } from '@slayzone/transport/client'
import { Button, toast } from '@slayzone/ui'
import { useTRPC } from './trpc'

/**
 * Blockers between this task and a task on another hub (a move to another hub split
 * them): who blocks whom, and on which hub. Each hub keeps its own side, so removing
 * one here removes this hub's side only. Renders nothing when there are none.
 */
export function RemoteBlockersSection({ taskId }: { taskId: string }): React.JSX.Element | null {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const federation = useFederationOrNull()
  const { data: links } = useQuery(trpc.taskMoves.remoteBlockers.queryOptions({ taskId }))
  const remove = useMutation(trpc.taskMoves.removeRemoteBlocker.mutationOptions())
  if (!links || links.length === 0) return null
  const hubLabel = (id: string): string => federation?.hubs.find((h) => h.id === id)?.label ?? id
  return (
    <div className="flex flex-col gap-1.5" data-testid="remote-blockers">
      <label className="text-sm text-muted-foreground">On other hubs</label>
      {links.map((l) => (
        <div
          key={`${l.role}:${l.remoteHubId}:${l.remoteTaskId}`}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span className="truncate">
            {l.role === 'blocked_by' ? 'Blocked by' : 'Blocks'} “
            {l.remoteTitle ?? l.remoteTaskId.slice(0, 8)}” on {hubLabel(l.remoteHubId)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              remove
                .mutateAsync({
                  taskId,
                  role: l.role,
                  remoteHubId: l.remoteHubId,
                  remoteTaskId: l.remoteTaskId
                })
                .then(() =>
                  queryClient.invalidateQueries({
                    queryKey: trpc.taskMoves.remoteBlockers.queryKey({ taskId })
                  })
                )
                .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
            }}
          >
            Remove
          </Button>
        </div>
      ))}
    </div>
  )
}
