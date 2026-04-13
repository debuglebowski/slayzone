import { useCallback, useEffect, useState } from 'react'
import { cn } from '@slayzone/ui'
import {
  PROVIDER_LABELS,
  PROVIDER_CAPABILITIES,
} from '../shared/provider-registry'
import type { CliProvider, CliProviderInfo } from '../shared'

interface ProviderSyncSectionProps {
  projectId: string | null
  projectName?: string
}

export function ProviderSyncSection({ projectId }: ProviderSyncSectionProps) {
  const [providers, setProviders] = useState<CliProviderInfo[]>([])
  const [projectProviders, setProjectProviders] = useState<CliProvider[]>([])

  useEffect(() => {
    let stale = false
    void (async () => {
      const list = await window.api.aiConfig.listProviders()
      if (!stale) setProviders(list)
      if (projectId) {
        const pp = await window.api.aiConfig.getProjectProviders(projectId)
        if (!stale) setProjectProviders(pp)
      }
    })()
    return () => { stale = true }
  }, [projectId])

  const handleToggleComputer = useCallback(async (id: string, enabled: boolean) => {
    await window.api.aiConfig.toggleProvider(id, enabled)
    setProviders(prev => prev.map(p => p.id === id ? { ...p, enabled } : p))
  }, [])

  const handleToggleProject = useCallback(async (provider: CliProvider) => {
    if (!projectId) return
    const next = projectProviders.includes(provider)
      ? projectProviders.filter(p => p !== provider)
      : [...projectProviders, provider]
    await window.api.aiConfig.setProjectProviders(projectId, next)
    setProjectProviders(next)
  }, [projectId, projectProviders])

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
