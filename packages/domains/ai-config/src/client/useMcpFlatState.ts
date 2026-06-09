import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type {
  CliProvider,
  McpConfigFileResult,
  McpServerConfig,
  McpTarget,
  SyncHealth
} from '../shared'
import { CURATED_MCP_SERVERS } from '../shared/mcp-registry'
import {
  MCP_CONFIG_PATHS,
  buildMergedServers,
  mcpConfigsEqual,
  parseComputerCustomServerIds,
  type MergedServer
} from './mcp-flat-helpers'

interface UseMcpFlatStateArgs {
  projectPath: string
  enabledProviders: CliProvider[]
}

export function useMcpFlatState({ projectPath, enabledProviders }: UseMcpFlatStateArgs) {
  const trpcClient = useTRPCClient()
  const [configs, setConfigs] = useState<McpConfigFileResult[]>([])
  const [computerCustomServerIds, setComputerCustomServerIds] = useState<Set<string>>(new Set())
  const [draftByServerKey, setDraftByServerKey] = useState<Record<string, McpServerConfig>>({})
  const [expandedProviderRows, setExpandedProviderRows] = useState<
    Record<string, Partial<Record<McpTarget, boolean>>>
  >({})
  const [loading, setLoading] = useState(true)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [showCatalog, setShowCatalog] = useState(false)
  const [showCustomDialog, setShowCustomDialog] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')
  const [syncingServerKey, setSyncingServerKey] = useState<string | null>(null)
  const [syncingProvider, setSyncingProvider] = useState<{
    serverKey: string
    provider: McpTarget
  } | null>(null)
  const [pullingProvider, setPullingProvider] = useState<{
    serverKey: string
    provider: McpTarget
  } | null>(null)
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
        trpcClient.aiConfig.discoverMcpConfigs.query({ projectPath }),
        trpcClient.settings.get.query({ key: 'mcp_custom_servers' })
      ])
      setConfigs(results)
      setComputerCustomServerIds(parseComputerCustomServerIds(customServersRaw))
    } finally {
      setLoading(false)
    }
  }, [trpcClient, projectPath])

  useEffect(() => {
    void loadConfigs()
  }, [loadConfigs])

  // Track which providers support writes
  const writableProviders = new Set(configs.filter((c) => c.writable).map((c) => c.provider))

  // Build merged server list from discovered configs
  const { merged, seen } = buildMergedServers(configs, computerCustomServerIds)

  const enabledServers = merged.filter((s) => s.providers.length > 0)

  const availableCurated = CURATED_MCP_SERVERS.filter((c) => !seen.has(c.id))
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
    const linkedEnabled = writableEnabled.filter(
      (provider) => getProviderSyncHealth(server, provider) === 'synced'
    )
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

  return {
    // raw state
    configs,
    computerCustomServerIds,
    draftByServerKey,
    setDraftByServerKey,
    expandedProviderRows,
    loading,
    expandedKey,
    setExpandedKey,
    showCatalog,
    setShowCatalog,
    showCustomDialog,
    setShowCustomDialog,
    catalogSearch,
    setCatalogSearch,
    syncingServerKey,
    setSyncingServerKey,
    syncingProvider,
    setSyncingProvider,
    pullingProvider,
    setPullingProvider,
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
    setAddingCustom,
    // loader
    loadConfigs,
    // derived
    writableProviders,
    enabledServers,
    availableCurated,
    mcpProviders,
    customWritableProviders,
    // helpers
    getDraftConfig,
    getProviderSyncHealth,
    getServerSyncHealth,
    getSyncCoverage,
    toggleProviderExpanded
  }
}
