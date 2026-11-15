import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, toast } from '@slayzone/ui'
import type {
  ComputerChatStorageJob,
  ComputerChatStoragePhase,
  ComputerChatStorageState,
  ComputerChatStorageStatus
} from '@slayzone/terminal-contracts'
import { useTRPC } from '../trpc'

const MB = 1024 * 1024
const GB = 1024 * MB
const size = (bytes: number) =>
  bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${(bytes / MB).toFixed(1)} MB`
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const RUNNING: ReadonlySet<ComputerChatStoragePhase> = new Set([
  'copying',
  'catching-up',
  'swapping',
  'reclaiming'
])
const PHASE_LABEL: Record<ComputerChatStoragePhase, string> = {
  copying: 'Copying chat history',
  'catching-up': 'Catching up with new messages',
  swapping: 'Switching to the compacted file',
  reclaiming: 'Returning free space',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped'
}
const running = (status: ComputerChatStorageStatus | undefined) =>
  !!status?.supported && !!status.job && RUNNING.has(status.job.phase)

/**
 * A computer's chat store on disk and its compaction (fu-2): sizes, the one-time
 * rebuild (or an incremental reclaim) when worth it, progress while it runs.
 */
export function ComputerChatStorage({ computerId }: { computerId: string }) {
  const trpc = useTRPC(),
    client = useQueryClient(),
    target = { computerId }
  const status = useQuery(
    trpc.chat.storage.status.queryOptions(target, {
      retry: false,
      // Polled only while a job runs: progress, then its result.
      refetchInterval: (query) => (running(query.state.data) ? 1000 : false)
    })
  )
  const compact = useMutation(trpc.chat.storage.compact.mutationOptions()),
    cancel = useMutation(trpc.chat.storage.cancel.mutationOptions())
  const refresh = () => client.invalidateQueries(trpc.chat.storage.status.queryFilter(target))
  const act = (action: () => Promise<unknown>) =>
    void action()
      .then(refresh)
      .catch((error: unknown) => toast.error(errorMessage(error)))

  const data = status.data
  return (
    <div className="space-y-2 rounded border p-3 text-sm">
      <p className="font-medium">Chat storage</p>
      {status.error && (
        <p role="alert" className="text-destructive">
          {status.error.message}
        </p>
      )}
      {data && !data.supported && (
        <p className="text-muted-foreground">Update this computer to reclaim its chat storage.</p>
      )}
      {data?.supported && (
        <StorageDetails
          state={data}
          starting={compact.isPending}
          cancelling={cancel.isPending}
          onCompact={() => act(() => compact.mutateAsync(target))}
          onCancel={() => act(() => cancel.mutateAsync(target))}
        />
      )}
    </div>
  )
}

function StorageDetails({
  state,
  starting,
  cancelling,
  onCompact,
  onCancel
}: {
  state: ComputerChatStorageState
  starting: boolean
  cancelling: boolean
  onCompact(): void
  onCancel(): void
}) {
  const job = state.job
  const active = !!job && RUNNING.has(job.phase)
  const rebuild = state.autoVacuum !== 'incremental'
  const diskShort = rebuild && state.freeDiskBytes < state.requiredDiskBytes
  const blocked = rebuild && (!state.backfillDone || diskShort)
  return (
    <>
      <p className="text-muted-foreground">
        Chat history uses {size(state.fileBytes)} on disk, {size(state.reclaimableBytes)} of it free
        space.
        {state.autoVacuum === 'incremental' &&
          ' Freed space is returned in small steps from now on.'}
      </p>
      {active && job && <RunningJob job={job} cancelling={cancelling} onCancel={onCancel} />}
      {!active && job && <JobOutcome job={job} />}
      {!active &&
        (state.worthIt ? (
          <div className="space-y-2">
            {rebuild && !state.backfillDone && (
              <p className="text-muted-foreground">
                The image backfill is still moving screenshots out of chat history; reclaim when it
                finishes.
              </p>
            )}
            {diskShort && (
              <p className="text-muted-foreground">
                Needs {size(state.requiredDiskBytes)} free on the computer's disk;{' '}
                {size(state.freeDiskBytes)} available.
              </p>
            )}
            <Button variant="outline" disabled={blocked || starting} onClick={onCompact}>
              Reclaim {size(state.reclaimableBytes)}
            </Button>
            {rebuild && (
              <p className="text-xs text-muted-foreground">
                Runs in the background; agents keep working. The first time copies the chat history
                once, which can take a few minutes.
              </p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">Nothing worth reclaiming.</p>
        ))}
      {!job && state.last && (
        <p className="text-xs text-muted-foreground">
          Last compacted {new Date(state.last.at).toLocaleString()}: {size(state.last.beforeBytes)}{' '}
          → {size(state.last.afterBytes)}.
        </p>
      )}
    </>
  )
}

function RunningJob({
  job,
  cancelling,
  onCancel
}: {
  job: ComputerChatStorageJob
  cancelling: boolean
  onCancel(): void
}) {
  const percent = Math.round(job.progress * 100)
  return (
    <div className="space-y-2">
      <p>
        {PHASE_LABEL[job.phase]}
        {job.automatic ? ' (automatic)' : ''} · {percent}%
      </p>
      <div
        role="progressbar"
        aria-label="Chat storage compaction"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded bg-muted"
      >
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      {job.message && <p className="text-xs text-muted-foreground">{job.message}</p>}
      <Button variant="outline" size="sm" disabled={cancelling} onClick={onCancel}>
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </Button>
    </div>
  )
}

function JobOutcome({ job }: { job: ComputerChatStorageJob }) {
  if (job.phase === 'done' && job.result)
    return (
      <p>
        Reclaimed {size(job.result.reclaimedBytes)} ({size(job.result.beforeBytes)} →{' '}
        {size(job.result.afterBytes)}).
      </p>
    )
  if (job.phase === 'failed')
    return (
      <p role="alert" className="text-destructive">
        {job.message ?? 'Compaction failed'}
      </p>
    )
  if (job.phase === 'cancelled')
    return <p className="text-muted-foreground">Stopped: {job.message ?? 'cancelled'}.</p>
  return null
}
