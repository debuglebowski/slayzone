import { useState, useEffect } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { ArrowDownToLineIcon, ArrowUpToLineIcon, Loader2 } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { ExternalLink, TaskSyncStatus } from '@slayzone/integrations/shared'
import { Button } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { toast } from '@slayzone/ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'

interface ExternalSyncCardProps {
  taskId: string
  onUpdate: (task: Task) => void
}

const PROVIDER_LABELS: Record<ExternalLink['provider'], string> = {
  linear: 'Linear',
  github: 'GitHub',
  jira: 'Jira'
}

const SYNC_STATE_META: Record<TaskSyncStatus['state'], { label: string; className: string }> = {
  in_sync: { label: 'In sync', className: 'bg-emerald-500/15 text-emerald-300' },
  local_ahead: { label: 'Local ahead', className: 'bg-blue-500/15 text-blue-300' },
  remote_ahead: { label: 'Remote ahead', className: 'bg-amber-500/15 text-amber-300' },
  conflict: { label: 'Conflict', className: 'bg-red-500/15 text-red-300' },
  unknown: { label: 'Unknown', className: 'bg-muted text-muted-foreground' }
}

function toUnknownSyncStatus(link: ExternalLink, taskId: string): TaskSyncStatus {
  return {
    provider: link.provider,
    taskId,
    state: 'unknown',
    fields: [],
    comparedAt: new Date().toISOString()
  }
}

