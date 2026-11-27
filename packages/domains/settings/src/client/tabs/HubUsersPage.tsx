import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Skeleton } from '@slayzone/ui'
import { useTRPC, useTRPCClient } from '../trpc'
import { HubUsersView } from './HubUsersView'

/**
 * A hub's Users tab. Mounted inside that hub's `HubScope`, so every call uses its
 * session. Admins manage accounts; anyone else sees why not. (Your own deletion
 * cleanup is on the Overview: `HubOwnCleanupStatus`.)
 */
export function HubUsersPage({ hubUrl }: { hubUrl?: string }) {
  const trpc = useTRPC(),
    client = useTRPCClient(),
    queryClient = useQueryClient()
  const [statusUserId, setStatusUserId] = useState<string | null>(null)
  const access = useQuery(trpc.hub.users.access.queryOptions())
  const canManage = access.data?.canManage === true
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
  const refreshList = () => queryClient.invalidateQueries(trpc.hub.users.list.queryFilter())
  const create = useMutation(trpc.hub.users.create.mutationOptions({ onSuccess: refreshList }))
  const disable = useMutation(trpc.hub.users.disable.mutationOptions({ onSuccess: refreshList }))
  const enable = useMutation(trpc.hub.users.enable.mutationOptions({ onSuccess: refreshList }))
  const setRole = useMutation(trpc.hub.users.setRole.mutationOptions({ onSuccess: refreshList }))
  const erase = useMutation(trpc.hub.users.eraseContent.mutationOptions())
  const retry = useMutation(trpc.hub.users.retryErasure.mutationOptions())

  if (access.isPending) return <Skeleton className="h-40 w-full" />
  if (access.isError)
    return (
      <div role="alert" className="text-sm text-destructive">
        Could not check your access to this hub.
        <Button variant="ghost" size="sm" onClick={() => void access.refetch()}>
          Retry
        </Button>
      </div>
    )
  if (!canManage)
    return (
      <p
        className="rounded-lg border px-4 py-3 text-sm text-muted-foreground"
        data-testid="hub-users-not-admin"
      >
        Only an admin of this hub can manage its accounts.
      </p>
    )
  if (users.isPending) return <Skeleton className="h-40 w-full" />
  if (users.isError)
    return (
      <div role="alert" className="text-sm text-destructive">
        Could not load users.
        <Button variant="ghost" size="sm" onClick={() => void users.refetch()}>
          Retry
        </Button>
      </div>
    )
  return (
    <HubUsersView
      users={users.data}
      selfUserId={access.data.selfUserId}
      management={access.data.management}
      hubUrl={hubUrl}
      reports={reports.data ?? []}
      reportsLoading={reports.isFetching && reports.data === undefined}
      reportsError={reports.isError}
      statusUserId={statusUserId}
      onShowReports={(userId) => {
        setStatusUserId(userId)
        if (userId) void queryClient.invalidateQueries(trpc.hub.users.erasureReports.pathFilter())
      }}
      onPreview={(userId) => client.hub.users.previewErasure.query({ userId })}
      onCreate={(input) => create.mutateAsync(input)}
      onDisable={async (email) => {
        await disable.mutateAsync({ email })
      }}
      onEnable={async (email) => {
        await enable.mutateAsync({ email })
      }}
      onSetRole={async (email, role) => {
        await setRole.mutateAsync({ email, role })
        // Your own role is part of your access: a self-demotion ends management here.
        await queryClient.invalidateQueries(trpc.hub.users.access.queryFilter())
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
  )
}
