import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { CliProvider, McpConfigFileResult, McpServerConfig, McpTarget } from '../../shared'
import { CURATED_MCP_SERVERS } from '../../shared/mcp-registry'
import { ALL_PROVIDERS, loadCustomServers, matchesSearch } from './mcp-helpers'
import type { CustomMcpServer, EditTarget, MergedServer } from './types'

export function useProjectMcpServers(projectPath: string, projectId: string) {
  const trpcClient = useTRPCClient()
  const [enabledProviders, setEnabledProviders] = useState<CliProvider[]>([])
  const [configs, setConfigs] = useState<McpConfigFileResult[]>([])
  const [customServers, setCustomServers] = useState<CustomMcpServer[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [editProviders, setEditProviders] = useState<McpTarget[]>([])

  const loadConfigs = useCallback(async () => {
    setLoading(true)
    try {
      const [results, custom, providers] = await Promise.all([
        trpcClient.aiConfig.discoverMcpConfigs.query({ projectPath }),
        loadCustomServers(trpcClient),
        trpcClient.aiConfig.getProjectProviders.query({ projectId })
      ])
      setConfigs(results)
      setCustomServers(custom)
      setEnabledProviders(providers)
    } finally {
      setLoading(false)
    }
  }, [trpcClient, projectPath, projectId])

  useEffect(() => {
    void loadConfigs()
  }, [loadConfigs])

  const enabledMcpTargets = useMemo(
    () => ALL_PROVIDERS.filter((p) => enabledProviders.includes(p)),
    [enabledProviders]
  )

  useEffect(() => {
    void trpcClient.settings.get.query({ key: 'mcp_favorites' }).then((raw) => {
      if (raw) setFavorites(JSON.parse(raw) as string[])
    })
  }, [trpcClient])

  const writableProviders = useMemo(
    () => new Set(configs.filter((cfg) => cfg.writable).map((cfg) => cfg.provider)),
    [configs]
  )

  const toggleFavorite = async (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id]
    setFavorites(next)
    await trpcClient.settings.set.mutate({ key: 'mcp_favorites', value: JSON.stringify(next) })
  }

  const isFavorite = (id: string) => favorites.includes(id)

  // Merge configs into unified server list: curated → custom computer → discovered
  const merged: MergedServer[] = []
  const seen = new Set<string>()

  for (const curated of CURATED_MCP_SERVERS) {
    const providers: McpTarget[] = []
    let foundConfig: McpServerConfig | null = null
    for (const cfg of configs) {
      if (cfg.servers[curated.id]) {
        providers.push(cfg.provider)
        if (!foundConfig) foundConfig = cfg.servers[curated.id]
      }
    }
    merged.push({ key: curated.id, curated, custom: null, config: foundConfig, providers })
    seen.add(curated.id)
  }

  for (const cs of customServers) {
    if (seen.has(cs.id)) continue
    const providers: McpTarget[] = []
    let foundConfig: McpServerConfig | null = null
    for (const cfg of configs) {
      if (cfg.servers[cs.id]) {
        providers.push(cfg.provider)
        if (!foundConfig) foundConfig = cfg.servers[cs.id]
      }
    }
    merged.push({
      key: cs.id,
      curated: null,
      custom: cs,
      config: foundConfig ?? cs.config,
      providers
    })
    seen.add(cs.id)
  }

  for (const cfg of configs) {
    for (const [key, config] of Object.entries(cfg.servers)) {
      if (seen.has(key)) continue
      const existing = merged.find((m) => m.key === key)
      if (existing) {
        existing.providers.push(cfg.provider)
      } else {
        merged.push({ key, curated: null, custom: null, config, providers: [cfg.provider] })
        seen.add(key)
      }
    }
  }

  const enableServer = async (server: MergedServer) => {
    const config = server.curated
      ? { ...server.curated.template }
      : server.custom
        ? { ...server.custom.config }
        : server.config
    if (!config) return
    for (const provider of enabledMcpTargets) {
      if (server.providers.includes(provider)) continue
      await trpcClient.aiConfig.writeMcpServer.mutate({
        projectPath,
        provider,
        serverKey: server.key,
        config
      })
    }
    await loadConfigs()
  }

  const disableServer = async (server: MergedServer) => {
    for (const provider of server.providers) {
      if (!writableProviders.has(provider)) continue
      await trpcClient.aiConfig.removeMcpServer.mutate({
        projectPath,
        provider,
        serverKey: server.key
      })
    }
    await loadConfigs()
  }

  const editServer = (s: MergedServer) => {
    const config = s.custom?.config ?? s.config
    if (!config) return
    setEditTarget({
      originalKey: s.key,
      server: {
        id: s.key,
        name: s.custom?.name ?? s.key,
        description: s.custom?.description,
        config
      }
    })
    setEditProviders([...s.providers])
    setAddDialogOpen(true)
  }

  const isEnabled = (server: MergedServer) => server.providers.length > 0

  const serverName = (s: MergedServer) => s.curated?.name ?? s.custom?.name ?? s.key

  const filterServer = (s: MergedServer) =>
    matchesSearch(search, serverName(s), s.curated?.description, s.curated?.category)

  const enabledServers = merged
    .filter((s) => isEnabled(s) && filterServer(s))
    .sort((a, b) => serverName(a).localeCompare(serverName(b)))
  const availableServers = merged.filter(
    (m) => !isEnabled(m) && (m.curated || m.custom) && filterServer(m)
  )

  return {
    loading,
    search,
    setSearch,
    addDialogOpen,
    setAddDialogOpen,
    editTarget,
    setEditTarget,
    editProviders,
    setEditProviders,
    enabledMcpTargets,
    loadConfigs,
    toggleFavorite,
    isFavorite,
    enableServer,
    disableServer,
    editServer,
    isEnabled,
    serverName,
    enabledServers,
    availableServers
  }
}
