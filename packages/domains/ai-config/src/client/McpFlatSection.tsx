import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Plus, Server, X, Search } from 'lucide-react'
import { Button, cn, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, IconButton, Input, Label, toast } from '@slayzone/ui'
import type { CliProvider, McpConfigFileResult, McpServerConfig, McpTarget, SyncHealth } from '../shared'
import { CURATED_MCP_SERVERS, type CuratedMcpServer } from '../shared/mcp-registry'
import { ProviderFileCard, StatusBadge } from './SyncComponents'
import type { GlobalContextManagerSection } from './ContextManagerSettings'
import { hasPendingProviderSync } from './sync-view-model'

const MCP_CONFIG_PATHS: Partial<Record<McpTarget, string>> = {
  claude: '.mcp.json',
  cursor: '.cursor/mcp.json',
  gemini: '.gemini/settings.json',
  opencode: 'opencode.json',
  copilot: '.copilot/mcp-config.json',
}

interface MergedServer {
  key: string
  name: string
  description?: string
  config: McpServerConfig | null
  providerConfigs: Partial<Record<McpTarget, McpServerConfig>>
  curated: CuratedMcpServer | null
  linkedToGlobal: boolean
  providers: McpTarget[]
}

interface McpFlatSectionProps {
  projectPath: string
  enabledProviders: CliProvider[]
  onOpenGlobalAiConfig?: (section: GlobalContextManagerSection) => void
  onChanged: () => void
}

const MCP_PROVIDER_ORDER: McpTarget[] = ['claude', 'cursor', 'gemini', 'opencode', 'copilot']

function normalizeMcpConfig(config: McpServerConfig): { command: string; args: string[]; env: Record<string, string> } {
  const envEntries = Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return {
    command: config.command,
    args: [...(config.args ?? [])],
    env: Object.fromEntries(envEntries)
  }
}

function mcpConfigsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(normalizeMcpConfig(a)) === JSON.stringify(normalizeMcpConfig(b))
}

function mcpConfigToDisplay(config: McpServerConfig): string {
  return JSON.stringify(normalizeMcpConfig(config), null, 2)
}

function buildMcpConfig(command: string, args: string, envRows: Array<{ key: string; value: string }>): McpServerConfig {
  const config: McpServerConfig = {
    command: command.trim(),
    args: args.trim() ? args.trim().split(/\s+/) : []
  }
  const env = Object.fromEntries(
    envRows
      .map((row) => ({ key: row.key.trim(), value: row.value }))
      .filter((row) => row.key.length > 0)
      .map((row) => [row.key, row.value])
  )
  if (Object.keys(env).length > 0) config.env = env
  return config
}

function parseGlobalCustomServerIds(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const ids = parsed
      .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    return new Set(ids)
  } catch {
    return new Set()
  }
}

