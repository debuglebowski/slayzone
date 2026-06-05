import { useCallback, useEffect, useState } from 'react'
import { toast } from '@slayzone/ui'
import type { SkillRegistry, SkillRegistryEntry } from '../shared'
import { useContextManagerStore } from './useContextManagerStore'

export type View = 'browse' | 'manage'
export type BrowseMode = 'registries' | 'all'

export function useSkillMarketplace(projectId: string | null, projectPath?: string | null) {
  const hasProject = !!projectId && !!projectPath
  const [view, setView] = useState<View>('browse')
  const [browseMode, setBrowseMode] = useState<BrowseMode>('registries')
  const [activeRegistryId, setActiveRegistryId] = useState<string | null>(null)
  const [entries, setEntries] = useState<SkillRegistryEntry[]>([])
  const [registries, setRegistries] = useState<SkillRegistry[]>([])
  const [search, setSearch] = useState('')
  const [selectedRegistry, setSelectedRegistry] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [installing, setInstalling] = useState<string | null>(null)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [previewEntry, setPreviewEntry] = useState<SkillRegistryEntry | null>(null)

  const loadRegistries = useCallback(async () => {
    const regs = await window.api.aiConfig.marketplace.listRegistries()
    setRegistries(regs)
  }, [refreshKey])

  const effectiveRegistryId = browseMode === 'registries' ? activeRegistryId : selectedRegistry

  const loadEntries = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await window.api.aiConfig.marketplace.listEntries({
        registryId: effectiveRegistryId ?? undefined,
        search: search || undefined,
        projectId: projectId ?? undefined
      })
      setEntries(rows)
    } finally {
      setLoading(false)
    }
  }, [effectiveRegistryId, search, refreshKey])

  useEffect(() => {
    loadRegistries()
    loadEntries()
  }, [loadRegistries, loadEntries])

  useEffect(() => {
    window.api.aiConfig.marketplace
      .ensureFresh()
      .then(() => {
        setRefreshKey((k) => k + 1)
      })
      .catch(() => {})
  }, [])

  // Handle external navigation (e.g. clicking marketplace badge in skill list)
  useEffect(() => {
    const { marketplaceDrillRegistryId: drillId } = useContextManagerStore.getState()
    if (drillId) {
      setActiveRegistryId(drillId)
      setBrowseMode('registries')
      useContextManagerStore.setState({ marketplaceDrillRegistryId: null })
    }
  }, [])

  // Open the preview dialog for a specific entry once entries finish loading.
  useEffect(() => {
    if (loading) return
    const pendingEntryId = useContextManagerStore.getState().marketplaceDrillEntryId
    if (!pendingEntryId) return
    const entry = entries.find((e) => e.id === pendingEntryId)
    if (entry) {
      setPreviewEntry(entry)
      useContextManagerStore.setState({ marketplaceDrillEntryId: null })
    }
  }, [loading, entries])

  const handleAddToLibrary = useCallback(
    async (entryId: string) => {
      setInstalling(entryId)
      try {
        await window.api.aiConfig.marketplace.installSkill({ entryId, scope: 'library' })
        toast.success('Skill added to library')
        await loadEntries()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Install failed')
      } finally {
        setInstalling(null)
      }
    },
    [loadEntries]
  )

  const handleAddToProject = useCallback(
    async (entryId: string) => {
      if (!projectId || !projectPath) return
      setInstalling(entryId)
      try {
        const item = await window.api.aiConfig.marketplace.installSkill({
          entryId,
          scope: 'project',
          projectId
        })
        try {
          await window.api.aiConfig.syncLinkedFile(projectId, projectPath, item.id)
        } catch {
          /* sync self-heals on next Sync All */
        }
        toast.success('Skill added to project')
        await loadEntries()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Install failed')
      } finally {
        setInstalling(null)
      }
    },
    [loadEntries, projectId, projectPath]
  )

  const handleUpdate = useCallback(
    async (itemId: string, entryId: string) => {
      setInstalling(entryId)
      try {
        await window.api.aiConfig.marketplace.updateSkill(itemId, entryId)
        toast.success('Skill updated')
        await loadEntries()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Update failed')
      } finally {
        setInstalling(null)
      }
    },
    [loadEntries]
  )

  const handleUninstall = useCallback(
    async (itemId: string) => {
      try {
        await window.api.aiConfig.deleteItem(itemId)
        toast.success('Skill uninstalled')
        await loadEntries()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Uninstall failed')
      }
    },
    [loadEntries]
  )

  const handleRefreshAll = useCallback(async () => {
    setRefreshingAll(true)
    try {
      await window.api.aiConfig.marketplace.refreshAll()
      await loadEntries()
      await loadRegistries()
      toast.success('Registries refreshed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setRefreshingAll(false)
    }
  }, [loadEntries, loadRegistries])

  const handleRefreshOne = useCallback(
    async (registryId: string) => {
      setRefreshingId(registryId)
      try {
        await window.api.aiConfig.marketplace.refreshRegistry(registryId)
        await loadEntries()
        await loadRegistries()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Refresh failed')
      } finally {
        setRefreshingId(null)
      }
    },
    [loadEntries, loadRegistries]
  )

  const handleToggleRegistry = useCallback(
    async (id: string, enabled: boolean) => {
      await window.api.aiConfig.marketplace.toggleRegistry(id, enabled)
      await loadRegistries()
      await loadEntries()
    },
    [loadRegistries, loadEntries]
  )

  const handleRemoveRegistry = useCallback(
    async (id: string) => {
      await window.api.aiConfig.marketplace.removeRegistry(id)
      await loadRegistries()
      await loadEntries()
    },
    [loadRegistries, loadEntries]
  )

  const handleAddRegistry = useCallback(
    async (githubUrl: string, branch?: string, path?: string) => {
      await window.api.aiConfig.marketplace.addRegistry({ githubUrl, branch, path })
      await loadRegistries()
      await loadEntries()
    },
    [loadRegistries, loadEntries]
  )

  const handleDrillIn = useCallback((registryId: string) => {
    setActiveRegistryId(registryId)
    setSearch('')
    setEntries([])
    setLoading(true)
  }, [])

  const handleDrillOut = useCallback(() => {
    setActiveRegistryId(null)
    setSearch('')
  }, [])

  const handleBrowseModeChange = useCallback((mode: BrowseMode) => {
    setBrowseMode(mode)
    setActiveRegistryId(null)
    setSearch('')
    setSelectedRegistry(null)
  }, [])

  const activeRegistry = activeRegistryId ? registries.find((r) => r.id === activeRegistryId) : null
  const isDrilledIn = browseMode === 'registries' && activeRegistry != null
  const showSkillGrid = browseMode === 'all' || activeRegistryId !== null

  return {
    hasProject,
    view,
    setView,
    browseMode,
    activeRegistryId,
    entries,
    registries,
    search,
    setSearch,
    selectedRegistry,
    setSelectedRegistry,
    loading,
    installing,
    refreshingAll,
    refreshingId,
    showAddDialog,
    setShowAddDialog,
    previewEntry,
    setPreviewEntry,
    activeRegistry,
    isDrilledIn,
    showSkillGrid,
    handleAddToLibrary,
    handleAddToProject,
    handleUpdate,
    handleUninstall,
    handleRefreshAll,
    handleRefreshOne,
    handleToggleRegistry,
    handleRemoveRegistry,
    handleAddRegistry,
    handleDrillIn,
    handleDrillOut,
    handleBrowseModeChange
  }
}