export function ExternalSyncCard({ taskId, onUpdate }: ExternalSyncCardProps) {
  const trpcClient = useTRPCClient()
  const [links, setLinks] = useState<ExternalLink[]>([])
  const [syncStatusByLinkId, setSyncStatusByLinkId] = useState<Record<string, TaskSyncStatus>>({})
  const [linkLoadingById, setLinkLoadingById] = useState<
    Record<string, 'open' | 'pull' | 'push' | undefined>
  >({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [linearLink, githubLink] = await Promise.all([
          trpcClient.integrations.getLink.query({ taskId, provider: 'linear' }),
          trpcClient.integrations.getLink.query({ taskId, provider: 'github' })
        ])

        const loadedLinks = [linearLink, githubLink].filter((link): link is ExternalLink =>
          Boolean(link)
        )
        if (cancelled) return
        setLinks(loadedLinks)

        if (loadedLinks.length === 0) {
          setSyncStatusByLinkId({})
          return
        }

        const statusEntries = await Promise.all(
          loadedLinks.map(async (link) => {
            try {
              const status = await trpcClient.integrations.getTaskSyncStatus.query({
                taskId,
                provider: link.provider
              })
              return [link.id, status] as const
            } catch {
              return [link.id, toUnknownSyncStatus(link, taskId)] as const
            }
          })
        )

        if (cancelled) return
        setSyncStatusByLinkId(Object.fromEntries(statusEntries))
      } catch {
        if (cancelled) return
        setLinks([])
        setSyncStatusByLinkId({})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [taskId, trpcClient])

  const refreshLinkSyncStatus = async (link: ExternalLink) => {
    try {
      const status = await trpcClient.integrations.getTaskSyncStatus.query({
        taskId,
        provider: link.provider
      })
      setSyncStatusByLinkId((current) => ({ ...current, [link.id]: status }))
    } catch {
      setSyncStatusByLinkId((current) => ({
        ...current,
        [link.id]: toUnknownSyncStatus(link, taskId)
      }))
    }
  }

  const setLinkLoading = (linkId: string, action: 'open' | 'pull' | 'push' | null) => {
    setLinkLoadingById((current) => {
      const next = { ...current }
      if (action === null) {
        delete next[linkId]
      } else {
        next[linkId] = action
      }
      return next
    })
  }

  const handleOpen = async (link: ExternalLink) => {
    if (!link.external_url) return
    setLinkLoading(link.id, 'open')
    try {
      await trpcClient.app.shell.openExternal.mutate({ url: link.external_url })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      await refreshLinkSyncStatus(link)
      setLinkLoading(link.id, null)
    }
  }

  const handlePull = async (link: ExternalLink) => {
    setLinkLoading(link.id, 'pull')
    try {
      if (link.provider === 'linear') {
        const result = await trpcClient.integrations.syncNow.mutate({ taskId })
        const errSuffix = result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''
        const message = `${PROVIDER_LABELS[link.provider]} synced: ${result.pulled} pulled, ${result.pushed} pushed${errSuffix}`
        if (result.errors.length > 0) toast.error(message)
        else toast.success(message)
        const refreshedTask = await trpcClient.task.get.query({ id: taskId })
        if (refreshedTask) onUpdate(refreshedTask)
        return
      }

      const result = await trpcClient.integrations.pullTask.mutate({
        taskId,
        provider: 'github'
      })
      const message =
        result.message ??
        (result.pulled ? 'Pulled remote changes from GitHub' : 'No pull performed')
      if (result.pulled) toast.success(message)
      else toast(message)
      if (result.pulled) {
        const refreshedTask = await trpcClient.task.get.query({ id: taskId })
        if (refreshedTask) onUpdate(refreshedTask)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      await refreshLinkSyncStatus(link)
      setLinkLoading(link.id, null)
    }
  }

  const handlePush = async (link: ExternalLink) => {
    setLinkLoading(link.id, 'push')
    try {
      if (link.provider === 'linear') {
        const result = await trpcClient.integrations.syncNow.mutate({ taskId })
        const errSuffix = result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''
        const message = `${PROVIDER_LABELS[link.provider]} synced: ${result.pulled} pulled, ${result.pushed} pushed${errSuffix}`
        if (result.pushed > 0) toast.success(message)
        else if (result.errors.length > 0) toast.error(message)
        else toast(message)
        if (result.pulled > 0) {
          const refreshedTask = await trpcClient.task.get.query({ id: taskId })
          if (refreshedTask) onUpdate(refreshedTask)
        }
        return
      }

      const result = await trpcClient.integrations.pushTask.mutate({
        taskId,
        provider: 'github'
      })
      const message =
        result.message ?? (result.pushed ? 'Pushed local changes to GitHub' : 'No push performed')
      if (result.pushed) toast.success(message)
      else toast(message)
      if (result.pushed) {
        const refreshedTask = await trpcClient.task.get.query({ id: taskId })
        if (refreshedTask) onUpdate(refreshedTask)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLinkLoading(link.id, null)
    }
  }

  if (links.length === 0) return null

  return (
    <div className="space-y-2">
      {links.map((link) => {
        const loadingAction = linkLoadingById[link.id]
        const linkBusy = Boolean(loadingAction)
        const syncStatus = syncStatusByLinkId[link.id]
        return (
          <div
            key={link.id}
            role={link.external_url && !linkBusy ? 'link' : undefined}
            tabIndex={link.external_url && !linkBusy ? 0 : -1}
            className={cn(
              'flex items-center gap-1.5 rounded-md border border-border bg-muted/25 px-2 py-1.5',
              link.external_url && !linkBusy ? 'cursor-pointer hover:bg-muted/60' : 'cursor-default'
            )}
            onClick={() => void handleOpen(link)}
            onKeyDown={(event) => {
              if (!link.external_url || linkBusy) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                void handleOpen(link)
              }
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2" title={link.external_key}>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {PROVIDER_LABELS[link.provider]}
              </span>
              {loadingAction === 'open' ? (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              ) : null}
              <span className="truncate text-xs text-muted-foreground">{link.external_key}</span>
              {syncStatus ? (
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                    SYNC_STATE_META[syncStatus.state].className
                  )}
                >
                  {SYNC_STATE_META[syncStatus.state].label}
                </span>
              ) : null}
            </div>

            <div className="ml-auto flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Pull from external issue"
                    className="size-7"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handlePull(link)
                    }}
                    disabled={linkBusy}
                  >
                    {loadingAction === 'pull' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowDownToLineIcon className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Pull</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Push to external issue"
                    className="size-7"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handlePush(link)
                    }}
                    disabled={linkBusy}
                  >
                    {loadingAction === 'push' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowUpToLineIcon className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Push</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function LinearCard(props: ExternalSyncCardProps) {
  return <ExternalSyncCard {...props} />
}
