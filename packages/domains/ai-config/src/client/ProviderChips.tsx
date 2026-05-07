import { useEffect, useState } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { cn, Switch } from '@slayzone/ui'
import type { CliProvider, CliProviderInfo } from '../shared'
import { PROVIDER_LABELS } from '../shared/provider-registry'

interface ProviderChipsProps {
  projectId: string
  layout?: 'inline' | 'panel'
  onChange?: () => void
}

export function ProviderChips({ projectId, layout = 'panel', onChange }: ProviderChipsProps) {
  const [allProviders, setAllProviders] = useState<CliProviderInfo[]>([])
  const [enabled, setEnabled] = useState<CliProvider[]>([])

  useEffect(() => {
    void (async () => {
      const [providers, projectProviders] = await Promise.all([
        getTrpcVanillaClient().aiConfig.listProviders.query(),
        getTrpcVanillaClient().aiConfig.getProjectProviders.query({ projectId })
      ])
      setAllProviders(providers.filter(p => p.status === 'active'))
      setEnabled(projectProviders)
    })()
  }, [projectId])

  const toggle = async (kind: CliProvider) => {
    const next = enabled.includes(kind)
      ? enabled.filter(p => p !== kind)
      : [...enabled, kind]
    setEnabled(next)
    await getTrpcVanillaClient().aiConfig.setProjectProviders.mutate({ projectId, providers: next })
    onChange?.()
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
