import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@slayzone/ui'
import { useTRPC } from '../trpc'

/**
 * The caller's own pending deletion cleanup on this hub (what they deleted, still
 * being removed from computers), with a retry. Nothing when none is pending.
 * Mounted inside this hub's HubScope, so every call uses that hub's session.
 */
export function HubOwnCleanupStatus() {
  const trpc = useTRPC(),
    queryClient = useQueryClient()
  const access = useQuery(trpc.hub.users.access.queryOptions())
  const ownReports = useQuery(
    trpc.hub.erasure.reports.queryOptions(undefined, {
      enabled: access.data?.canReviewOwn === true,
      refetchInterval: (query) => (query.state.data?.length ? 2500 : 30_000)
    })
  )
  const ownRetry = useMutation(
    trpc.hub.erasure.retry.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.hub.erasure.reports.queryFilter())
    })
  )
  if (!ownReports.data?.length) return null
  return (
    <section
      aria-label="Deletion cleanup"
      className="mt-3 space-y-2 border-t border-border pt-3 text-sm"
    >
      <h3 className="font-medium">Deletion cleanup</h3>
      {ownReports.data.map((report) => (
        <div key={report.id}>
          <p>Some data has not been deleted yet.</p>
          {report.computers
            .filter((c) => !c.deleted)
            .map((c) => (
              <p key={c.id}>
                Data on <strong>{c.name}</strong> has not been deleted yet.
              </p>
            ))}
          {report.failures.length ? (
            <p className="text-destructive">
              {report.failures.includes('WORKTREE_COMPUTER_GONE')
                ? 'A worktree is on a computer that was removed or revoked. It will not be retried; an operator must confirm its removal locally.'
                : 'Cleanup could not finish. It will retry automatically.'}
            </p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={ownRetry.isPending}
            onClick={() => ownRetry.mutate({ jobId: report.id })}
          >
            Retry cleanup
          </Button>
        </div>
      ))}
      {ownRetry.isError ? (
        <p role="alert" className="text-destructive">
          Could not retry cleanup.
        </p>
      ) : null}
    </section>
  )
}
