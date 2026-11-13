import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@slayzone/ui'
import { useTRPC, useTRPCClient } from '../trpc'
import { HubUsersView } from './HubUsersView'

/** Mounted inside this hub's HubScope, so every call uses that hub's session. */
export function HubUsersSection() {
  const trpc = useTRPC(),
    client = useTRPCClient(),
    queryClient = useQueryClient()
  const [statusUserId, setStatusUserId] = useState<string | null>(null)
  const description = useQuery(trpc.hub.users.access.queryOptions())
  const canManage = description.data?.canManage === true
  const ownReports = useQuery(
    trpc.hub.erasure.reports.queryOptions(undefined, {
      enabled: description.data?.canReviewOwn === true,
      refetchInterval: (query) => (query.state.data?.length ? 2500 : 30_000)
    })
  )
  const ownRetry = useMutation(
    trpc.hub.erasure.retry.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.hub.erasure.reports.queryFilter())
    })
  )
  const users = useQuery(trpc.hub.users.list.queryOptions(undefined, { enabled: canManage }))
  const reports = useQuery(
    trpc.hub.users.erasureReports.queryOptions(
      { userId: statusUserId ?? '' },
      {
        enabled: canManage && statusUserId !== null,
        refetchInterval: (query) =>
          query.state.data?.some((report) => report.state === 'incomplete') ? 2500 : false
      }
    )
  )
  const disable = useMutation(trpc.hub.users.disable.mutationOptions())
  const erase = useMutation(trpc.hub.users.eraseContent.mutationOptions())
  const retry = useMutation(trpc.hub.users.retryErasure.mutationOptions())
  const ownStatus = ownReports.data?.length ? (
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
  ) : null
  if (!canManage) return ownStatus
  if (users.isPending) return <p className="mt-3 text-xs text-muted-foreground">Loading users…</p>
  if (users.isError)
    return (
      <div role="alert" className="mt-3 text-sm text-destructive">
        Could not load users.
        <Button variant="ghost" size="sm" onClick={() => void users.refetch()}>
          Retry
        </Button>
      </div>
    )
  return (
    <>
      {ownStatus}
      <HubUsersView
        users={users.data ?? []}
        reports={reports.data ?? []}
        reportsLoading={reports.isFetching && reports.data === undefined}
        reportsError={reports.isError}
        statusUserId={statusUserId}
        onShowReports={(userId) => {
          setStatusUserId(userId)
          void queryClient.invalidateQueries(trpc.hub.users.erasureReports.pathFilter())
        }}
        onPreview={(userId) => client.hub.users.previewErasure.query({ userId })}
        onDisable={async (email) => {
          await disable.mutateAsync({ email })
          await queryClient.invalidateQueries(trpc.hub.users.list.queryFilter())
        }}
        onErase={async (userId, confirmation) => {
          const report = await erase.mutateAsync({ userId, confirmation })
          queryClient.setQueryData(trpc.hub.users.erasureReports.queryKey({ userId }), (old) => [
            report,
            ...(old ?? []).filter((r) => r.id !== report.id)
          ])
          return report
        }}
        onRetry={async (jobId) => {
          const report = await retry.mutateAsync({ jobId })
          if (statusUserId)
            queryClient.setQueryData(
              trpc.hub.users.erasureReports.queryKey({ userId: statusUserId }),
              (old) => [report, ...(old ?? []).filter((r) => r.id !== report.id)]
            )
          return report
        }}
      />
    </>
  )
}
