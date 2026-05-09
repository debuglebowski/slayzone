import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { cn, Switch } from '@slayzone/ui'
import type { CliProvider } from '../shared'
import { PROVIDER_LABELS } from '../shared/provider-registry'

interface ProviderChipsProps {
  projectId: string
  layout?: 'inline' | 'panel'
  onChange?: () => void
}

export function ProviderChips({ projectId, layout = 'panel', onChange }: ProviderChipsProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const { data: providers = [] } = useQuery(trpc.aiConfig.listProviders.queryOptions())
  const { data: enabled = [] } = useQuery(trpc.aiConfig.getProjectProviders.queryOptions({ projectId }))
  const allProviders = providers.filter(p => p.status === 'active')

  const setProjectProviders = useMutation(
    trpc.aiConfig.setProjectProviders.mutationOptions({
      onMutate: ({ providers: next }) => {
        const queryKey = trpc.aiConfig.getProjectProviders.queryKey({ projectId })
        queryClient.cancelQueries({ queryKey })
        const prev = queryClient.getQueryData<CliProvider[]>(queryKey)
        queryClient.setQueryData(queryKey, next as CliProvider[])
        return { prev }
      },
      onError: (_err, _vars, ctx) => {
        if (!ctx) return
        queryClient.setQueryData(trpc.aiConfig.getProjectProviders.queryKey({ projectId }), ctx.prev)
      },
      onSuccess: () => onChange?.(),
    }),
  )

  const toggle = (kind: CliProvider) => {
    const next = enabled.includes(kind)
      ? enabled.filter(p => p !== kind)
      : [...enabled, kind]
    setProjectProviders.mutate({ projectId, providers: next })
  }

  if (allProviders.length === 0) return null

  if (layout === 'inline') {
    return (
      <div className="flex items-center gap-1.5">
        {allProviders.map(provider => {
          const active = enabled.includes(provider.kind as CliProvider)
          return (
            <button
              key={provider.id}
              onClick={() => toggle(provider.kind as CliProvider)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
              )}
            >
              {PROVIDER_LABELS[provider.kind as CliProvider] ?? provider.name}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {allProviders.map(provider => {
        const active = enabled.includes(provider.kind as CliProvider)
        return (
          <div
            key={provider.id}
            className="flex items-center justify-between rounded-md border bg-surface-3 px-3 py-2.5"
          >
            <p className="text-sm font-medium">
              {PROVIDER_LABELS[provider.kind as CliProvider] ?? provider.name}
            </p>
            <Switch
              checked={active}
              onCheckedChange={() => toggle(provider.kind as CliProvider)}
            />
          </div>
        )
      })}
    </div>
  )
}
