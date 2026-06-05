import { ChevronDown, ChevronRight, Loader2, Plus, X } from 'lucide-react'
import { Button, cn, IconButton } from '@slayzone/ui'
import type { CliProvider } from '../shared'
import { ProviderFileCard, StatusBadge } from './SyncComponents'
import type { ContextManagerSection } from './ContextManagerSettings'
import { hasPendingProviderSync } from './sync-view-model'
import { MCP_CONFIG_PATHS, MCP_PROVIDER_ORDER, mcpConfigToDisplay } from './mcp-flat-helpers'
import { McpCatalogDialog, McpCustomServerDialog } from './mcp-flat-dialogs'
import { useMcpFlatState } from './useMcpFlatState'
import { useMcpSyncHandlers } from './mcp-sync-handlers'

interface McpFlatSectionProps {
  projectPath: string
  enabledProviders: CliProvider[]
  onOpenContextManager?: (section: ContextManagerSection) => void
  onChanged: () => void
}

export function McpFlatSection({
  projectPath,
  enabledProviders,
  onOpenContextManager,
  onChanged
}: McpFlatSectionProps) {
  const {
    loading,
    enabledServers,
    expandedKey,
    setExpandedKey,
    getServerSyncHealth,
    getSyncCoverage,
    getDraftConfig,
    getProviderSyncHealth,
    mcpProviders,
    writableProviders,
    expandedProviderRows,
    toggleProviderExpanded,
    syncingServerKey,
    syncingProvider,
    pullingProvider,
    availableCurated,
    catalogSearch,
    setCatalogSearch,
    showCatalog,
    setShowCatalog,
    showCustomDialog,
    setShowCustomDialog,
    customKey,
    setCustomKey,
    customCommand,
    setCustomCommand,
    customArgs,
    setCustomArgs,
    customEnvRows,
    setCustomEnvRows,
    customProviders,
    setCustomProviders,
    addingCustom,
    setDraftByServerKey,
    setSyncingServerKey,
    setSyncingProvider,
    setPullingProvider,
    setAddingCustom,
    loadConfigs,
    customWritableProviders
  } = useMcpFlatState({ projectPath, enabledProviders })

  const {
    handleRemove,
    handleAddFromCatalog,
    handlePushProvider,
    handlePullProvider,
    handleSyncAllProviders,
    openCustomServerDialog,
    handleAddCustomServer
  } = useMcpSyncHandlers({
    projectPath,
    enabledProviders,
    onChanged,
    writableProviders,
    mcpProviders,
    customWritableProviders,
    getDraftConfig,
    getProviderSyncHealth,
    loadConfigs,
    expandedKey,
    setExpandedKey,
    setDraftByServerKey,
    setSyncingServerKey,
    setSyncingProvider,
    setPullingProvider,
    customKey,
    customCommand,
    customArgs,
    customEnvRows,
    customProviders,
    setCustomKey,
    setCustomCommand,
    setCustomArgs,
    setCustomEnvRows,
    setCustomProviders,
    setShowCustomDialog,
    setAddingCustom
  })

  return (
    <div>
      {loading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-md border bg-muted/20" />
          ))}
        </div>
      ) : (
        <>
          {enabledServers.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
              {enabledServers.map((server) => {
                const isExpanded = expandedKey === server.key
                const syncHealth = getServerSyncHealth(server)
                const coverage = getSyncCoverage(server)
                const hasPendingProviderSyncForServer =
                  coverage.total > 0 &&
                  hasPendingProviderSync(
                    mcpProviders
                      .filter((provider) => writableProviders.has(provider))
                      .map((provider) => getProviderSyncHealth(server, provider))
                  )
                const draftConfig = getDraftConfig(server)
                const displayProviders = [...mcpProviders].sort(
                  (a, b) => MCP_PROVIDER_ORDER.indexOf(a) - MCP_PROVIDER_ORDER.indexOf(b)
                )
                const disabledDetectedProviders = server.providers
                  .filter((provider) => !mcpProviders.includes(provider))
                  .sort((a, b) => MCP_PROVIDER_ORDER.indexOf(a) - MCP_PROVIDER_ORDER.indexOf(b))

                return (
                  <div
                    key={server.key}
                    data-testid={`project-context-item-mcp-${server.key}`}
                    className={cn(
                      'rounded-md border bg-surface-3 overflow-hidden',
                      isExpanded && 'border-primary/30 col-[1/-1]'
                    )}
                  >
                    <div
                      className={cn(
                        'flex items-center gap-2 px-3 py-2 transition-colors cursor-pointer',
                        isExpanded ? 'border-b border-primary/20' : 'hover:bg-muted/30'
                      )}
                      onClick={() => setExpandedKey(isExpanded ? null : server.key)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                      )}
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
                            {server.linkedToComputer && onOpenContextManager && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                data-testid={`mcp-go-to-computer-${server.key}`}
                                onClick={() => onOpenContextManager('mcp')}
                              >
                                Go to computer
                              </Button>
                            )}
                          </div>
                          <div className="rounded-lg border bg-surface-3 p-3 space-y-2">
                            <div className="text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">Command: </span>
                              <span className="font-mono">
                                {draftConfig?.command ?? '-'} {draftConfig?.args?.join(' ') ?? ''}
                              </span>
                            </div>
                            {draftConfig?.env && Object.keys(draftConfig.env).length > 0 && (
                              <div className="text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">Env: </span>
                                {Object.entries(draftConfig.env).map(([key, value]) => (
                                  <span key={key} className="font-mono">
                                    {key}={value}{' '}
                                  </span>
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
                                {syncingServerKey === server.key && (
                                  <Loader2 className="size-3.5 animate-spin" />
                                )}
                                Database → All Files
                              </Button>
                            )}
                          </div>

                          <div className="space-y-2">
                            {displayProviders.map((provider) => {
                              const providerSyncHealth = getProviderSyncHealth(server, provider)
                              const writable = writableProviders.has(provider)
                              const configPath = MCP_CONFIG_PATHS[provider] ?? '-'
                              const diskConfig = server.providerConfigs[provider]
                              return (
                                <div
                                  key={provider}
                                  data-testid={`project-context-mcp-provider-${provider}`}
                                >
                                  <ProviderFileCard
                                    testIdPrefix="mcp"
                                    testIdSuffix={server.key}
                                    provider={provider}
                                    path={configPath}
                                    syncHealth={providerSyncHealth}
                                    isPushing={
                                      syncingProvider?.serverKey === server.key &&
                                      syncingProvider.provider === provider
                                    }
                                    isPulling={
                                      pullingProvider?.serverKey === server.key &&
                                      pullingProvider.provider === provider
                                    }
                                    isExpanded={!!expandedProviderRows[server.key]?.[provider]}
                                    syncingAll={syncingServerKey === server.key}
                                    disk={diskConfig ? mcpConfigToDisplay(diskConfig) : undefined}
                                    expected={
                                      draftConfig ? mcpConfigToDisplay(draftConfig) : undefined
                                    }
                                    rightLabel="MCP config"
                                    canPush={writable}
                                    onToggleExpand={() =>
                                      toggleProviderExpanded(server.key, provider)
                                    }
                                    onPush={() => void handlePushProvider(server, provider)}
                                    onPull={() => void handlePullProvider(server, provider)}
                                  />
                                </div>
                              )
                            })}

                            {disabledDetectedProviders.length > 0 && (
                              <div className="rounded-lg border bg-surface-3 px-3 py-2.5">
                                <p className="text-[11px] text-muted-foreground">
                                  Detected in disabled providers:{' '}
                                  <span className="font-mono">
                                    {disabledDetectedProviders.join(', ')}
                                  </span>
                                </p>
                              </div>
                            )}

                            {displayProviders.length === 0 && (
                              <p className="rounded-lg border bg-surface-3 px-3 py-4 text-center text-sm text-muted-foreground">
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
      <McpCatalogDialog
        open={showCatalog}
        onOpenChange={setShowCatalog}
        catalogSearch={catalogSearch}
        setCatalogSearch={setCatalogSearch}
        availableCurated={availableCurated}
        onAddFromCatalog={handleAddFromCatalog}
      />

      <McpCustomServerDialog
        open={showCustomDialog}
        onOpenChange={setShowCustomDialog}
        customKey={customKey}
        setCustomKey={setCustomKey}
        customCommand={customCommand}
        setCustomCommand={setCustomCommand}
        customArgs={customArgs}
        setCustomArgs={setCustomArgs}
        customEnvRows={customEnvRows}
        setCustomEnvRows={setCustomEnvRows}
        customProviders={customProviders}
        setCustomProviders={setCustomProviders}
        addingCustom={addingCustom}
        mcpProviders={mcpProviders}
        writableProviders={writableProviders}
        onAdd={handleAddCustomServer}
      />
    </div>
  )
}
