import type { Dispatch, SetStateAction } from 'react'
import { toast } from '@slayzone/ui'
import type { CliProvider, McpServerConfig, McpTarget, SyncHealth } from '../shared'
import type { CuratedMcpServer } from '../shared/mcp-registry'
import { buildMcpConfig, type MergedServer } from './mcp-flat-helpers'

interface UseMcpSyncHandlersDeps {
  projectPath: string
  enabledProviders: CliProvider[]
  onChanged: () => void
  writableProviders: Set<McpTarget>
  mcpProviders: McpTarget[]
  customWritableProviders: McpTarget[]
  getDraftConfig: (server: MergedServer) => McpServerConfig | null
  getProviderSyncHealth: (server: MergedServer, provider: McpTarget) => SyncHealth
  loadConfigs: () => Promise<void>
  expandedKey: string | null
  setExpandedKey: (key: string | null) => void
  setDraftByServerKey: Dispatch<SetStateAction<Record<string, McpServerConfig>>>
  setSyncingServerKey: (key: string | null) => void
  setSyncingProvider: (value: { serverKey: string; provider: McpTarget } | null) => void
  setPullingProvider: (value: { serverKey: string; provider: McpTarget } | null) => void
  customKey: string
  customCommand: string
  customArgs: string
  customEnvRows: Array<{ key: string; value: string }>
  customProviders: Partial<Record<McpTarget, boolean>>
  setCustomKey: (value: string) => void
  setCustomCommand: (value: string) => void
  setCustomArgs: (value: string) => void
  setCustomEnvRows: (value: Array<{ key: string; value: string }>) => void
  setCustomProviders: (value: Partial<Record<McpTarget, boolean>>) => void
  setShowCustomDialog: (value: boolean) => void
  setAddingCustom: (value: boolean) => void
}

export function useMcpSyncHandlers(deps: UseMcpSyncHandlersDeps) {
  const {
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
  } = deps

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

  return {
    handleRemove,
    handleAddFromCatalog,
    handlePushProvider,
    handlePullProvider,
    handleSyncAllProviders,
    openCustomServerDialog,
    handleAddCustomServer
  }
}
