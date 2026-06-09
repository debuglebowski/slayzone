import { useEffect } from 'react'
import { useTRPC } from '@slayzone/transport/client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cn, Switch, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import type { CliProvider, CliProviderInfo } from '../shared'
import { PROVIDER_LABELS } from '../shared/provider-registry'

export function ProvidersPanel() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const providersQuery = useQuery(trpc.aiConfig.listProviders.queryOptions())
  const toggleProvider = useMutation(
    trpc.aiConfig.toggleProvider.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.aiConfig.listProviders.queryFilter())
    })
  )

  const refetchProviders = providersQuery.refetch
  useEffect(() => {
    const handler = (): void => {
      void refetchProviders()
    }
    window.addEventListener('sz:settings-changed', handler)
    return () => window.removeEventListener('sz:settings-changed', handler)
  }, [refetchProviders])

  const providers = providersQuery.data

  const handleToggle = async (provider: CliProviderInfo) => {
    if (provider.isDefault) return
    const newEnabled = !provider.enabled
    await toggleProvider.mutateAsync({ id: provider.id, enabled: newEnabled })
  }

  if (providers === undefined) return <p className="text-sm text-muted-foreground">Loading...</p>

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Enable the providers you use. Skills and instructions will sync to enabled providers.
      </p>
      {providers.map((provider) => {
        const isPlaceholder = provider.status === 'placeholder'
        return (
          <div
            key={provider.id}
            className={cn(
              'flex items-center justify-between rounded-md border bg-surface-3 px-3 py-2.5',
              isPlaceholder && 'opacity-50'
            )}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {PROVIDER_LABELS[provider.kind as CliProvider] ?? provider.name}
              </p>
              {isPlaceholder && <p className="text-[11px] text-muted-foreground">Coming soon</p>}
              {provider.isDefault && (
                <p className="text-[11px] text-muted-foreground">Default provider</p>
              )}
            </div>
            {provider.isDefault ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Switch checked disabled />
                  </span>
                </TooltipTrigger>
                <TooltipContent>Cannot disable — this is your default terminal mode</TooltipContent>
              </Tooltip>
            ) : (
              <Switch
                checked={provider.enabled}
                onCheckedChange={() => handleToggle(provider)}
                disabled={isPlaceholder}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
