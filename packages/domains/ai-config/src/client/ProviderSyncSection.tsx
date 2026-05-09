import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import {
  PROVIDER_LABELS,
  PROVIDER_CAPABILITIES,
} from '../shared/provider-registry'
import type { CliProvider } from '../shared'

interface ProviderSyncSectionProps {
  projectId: string | null
  projectName?: string
}

export function ProviderSyncSection({ projectId }: ProviderSyncSectionProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const { data: providers = [] } = useQuery(trpc.aiConfig.listProviders.queryOptions())
  const { data: projectProviders = [] } = useQuery(
    trpc.aiConfig.getProjectProviders.queryOptions(
      { projectId: projectId ?? '' },
      { enabled: !!projectId },
    ),
  )

  // Refetch on the legacy "settings changed" custom event so sibling tabs invalidate this view.
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listProviders.queryKey() })
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: trpc.aiConfig.getProjectProviders.queryKey({ projectId }) })
      }
    }
    window.addEventListener('sz:settings-changed', handler)
    return () => window.removeEventListener('sz:settings-changed', handler)
  }, [queryClient, trpc, projectId])

  const toggleProvider = useMutation(
    trpc.aiConfig.toggleProvider.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listProviders.queryKey() }),
    }),
  )
  const setProjectProviders = useMutation(
    trpc.aiConfig.setProjectProviders.mutationOptions({
      onMutate: ({ providers: next }) => {
        if (!projectId) return undefined
        const queryKey = trpc.aiConfig.getProjectProviders.queryKey({ projectId })
        queryClient.cancelQueries({ queryKey })
        const prev = queryClient.getQueryData<CliProvider[]>(queryKey)
        queryClient.setQueryData(queryKey, next as CliProvider[])
        return { prev }
      },
      onError: (_err, _vars, ctx) => {
        if (!projectId || !ctx) return
        queryClient.setQueryData(trpc.aiConfig.getProjectProviders.queryKey({ projectId }), ctx.prev)
      },
    }),
  )

  const handleToggleComputer = (id: string, enabled: boolean) => {
    toggleProvider.mutate({ id, enabled })
  }

  const handleToggleProject = (provider: CliProvider) => {
    if (!projectId) return
    const next = projectProviders.includes(provider)
      ? projectProviders.filter(p => p !== provider)
      : [...projectProviders, provider]
    setProjectProviders.mutate({ projectId, providers: next })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-sm font-semibold mb-1">Provider Sync</h2>
        <p className="text-xs text-muted-foreground">
          Choose which AI providers to sync instructions, skills, and MCPs to.
        </p>
      </div>

      <div className="space-y-2">
        {providers.map((provider) => {
          const caps = PROVIDER_CAPABILITIES[provider.id as CliProvider]
          const isProjectEnabled = projectProviders.includes(provider.id as CliProvider)

          return (
            <div
              key={provider.id}
              className="flex items-center gap-4 rounded-lg border bg-surface-3 p-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {PROVIDER_LABELS[provider.id as CliProvider] ?? provider.name}
                  </span>
                  <div className="flex gap-1">
                    {provider.isDefault && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Default</span>
                    )}
                    {caps?.mcpWritable && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">MCP</span>
                    )}
                    {caps?.mcpReadable && !caps?.mcpWritable && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">MCP read</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Computer toggle */}
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>Computer</span>
                {provider.isDefault ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="switch"
                        aria-checked
                        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-primary opacity-60 cursor-not-allowed"
                      >
                        <span className="pointer-events-none block size-3.5 rounded-full bg-background shadow-sm translate-x-[18px]" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Cannot disable — this is your default terminal mode</TooltipContent>
                  </Tooltip>
                ) : (
                  <button
                    role="switch"
                    aria-checked={provider.enabled}
                    onClick={() => handleToggleComputer(provider.id, !provider.enabled)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
                      provider.enabled ? 'bg-primary' : 'bg-muted'
                    )}
                  >
                    <span className={cn(
                      'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
                      provider.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    )} />
                  </button>
                )}
              </label>

              {/* Project override */}
              {projectId && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Project</span>
                  <button
                    role="switch"
                    aria-checked={isProjectEnabled}
                    disabled={!provider.enabled}
                    onClick={() => handleToggleProject(provider.id as CliProvider)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
                      isProjectEnabled ? 'bg-primary' : 'bg-muted',
                      !provider.enabled && 'opacity-40 cursor-not-allowed'
                    )}
                  >
                    <span className={cn(
                      'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
                      isProjectEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    )} />
                  </button>
                </label>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
