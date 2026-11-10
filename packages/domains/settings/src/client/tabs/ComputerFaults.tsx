import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import type { ItemFaultView } from '@slayzone/computers/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  toast
} from '@slayzone/ui'
import { useTRPC } from '../trpc'

/** What each pass is, in the user's words. Unknown passes show their name. */
const PASS_LABELS: Record<string, string> = {
  'chat-archive': 'Restored chat archive cannot be read',
  'chat-archive-index': 'Restored chat archive cannot be checked',
  'chat-archive-erasure': 'Restored chat archive not erased yet',
  'artifact-file-journal': 'Unfinished file save cannot be read',
  'hook-journal': 'Agent event journal was damaged (readable events kept)',
  'hook-event-rejected': 'Agent event refused by the hub',
  'computer-generations': 'Computer startup file was damaged',
  'computer-host-config': 'Computer startup settings were damaged',
  'computer.task-file-cleanup': 'Deleted task’s files not removed yet',
  'computer.chat-retention': 'Old chat history not pruned yet',
  'computer.chat-inventory': 'Chat cannot be read on this computer',
  'chat-backup-rotation': 'Old chat backup not removed yet',
  'hub-backup': 'Backup cannot be read',
  'hub-backup-pins': 'Backup files not protected yet',
  'hub-backup-rotation': 'Old backup not removed yet',
  'hub-erasure-fanout': 'Task not erased on this computer yet',
  'hub-session-refresh': 'Session list entry cannot be read',
  'hub-legacy-diagnostics-cleanup': 'Old diagnostics not cleaned yet',
  'hub-legacy-chat-migration': 'Old chat not moved to this computer yet',
  'hub-project-sync': 'Project folder not set on this computer yet',
  'hub-project-forget': 'Project folder not cleared on this computer yet'
}

const label = (fault: ItemFaultView) => PASS_LABELS[fault.pass] ?? fault.pass

/**
 * "Needs attention" (decision 6): items a pass on this computer — or, with
 * `computerId: null`, on the hub itself — could not process. Each failed alone;
 * everything else kept working. Retry runs it again; Discard permanently deletes
 * it after a confirmation. Renders nothing when there is nothing to show (or the
 * caller may not see this scope).
 */
export function ComputerFaults({
  computerId,
  title = 'Needs attention'
}: {
  computerId: string | null
  title?: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [discarding, setDiscarding] = useState<ItemFaultView | null>(null)
  const faultsQuery = useQuery({
    ...trpc.computers.listFaults.queryOptions({ computerId }),
    refetchInterval: 30_000,
    retry: false
  })
  const refresh = () => {
    void queryClient.invalidateQueries(trpc.computers.listFaults.queryFilter())
    void queryClient.invalidateQueries(trpc.computers.faultedTasks.queryFilter())
  }
  const retryMutation = useMutation(trpc.computers.retryFault.mutationOptions())
  const discardMutation = useMutation(trpc.computers.discardFault.mutationOptions())
  const faults = faultsQuery.data ?? []
  if (!faults.length) return null

  const refOf = (fault: ItemFaultView) => ({
    computerId: fault.computerId,
    origin: fault.origin,
    source: fault.source,
    pass: fault.pass,
    key: fault.key
  })
  const retry = (fault: ItemFaultView) =>
    retryMutation
      .mutateAsync(refOf(fault))
      .then(
        () => toast.success('Retrying'),
        (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))
      )
      .finally(refresh)
  const discard = (fault: ItemFaultView) =>
    discardMutation
      .mutateAsync(refOf(fault))
      .then(
        () => toast.success('Deleted'),
        (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))
      )
      .finally(refresh)

  return (
    <div className="mt-1" data-testid="computer-faults">
      <button
        type="button"
        className="text-warning-foreground flex items-center gap-1 text-xs"
        onClick={() => setOpen((v) => !v)}
        data-testid="computer-faults-toggle"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <TriangleAlert className="text-warning size-3" />
        {title} ({faults.length})
      </button>
      {open && (
        <ul className="border-warning/30 mt-1 space-y-1 border-l pl-3">
          {faults.map((fault) => (
            <li
              key={`${fault.origin}:${fault.source}:${fault.pass}:${fault.key}`}
              className="flex items-start gap-2 text-xs"
              data-testid="computer-fault"
            >
              <div className="min-w-0 flex-1">
                <div className="text-foreground truncate">{label(fault)}</div>
                <div className="text-muted-foreground truncate" title={fault.message}>
                  {fault.message}
                  {fault.attempts > 1 ? ` · ${fault.attempts} attempts` : ''}
                  {fault.taskId ? ` · task ${fault.taskId.slice(0, 8)}` : ''}
                </div>
              </div>
              {fault.retryable && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => void retry(fault)}
                  data-testid="computer-fault-retry"
                >
                  Retry
                </Button>
              )}
              {fault.discardable && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive h-6 px-2 text-xs"
                  onClick={() => setDiscarding(fault)}
                  data-testid="computer-fault-discard"
                >
                  Discard
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={!!discarding} onOpenChange={(next) => !next && setDiscarding(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this item permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              {discarding ? label(discarding) : ''}. Its data is deleted for good and cannot be
              recovered. Everything else is unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (discarding) void discard(discarding)
                setDiscarding(null)
              }}
              data-testid="computer-fault-discard-confirm"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