export function McpFlatSection({ projectPath, enabledProviders, onOpenGlobalAiConfig, onChanged }: McpFlatSectionProps) {
  const [configs, setConfigs] = useState<McpConfigFileResult[]>([])
  const [globalCustomServerIds, setGlobalCustomServerIds] = useState<Set<string>>(new Set())
  const [draftByServerKey, setDraftByServerKey] = useState<Record<string, McpServerConfig>>({})
  const [expandedProviderRows, setExpandedProviderRows] = useState<Record<string, Partial<Record<McpTarget, boolean>>>>({})
  const [loading, setLoading] = useState(true)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [showCatalog, setShowCatalog] = useState(false)
  const [showCustomDialog, setShowCustomDialog] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')
  const [syncingServerKey, setSyncingServerKey] = useState<string | null>(null)
  const [syncingProvider, setSyncingProvider] = useState<{ serverKey: string; provider: McpTarget } | null>(null)
  const [pullingProvider, setPullingProvider] = useState<{ serverKey: string; provider: McpTarget } | null>(null)
  const [customKey, setCustomKey] = useState('')
  const [customCommand, setCustomCommand] = useState('')
  const [customArgs, setCustomArgs] = useState('')
  const [customEnvRows, setCustomEnvRows] = useState<Array<{ key: string; value: string }>>([])
  const [customProviders, setCustomProviders] = useState<Partial<Record<McpTarget, boolean>>>({})
  const [addingCustom, setAddingCustom] = useState(false)

  const loadConfigs = useCallback(async () => {
    setLoading(true)
    try {
      const [results, customServersRaw] = await Promise.all([
        window.api.aiConfig.discoverMcpConfigs(projectPath),
        window.api.settings.get('mcp_custom_servers')
      ])
      setConfigs(results)
      setGlobalCustomServerIds(parseGlobalCustomServerIds(customServersRaw))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => { void loadConfigs() }, [loadConfigs])

  // Track which providers support writes
  const writableProviders = new Set(configs.filter(c => c.writable).map(c => c.provider))

  // Build merged server list from discovered configs
  const merged: MergedServer[] = []
  const seen = new Set<string>()

  for (const cfg of configs) {
    for (const [key, config] of Object.entries(cfg.servers)) {
      if (!seen.has(key)) {
        const curated = CURATED_MCP_SERVERS.find(c => c.id === key) ?? null
        merged.push({
          key,
          name: curated?.name ?? key,
          description: curated?.description,
          config,
          providerConfigs: { [cfg.provider]: config },
          curated,
          linkedToGlobal: curated !== null || globalCustomServerIds.has(key),
          providers: [cfg.provider]
        })
        seen.add(key)
      } else {
        const existing = merged.find(m => m.key === key)
        if (existing) {
          existing.providers.push(cfg.provider)
          existing.providerConfigs[cfg.provider] = config
        }
      }
    }
  }

  const enabledServers = merged.filter(s => s.providers.length > 0)

  const handleRemove = async (server: MergedServer) => {
    try {
      let removed = 0
      for (const provider of server.providers) {
        if (!writableProviders.has(provider)) continue
        await window.api.aiConfig.removeMcpServer({ projectPath, provider, serverKey: server.key })
        removed += 1
      }
      if (expandedKey === server.key) setExpandedKey(null)
      await loadConfigs()
      onChanged()
      if (removed > 0) {
        toast.success(`Removed ${server.name} from ${removed} provider${removed === 1 ? '' : 's'}`)
      } else {
        toast.error('No writable MCP configs available for removal')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'MCP removal failed')
    }
  }

  const handleAddFromCatalog = async (curated: CuratedMcpServer) => {
    try {
      let synced = 0
      for (const provider of enabledProviders) {
        if (!writableProviders.has(provider)) continue
        await window.api.aiConfig.writeMcpServer({
          projectPath,
          provider,
          serverKey: curated.id,
          config: { ...curated.template }
        })
        synced += 1
      }
      await loadConfigs()
      onChanged()
      if (synced > 0) {
        toast.success(`Synced ${curated.name} to ${synced} provider${synced === 1 ? '' : 's'}`)
      } else {
        toast.error('No writable providers enabled for MCP sync')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'MCP sync failed')
    }
  }

  const availableCurated = CURATED_MCP_SERVERS.filter(c => !seen.has(c.id))
  const mcpProviders = enabledProviders.filter((provider): provider is McpTarget =>
    Object.prototype.hasOwnProperty.call(MCP_CONFIG_PATHS, provider)
  )
  const customWritableProviders = mcpProviders.filter((provider) => writableProviders.has(provider))

  const getDraftConfig = (server: MergedServer): McpServerConfig | null => {
    return draftByServerKey[server.key] ?? server.config ?? server.curated?.template ?? null
  }

  const getProviderSyncHealth = (server: MergedServer, provider: McpTarget): SyncHealth => {
    const expected = getDraftConfig(server)
    const disk = server.providerConfigs[provider]
    if (!expected || !disk) return 'not_synced'
    return mcpConfigsEqual(disk, expected) ? 'synced' : 'stale'
  }

  const getServerSyncHealth = (server: MergedServer): SyncHealth => {
    const writableEnabled = mcpProviders.filter((provider) => writableProviders.has(provider))
    if (writableEnabled.length === 0) return 'not_synced'
    const providerHealth = writableEnabled.map((provider) => getProviderSyncHealth(server, provider))
    if (providerHealth.every((health) => health === 'synced')) return 'synced'
    if (providerHealth.every((health) => health === 'not_synced')) return 'not_synced'
    return 'stale'
  }

  const getSyncCoverage = (server: MergedServer): { linked: number; total: number } => {
    const writableEnabled = mcpProviders.filter((provider) => writableProviders.has(provider))
    const linkedEnabled = writableEnabled.filter((provider) => getProviderSyncHealth(server, provider) === 'synced')
    return { linked: linkedEnabled.length, total: writableEnabled.length }
  }

  const toggleProviderExpanded = (serverKey: string, provider: McpTarget) => {
    setExpandedProviderRows((prev) => ({
      ...prev,
      [serverKey]: {
        ...(prev[serverKey] ?? {}),
        [provider]: !(prev[serverKey]?.[provider] ?? false)
      }
    }))
  }

  const handlePushProvider = async (server: MergedServer, provider: McpTarget) => {
    const config = getDraftConfig(server)
    if (!config) return
    if (!writableProviders.has(provider)) {
      toast.error(`${provider} MCP config is read-only`)
      return
    }
    setSyncingProvider({ serverKey: server.key, provider })
    try {
      await window.api.aiConfig.writeMcpServer({
        projectPath,
        provider,
        serverKey: server.key,
        config
      })
      await loadConfigs()
      onChanged()
      toast.success(`Synced ${server.name} to ${provider}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'MCP sync failed')
    } finally {
      setSyncingProvider(null)
    }
  }

  const handlePullProvider = async (server: MergedServer, provider: McpTarget) => {
    const diskConfig = server.providerConfigs[provider]
    if (!diskConfig) return
    setPullingProvider({ serverKey: server.key, provider })
    try {
      setDraftByServerKey((prev) => ({ ...prev, [server.key]: { ...diskConfig } }))
      toast.success(`Loaded ${provider} config for ${server.name}`)
    } finally {
      setPullingProvider(null)
    }
  }

  const handleSyncAllProviders = async (server: MergedServer) => {
    const config = getDraftConfig(server)
    if (!config) {
      toast.error(`No template available for ${server.name}`)
      return
    }
    setSyncingServerKey(server.key)
    try {
      let synced = 0
      for (const provider of mcpProviders) {
        if (!writableProviders.has(provider)) continue
        if (getProviderSyncHealth(server, provider) === 'synced') continue
        await window.api.aiConfig.writeMcpServer({
          projectPath,
          provider,
          serverKey: server.key,
          config
        })
        synced += 1
      }
      await loadConfigs()
      onChanged()
      if (synced > 0) {
        toast.success(`Synced ${server.name} to ${synced} provider${synced === 1 ? '' : 's'}`)
      } else {
        toast.success(`${server.name} is already synced to writable providers`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'MCP sync failed')
    } finally {
      setSyncingServerKey(null)
    }
  }

  const openCustomServerDialog = () => {
    const defaults: Partial<Record<McpTarget, boolean>> = {}
    for (const provider of customWritableProviders) defaults[provider] = true
    setCustomProviders(defaults)
    setCustomKey('')
    setCustomCommand('')
    setCustomArgs('')
    setCustomEnvRows([])
    setShowCustomDialog(true)
  }

  const handleAddCustomServer = async () => {
    if (!customKey.trim() || !customCommand.trim()) return
    setAddingCustom(true)
    try {
      const config = buildMcpConfig(customCommand, customArgs, customEnvRows)
      let written = 0
      for (const provider of mcpProviders) {
        if (!customProviders[provider]) continue
        if (!writableProviders.has(provider)) continue
        await window.api.aiConfig.writeMcpServer({
          projectPath,
          provider,
          serverKey: customKey.trim(),
          config
        })
        written += 1
      }
      await loadConfigs()
      onChanged()
      if (written > 0) {
        setShowCustomDialog(false)
        toast.success(`Added ${customKey.trim()} to ${written} provider${written === 1 ? '' : 's'}`)
      } else {
        toast.error('No writable providers selected')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Adding MCP server failed')
    } finally {
      setAddingCustom(false)
    }
  }

  return (
    <div>
      {loading ? (
        <div className="space-y-2">
          {[1, 2].map(i => (
            <div key={i} className="h-16 animate-pulse rounded-md border bg-muted/20" />
          ))}
        </div>
      ) : (
        <>
          {enabledServers.length > 0 && (
            <div className="space-y-2">
              {enabledServers.map(server => {
                const isExpanded = expandedKey === server.key
                const syncHealth = getServerSyncHealth(server)
                const coverage = getSyncCoverage(server)
                const hasPendingProviderSyncForServer = coverage.total > 0 && hasPendingProviderSync(
                  mcpProviders
                    .filter((provider) => writableProviders.has(provider))
                    .map((provider) => getProviderSyncHealth(server, provider))
                )
                const draftConfig = getDraftConfig(server)
                const displayProviders = [...mcpProviders].sort((a, b) => MCP_PROVIDER_ORDER.indexOf(a) - MCP_PROVIDER_ORDER.indexOf(b))
                const disabledDetectedProviders = server.providers
                  .filter((provider) => !mcpProviders.includes(provider))
                  .sort((a, b) => MCP_PROVIDER_ORDER.indexOf(a) - MCP_PROVIDER_ORDER.indexOf(b))

                return (
                  <div
                    key={server.key}
                    data-testid={`project-context-item-mcp-${server.key}`}
                  className={cn(
                      'rounded-md border overflow-hidden',
                      isExpanded && 'border-primary/30'
                    )}
                  >
                    <div
                      className={cn(
                        'flex items-center gap-2 px-3 py-2 transition-colors cursor-pointer',
                        isExpanded ? 'border-b border-primary/20' : 'hover:bg-muted/30'
                      )}
                      onClick={() => setExpandedKey(isExpanded ? null : server.key)}
                    >
                      {isExpanded
                        ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                        : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                      }
                      <span className="flex-1 truncate font-mono text-xs">{server.name}</span>
                      <StatusBadge syncHealth={syncHealth} />
                      <IconButton
                        aria-label="Remove server"
                        size="icon-sm"
                        variant="ghost"
                        className="size-6 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleRemove(server)
                        }}
                      >
                        <X className="size-3" />
                      </IconButton>
                    </div>

                    {isExpanded && (
                      <div className="p-4 space-y-3">
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-lg font-semibold leading-tight">Edit</p>
                            {server.linkedToGlobal && onOpenGlobalAiConfig && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                data-testid={`mcp-go-to-global-${server.key}`}
                                onClick={() => onOpenGlobalAiConfig('mcp')}
                              >
                                Go to global
                              </Button>
                            )}
                          </div>
                          <div className="rounded-lg border bg-surface-1 p-3 space-y-2">
                            <div className="text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">Command: </span>
                              <span className="font-mono">{draftConfig?.command ?? '-'} {draftConfig?.args?.join(' ') ?? ''}</span>
                            </div>
                            {draftConfig?.env && Object.keys(draftConfig.env).length > 0 && (
                              <div className="text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">Env: </span>
                                {Object.entries(draftConfig.env).map(([key, value]) => (
                                  <span key={key} className="font-mono">{key}={value} </span>
                                ))}
                              </div>
                            )}
                            {server.description && (
                              <p className="text-xs text-muted-foreground">{server.description}</p>
                            )}
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <p className="text-lg font-semibold leading-tight">Sync</p>
                              {syncHealth === 'stale' && (
                                <span className="inline-flex size-2 rounded-full bg-amber-500" />
                              )}
                            </div>
                            {hasPendingProviderSyncForServer && (
                              <Button
                                size="sm"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => void handleSyncAllProviders(server)}
                                disabled={syncingServerKey === server.key}
                                data-testid={`mcp-sync-all-${server.key}`}
                              >
                                {syncingServerKey === server.key && <Loader2 className="size-3.5 animate-spin" />}
                                Config → All Files
                              </Button>
                            )}
                          </div>

                          <div className="space-y-2">
                            {displayProviders.map(provider => {
                              const providerSyncHealth = getProviderSyncHealth(server, provider)
                              const writable = writableProviders.has(provider)
                              const configPath = MCP_CONFIG_PATHS[provider] ?? '-'
                              const diskConfig = server.providerConfigs[provider]
                              return (
                                <div key={provider} data-testid={`project-context-mcp-provider-${provider}`}>
                                  <ProviderFileCard
                                    testIdPrefix="mcp"
                                    testIdSuffix={server.key}
                                    provider={provider}
                                    path={configPath}
                                    syncHealth={providerSyncHealth}
                                    isPushing={syncingProvider?.serverKey === server.key && syncingProvider.provider === provider}
                                    isPulling={pullingProvider?.serverKey === server.key && pullingProvider.provider === provider}
                                    isExpanded={!!expandedProviderRows[server.key]?.[provider]}
                                    syncingAll={syncingServerKey === server.key}
                                    disk={diskConfig ? mcpConfigToDisplay(diskConfig) : undefined}
                                    expected={draftConfig ? mcpConfigToDisplay(draftConfig) : undefined}
                                    rightLabel="MCP config"
                                    canPush={writable}
                                    onToggleExpand={() => toggleProviderExpanded(server.key, provider)}
                                    onPush={() => void handlePushProvider(server, provider)}
                                    onPull={() => void handlePullProvider(server, provider)}
                                  />
                                </div>
                              )
                            })}

                            {disabledDetectedProviders.length > 0 && (
                              <div className="rounded-lg border bg-surface-1 px-3 py-2.5">
                                <p className="text-[11px] text-muted-foreground">
                                  Detected in disabled providers:
                                  {' '}
                                  <span className="font-mono">{disabledDetectedProviders.join(', ')}</span>
                                </p>
                              </div>
                            )}

                            {displayProviders.length === 0 && (
                              <p className="rounded-lg border bg-surface-1 px-3 py-4 text-center text-sm text-muted-foreground">
                                No MCP-capable providers enabled for this project.
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {enabledServers.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
              No MCP servers configured yet.
            </p>
          )}

          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div
              className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 cursor-pointer text-muted-foreground transition-colors hover:bg-muted/15 hover:text-foreground"
              onClick={() => setShowCatalog(true)}
            >
              <Plus className="size-3 shrink-0" />
              <span className="text-xs">Add MCP server</span>
            </div>
            <div
              className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 cursor-pointer text-muted-foreground transition-colors hover:bg-muted/15 hover:text-foreground"
              onClick={openCustomServerDialog}
            >
              <Plus className="size-3 shrink-0" />
              <span className="text-xs">Add custom server</span>
            </div>
          </div>
        </>
      )}

      {/* Add MCP dialog */}
      <Dialog open={showCatalog} onOpenChange={setShowCatalog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add MCP Server</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search servers..."
              className="pl-8 h-8 text-xs"
              value={catalogSearch}
              onChange={e => setCatalogSearch(e.target.value)}
            />
          </div>
          <div className="max-h-[300px] overflow-y-auto space-y-1">
            {availableCurated
              .filter(c => !catalogSearch || c.name.toLowerCase().includes(catalogSearch.toLowerCase()) || c.description?.toLowerCase().includes(catalogSearch.toLowerCase()))
              .map(c => (
                <button
                  key={c.id}
                  onClick={async () => {
                    await handleAddFromCatalog(c)
                    setShowCatalog(false)
                    setCatalogSearch('')
                  }}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/50"
                >
                  <Server className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <div className="text-xs font-medium">{c.name}</div>
                    {c.description && <div className="text-[11px] text-muted-foreground">{c.description}</div>}
                  </div>
                </button>
              ))}
            {availableCurated.filter(c => !catalogSearch || c.name.toLowerCase().includes(catalogSearch.toLowerCase())).length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">No servers found</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showCustomDialog} onOpenChange={setShowCustomDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Custom MCP Server</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Server key</Label>
              <Input
                value={customKey}
                onChange={(event) => setCustomKey(event.target.value)}
                placeholder="my-server"
                className="h-8 text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Command</Label>
                <Input
                  value={customCommand}
                  onChange={(event) => setCustomCommand(event.target.value)}
                  placeholder="npx"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Args</Label>
                <Input
                  value={customArgs}
                  onChange={(event) => setCustomArgs(event.target.value)}
                  placeholder="-y @foo/bar"
                  className="h-8 text-xs"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Environment variables</Label>
              {customEnvRows.map((row, index) => (
                <div key={`${index}-${row.key}`} className="grid grid-cols-[1fr_1fr_32px] gap-2">
                  <Input
                    value={row.key}
                    onChange={(event) => {
                      const next = [...customEnvRows]
                      next[index] = { ...next[index], key: event.target.value }
                      setCustomEnvRows(next)
                    }}
                    placeholder="KEY"
                    className="h-8 text-xs font-mono"
                  />
                  <Input
                    value={row.value}
                    onChange={(event) => {
                      const next = [...customEnvRows]
                      next[index] = { ...next[index], value: event.target.value }
                      setCustomEnvRows(next)
                    }}
                    placeholder="value"
                    className="h-8 text-xs"
                  />
                  <IconButton
                    aria-label="Remove variable"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setCustomEnvRows(customEnvRows.filter((_, i) => i !== index))}
                  >
                    <X className="size-3.5" />
                  </IconButton>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setCustomEnvRows([...customEnvRows, { key: '', value: '' }])}
              >
                <Plus className="mr-1 size-3" />
                Add variable
              </Button>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Write to providers</Label>
              {mcpProviders.length === 0 ? (
                <p className="text-xs text-muted-foreground">No MCP-capable providers enabled for this project.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  {mcpProviders.map((provider) => {
                    const writable = writableProviders.has(provider)
                    return (
                      <label key={provider} className={cn('flex items-center gap-1.5 text-xs', writable ? 'cursor-pointer' : 'opacity-60')}>
                        <input
                          type="checkbox"
                          checked={writable ? !!customProviders[provider] : false}
                          disabled={!writable}
                          onChange={(event) => setCustomProviders((prev) => ({ ...prev, [provider]: event.target.checked }))}
                        />
                        {provider}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCustomDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleAddCustomServer()}
              disabled={
                addingCustom ||
                !customKey.trim() ||
                !customCommand.trim() ||
                !mcpProviders.some((provider) => writableProviders.has(provider) && customProviders[provider])
              }
            >
              {addingCustom ? 'Adding...' : 'Add server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
