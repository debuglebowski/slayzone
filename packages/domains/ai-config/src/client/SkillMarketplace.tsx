import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink, Plus, RefreshCw, Search, Settings2 } from 'lucide-react'
import { Button, Input, cn, toast } from '@slayzone/ui'
import type { SkillRegistry, SkillRegistryEntry } from '../shared'
import { SkillEntryCard } from './SkillEntryCard'
import { SkillPreviewDialog } from './SkillPreviewDialog'
import { AddRegistryDialog } from './AddRegistryDialog'
import { RegistryManageSection } from './RegistryManageSection'
import { useContextManagerStore } from './useContextManagerStore'

type View = 'browse' | 'manage'
type BrowseMode = 'registries' | 'all'

interface SkillMarketplaceProps {
  projectId: string | null
  projectPath?: string | null
}

export function SkillMarketplace({ projectId, projectPath }: SkillMarketplaceProps) {
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
    window.api.aiConfig.marketplace.ensureFresh().then(() => {
      setRefreshKey(k => k + 1)
    }).catch(() => {})
  }, [])

  // Handle external navigation (e.g. clicking marketplace badge in skill list)
  useEffect(() => {
    const drillId = useContextManagerStore.getState().marketplaceDrillRegistryId
    if (drillId) {
      setActiveRegistryId(drillId)
      setBrowseMode('registries')
      useContextManagerStore.setState({ marketplaceDrillRegistryId: null })
    }
  }, [])

  const handleAddToLibrary = useCallback(async (entryId: string) => {
    setInstalling(entryId)
    try {
      await window.api.aiConfig.marketplace.installSkill({ entryId, scope: 'global' })
      toast.success('Skill added to library')
      await loadEntries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Install failed')
    } finally {
      setInstalling(null)
    }
  }, [loadEntries])

  const handleAddToProject = useCallback(async (entryId: string) => {
    if (!projectId) return
    setInstalling(entryId)
    try {
      await window.api.aiConfig.marketplace.installSkill({ entryId, scope: 'project', projectId })
      toast.success('Skill added to project')
      await loadEntries()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Install failed')
    } finally {
      setInstalling(null)
    }
  }, [loadEntries, projectId])

  const handleUpdate = useCallback(async (itemId: string, entryId: string) => {
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
  }, [loadEntries])

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

  const handleRefreshOne = useCallback(async (registryId: string) => {
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
  }, [loadEntries, loadRegistries])

  const handleToggleRegistry = useCallback(async (id: string, enabled: boolean) => {
    await window.api.aiConfig.marketplace.toggleRegistry(id, enabled)
    await loadRegistries()
    await loadEntries()
  }, [loadRegistries, loadEntries])

  const handleRemoveRegistry = useCallback(async (id: string) => {
    await window.api.aiConfig.marketplace.removeRegistry(id)
    await loadRegistries()
    await loadEntries()
  }, [loadRegistries, loadEntries])

  const handleAddRegistry = useCallback(async (githubUrl: string, branch?: string, path?: string) => {
    await window.api.aiConfig.marketplace.addRegistry({ githubUrl, branch, path })
    await loadRegistries()
    await loadEntries()
  }, [loadRegistries, loadEntries])

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

  const activeRegistry = activeRegistryId ? registries.find(r => r.id === activeRegistryId) : null
  const isDrilledIn = browseMode === 'registries' && activeRegistry != null
  const showSkillGrid = browseMode === 'all' || activeRegistryId !== null

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header — self-rendered, different for drill-in vs list */}
      <div className="shrink-0 flex items-center justify-between">
        {isDrilledIn ? (
          <>
            {/* Drill-in: back + name + link */}
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={handleDrillOut}
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <ArrowLeft className="size-4" />
              </button>
              <h2 className="text-lg font-semibold truncate">{activeRegistry.name}</h2>
              {activeRegistry.github_owner && (
                <a
                  href={`https://github.com/${activeRegistry.github_owner}/${activeRegistry.github_repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
                >
                  <ExternalLink className="size-3" />
                  {activeRegistry.github_owner}/{activeRegistry.github_repo}
                </a>
              )}
            </div>
            {/* Drill-in: search */}
            <div className="relative w-64 shrink-0">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search skills..."
                className="pl-8 h-8 text-xs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </>
        ) : (
          <>
            {/* List: title */}
            <h2 className="text-lg font-semibold">Marketplace</h2>
            {/* List: actions */}
            <div className="flex items-center gap-2">
              <div className="flex rounded-md border border-border/50 overflow-hidden">
                <button
                  className={cn(
                    'px-2.5 py-1 text-[11px] transition-colors',
                    browseMode === 'registries'
                      ? 'bg-foreground text-background'
                      : 'bg-background text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => handleBrowseModeChange('registries')}
                >
                  Registries
                </button>
                <button
                  className={cn(
                    'px-2.5 py-1 text-[11px] transition-colors',
                    browseMode === 'all'
                      ? 'bg-foreground text-background'
                      : 'bg-background text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => handleBrowseModeChange('all')}
                >
                  Show all
                </button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={handleRefreshAll}
                disabled={refreshingAll}
              >
                <RefreshCw className={cn('size-3', refreshingAll && 'animate-spin')} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="size-3" />
                Add Repo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 text-xs gap-1.5', view === 'manage' && 'bg-surface-3')}
                onClick={() => setView(view === 'manage' ? 'browse' : 'manage')}
              >
                <Settings2 className="size-3" />
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Body */}
      {view === 'manage' ? (
        <RegistryManageSection
          registries={registries}
          onToggle={handleToggleRegistry}
          onRemove={handleRemoveRegistry}
          onRefresh={handleRefreshOne}
          refreshingId={refreshingId}
        />
      ) : (
        <>
          {/* Registries grid (default view, no drill-in) */}
          {browseMode === 'registries' && !activeRegistryId && (
            <div className="grid gap-3 content-start overflow-y-auto flex-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))' }}>
              {registries.filter(r => r.enabled).map((reg) => (
                <button
                  key={reg.id}
                  onClick={() => handleDrillIn(reg.id)}
                  className="rounded-lg border border-border/50 bg-surface-3 p-4 flex flex-col gap-2 text-left hover:border-border transition-colors h-fit"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-medium truncate">{reg.name}</h3>
                    <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-muted-foreground">
                      {reg.source_type}
                    </span>
                  </div>
                  {reg.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{reg.description}</p>
                  )}
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60 mt-auto pt-2 border-t border-border/30">
                    <span>{reg.entry_count ?? 0} skills</span>
                    {reg.github_owner && (
                      <span className="flex items-center gap-1">
                        <ExternalLink className="size-2.5" />
                        {reg.github_owner}/{reg.github_repo}
                      </span>
                    )}
                    {reg.last_synced_at && (
                      <span>Synced {new Date(reg.last_synced_at).toLocaleDateString()}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Skills grid (drill-in or show-all mode) */}
          {showSkillGrid && (
            <>
              {/* Show-all mode: search + registry filter */}
              {browseMode === 'all' && (
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search skills..."
                      className="pl-8 h-8 text-xs"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  {registries.length > 1 && (
                    <select
                      className="h-8 rounded-md border border-border/50 bg-surface-3 px-2 text-xs text-foreground"
                      value={selectedRegistry ?? ''}
                      onChange={(e) => setSelectedRegistry(e.target.value || null)}
                    >
                      <option value="">All registries</option>
                      {registries.filter(r => r.enabled).map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}


              {loading ? (
                <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
                  Loading skills...
                </div>
              ) : entries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
                  <p className="text-sm text-muted-foreground">No skills found</p>
                  <p className="text-xs text-muted-foreground/60">
                    {search ? 'Try a different search term' : 'This registry has no skills yet'}
                  </p>
                </div>
              ) : (
                <div className="grid gap-3 content-start overflow-y-auto flex-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))' }}>
                  {entries.map((entry) => (
                    <SkillEntryCard
                      key={entry.id}
                      entry={entry}
                      onAddToLibrary={handleAddToLibrary}
                      onAddToProject={handleAddToProject}
                      hasProject={hasProject}
                      onUpdate={handleUpdate}
                      onPreview={setPreviewEntry}
                      installing={installing === entry.id}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      <SkillPreviewDialog
        entry={previewEntry}
        onOpenChange={(open) => !open && setPreviewEntry(null)}
        onAddToLibrary={handleAddToLibrary}
        onAddToProject={handleAddToProject}
        onUpdate={handleUpdate}
        hasProject={hasProject}
        installing={previewEntry ? installing === previewEntry.id : false}
      />

      <AddRegistryDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onAdd={handleAddRegistry}
      />
    </div>
  )
}
