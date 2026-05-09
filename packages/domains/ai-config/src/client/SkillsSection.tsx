import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { SkillGraphCanvas } from './SkillGraphCanvas'
import { SkillListView } from './SkillListView'
import { ContextItemEditor } from './ContextItemEditor'
import { ComputerContextFiles } from './ComputerContextFiles'
import { AddItemPicker } from './AddItemPicker'
import { SkillViewToggle, type SkillViewMode } from './SkillViewToggle'
import { getSkillValidation } from './skill-validation'
import { buildDefaultSkillContent } from '../shared'
import type { AiConfigItem, AiConfigScope, ConfigLevel, ProjectSkillStatus, SyncHealth, SkillUpdateInfo } from '../shared'
import { aggregateProviderSyncHealth } from './sync-view-model'
import { useContextManagerStore } from './useContextManagerStore'

interface SkillsSectionProps {
  level: ConfigLevel
  projectId: string | null
  projectPath?: string | null
}

function nextAvailableSlug(base: string, existingSlugs: Set<string>): string {
  if (!existingSlugs.has(base)) return base
  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}

export function SkillsSection({ level, projectId, projectPath }: SkillsSectionProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const scope: AiConfigScope = level === 'library' ? 'library' : 'project'
  const isProject = level === 'project' && !!projectId && !!projectPath

  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [showAddPicker, setShowAddPicker] = useState(false)
  const viewMode = (useContextManagerStore((s) => s.skillViewMode[scope]) ?? 'list') as SkillViewMode
  const setSkillViewMode = useContextManagerStore((s) => s.setSkillViewMode)
  const skillGroupBy = useContextManagerStore((s) => s.skillGroupBy)
  const setSkillGroupBy = useContextManagerStore((s) => s.setSkillGroupBy)

  // Auto-create DB records for any new on-disk skill files (one-shot per project mount)
  const reconcileMutation = useMutation(trpc.aiConfig.reconcileProjectSkills.mutationOptions())
  const reconciledRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isProject || !projectId || !projectPath) return
    const key = `${projectId}:${projectPath}`
    if (reconciledRef.current === key) return
    reconciledRef.current = key
    reconcileMutation.mutate({ projectId, projectPath }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listItems.queryKey() })
      },
    })
  }, [isProject, projectId, projectPath, reconcileMutation, queryClient, trpc])

  const itemsQuery = useQuery(
    trpc.aiConfig.listItems.queryOptions({
      scope,
      projectId: isProject ? projectId! : undefined,
      type: 'skill',
    }),
  )

  const projectSkillsStatusQuery = useQuery({
    ...trpc.aiConfig.getProjectSkillsStatus.queryOptions(
      isProject && projectId && projectPath ? { projectId, projectPath } : { projectId: '', projectPath: '' },
    ),
    enabled: isProject && !!projectId && !!projectPath,
  })

  const providersQuery = useQuery({
    ...trpc.aiConfig.getProjectProviders.queryOptions(isProject && projectId ? { projectId } : { projectId: '' }),
    enabled: isProject && !!projectId,
  })

  const updatesQuery = useQuery(trpc.aiConfig.marketplace.checkUpdates.queryOptions())

  const loadError = itemsQuery.isError ? 'Failed to load skills' : null

  // Combine fetched skills with linked-from-library skills not yet in `items`
  const items = useMemo<AiConfigItem[]>(() => {
    const rows = [...(itemsQuery.data ?? [])]
    const linked = projectSkillsStatusQuery.data ?? []
    const ids = new Set(rows.map(r => r.id))
    for (const s of linked) {
      if (!ids.has(s.item.id)) rows.push(s.item)
    }
    return rows
  }, [itemsQuery.data, projectSkillsStatusQuery.data])

  const linkedIds = useMemo<string[]>(
    () => (projectSkillsStatusQuery.data ?? []).map(s => s.item.id),
    [projectSkillsStatusQuery.data],
  )

  const syncHealthMap = useMemo<Map<string, SyncHealth>>(() => {
    const m = new Map<string, SyncHealth>()
    for (const s of projectSkillsStatusQuery.data ?? []) {
      m.set(s.item.id, aggregateProviderSyncHealth(s.providers))
    }
    return m
  }, [projectSkillsStatusQuery.data])

  const statusMap = useMemo<Map<string, ProjectSkillStatus>>(() => {
    const m = new Map<string, ProjectSkillStatus>()
    for (const s of projectSkillsStatusQuery.data ?? []) {
      m.set(s.item.id, s)
    }
    return m
  }, [projectSkillsStatusQuery.data])

  const updateMap = useMemo<Map<string, SkillUpdateInfo>>(() => {
    const m = new Map<string, SkillUpdateInfo>()
    for (const u of updatesQuery.data ?? []) m.set(u.itemId, u)
    return m
  }, [updatesQuery.data])

  const enabledProviders = providersQuery.data ?? []

  const refreshSyncStatus = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: trpc.aiConfig.getProjectSkillsStatus.queryKey() })
  }, [queryClient, trpc])

  const updateItemMutation = useMutation(trpc.aiConfig.updateItem.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listItems.queryKey() })
      refreshSyncStatus()
    },
  }))
  const deleteItemMutation = useMutation(trpc.aiConfig.deleteItem.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listItems.queryKey() })
    },
  }))
  const marketplaceUpdateMutation = useMutation(trpc.aiConfig.marketplace.updateSkill.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listItems.queryKey() })
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.marketplace.checkUpdates.queryKey() })
    },
  }))
  const marketplaceUnlinkMutation = useMutation(trpc.aiConfig.marketplace.unlinkSkill.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listItems.queryKey() })
    },
  }))
  const removeProjectSelectionMutation = useMutation(trpc.aiConfig.removeProjectSelection.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listItems.queryKey() })
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.getProjectSkillsStatus.queryKey() })
    },
  }))
  const syncAllMutation = useMutation(trpc.aiConfig.syncAll.mutationOptions({
    onSuccess: () => refreshSyncStatus(),
  }))
  const pullProviderSkillMutation = useMutation(trpc.aiConfig.pullProviderSkill.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listItems.queryKey() })
      refreshSyncStatus()
    },
  }))
  const createItemMutation = useMutation(trpc.aiConfig.createItem.mutationOptions({
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listItems.queryKey() })
      setSelectedSkillId(created.id)
    },
  }))

  // Consume one-shot library skill selection from the store
  useEffect(() => {
    if (level !== 'library') return
    if (items.length === 0) return
    const pending = useContextManagerStore.getState().consumePendingLibrarySkillId()
    if (pending && items.some(i => i.id === pending)) {
      setSelectedSkillId(pending)
    }
  }, [level, items])

  const handleViewModeChange = useCallback((mode: SkillViewMode) => {
    setSkillViewMode(scope, mode)
  }, [setSkillViewMode, scope])

  const handleUpdateItem = useCallback(async (id: string, patch: Parameters<typeof updateItemMutation.mutateAsync>[0] extends infer T ? Omit<T & { id: string }, 'id'> : never) => {
    await updateItemMutation.mutateAsync({ id, ...patch })
  }, [updateItemMutation])

  const handleDeleteItem = useCallback(async (id: string) => {
    await deleteItemMutation.mutateAsync({ id })
    if (selectedSkillId === id) setSelectedSkillId(null)
  }, [deleteItemMutation, selectedSkillId])

  const handleMarketplaceUpdate = useCallback(async (itemId: string) => {
    const info = updateMap.get(itemId)
    if (!info) return
    await marketplaceUpdateMutation.mutateAsync({ itemId, entryId: info.entryId })
  }, [updateMap, marketplaceUpdateMutation])

  const handleSyncSkillToDisk = useCallback(async (itemId: string) => {
    if (!isProject || !projectId || !projectPath) return
    await syncAllMutation.mutateAsync({ projectId, projectPath, itemId })
  }, [isProject, projectId, projectPath, syncAllMutation])

  const handleSyncSkillProviderToDisk = useCallback(async (itemId: string, provider: typeof enabledProviders[number]) => {
    if (!isProject || !projectId || !projectPath) return
    await syncAllMutation.mutateAsync({ projectId, projectPath, itemId, providers: [provider] })
  }, [isProject, projectId, projectPath, syncAllMutation])

  const handlePullSkillProviderFromDisk = useCallback(async (itemId: string, provider: typeof enabledProviders[number]) => {
    if (!isProject || !projectId || !projectPath) return
    await pullProviderSkillMutation.mutateAsync({ projectId, projectPath, provider, itemId })
  }, [isProject, projectId, projectPath, pullProviderSkillMutation])

  const handleUnlink = useCallback(async (target: AiConfigItem) => {
    const hasMarketplace = (() => {
      try { return !!JSON.parse(target.metadata_json)?.marketplace } catch { return false }
    })()
    if (hasMarketplace) {
      await marketplaceUnlinkMutation.mutateAsync({ itemId: target.id })
      return
    }
    if (isProject && projectId && target.scope === 'library') {
      await removeProjectSelectionMutation.mutateAsync({ projectId, itemId: target.id })
      if (selectedSkillId === target.id) setSelectedSkillId(null)
    }
  }, [isProject, projectId, selectedSkillId, marketplaceUnlinkMutation, removeProjectSelectionMutation])

  const handleCreateSkill = useCallback(() => {
    const existingSlugs = new Set(items.map(i => i.slug))
    const slug = nextAvailableSlug('new-skill', existingSlugs)
    createItemMutation.mutate({
      type: 'skill',
      scope,
      projectId: isProject ? projectId! : undefined,
      slug,
      content: buildDefaultSkillContent(slug),
    })
  }, [items, scope, isProject, projectId, createItemMutation])

  const sortedItems = useMemo(() => [...items].sort((a, b) => a.slug.localeCompare(b.slug)), [items])

  // Computer level — show computer files filtered to skills
  if (level === 'computer') {
    return <ComputerContextFiles filter="skill" />
  }

  // Project + Library levels — graph or list view with editor panel
  const selectedItem = items.find(i => i.id === selectedSkillId) ?? null
  const validation = selectedItem ? getSkillValidation(selectedItem) : null

  const headerTarget = document.getElementById('context-manager-header-actions')
  const editorTarget = document.getElementById('context-manager-editor-panel')
  const handleTarget = document.getElementById('context-manager-resize-handle')

  // Resize drag
  const skillEditorWidth = useContextManagerStore((s) => s.skillEditorWidth)
  const setSkillEditorWidth = useContextManagerStore((s) => s.setSkillEditorWidth)
  const dragging = useRef(false)

  const onDragStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current) return
      const fromRight = window.innerWidth - ev.clientX - 12
      setSkillEditorWidth(Math.min(Math.max(fromRight, 300), window.innerWidth * 0.6))
    }
    const onUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setSkillEditorWidth])

  useEffect(() => {
    if (editorTarget && selectedItem) {
      editorTarget.style.width = skillEditorWidth ? `${skillEditorWidth}px` : '50%'
    }
    return () => {
      if (editorTarget) editorTarget.style.width = ''
    }
  }, [editorTarget, selectedItem, skillEditorWidth])

  return (
    <>
      {headerTarget && createPortal(
        <div className="flex items-stretch gap-4 h-8">
          {viewMode === 'list' && (
            <Select value={skillGroupBy} onValueChange={setSkillGroupBy}>
              <SelectTrigger size="sm" className="h-full w-auto gap-1.5 py-0 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No grouping</SelectItem>
                <SelectItem value="source">Group by source</SelectItem>
                <SelectItem value="prefix">Group by prefix</SelectItem>
              </SelectContent>
            </Select>
          )}
          <SkillViewToggle value={viewMode} onChange={handleViewModeChange} className="h-full" />
          <Button size="sm" variant="outline" className="h-full" onClick={isProject ? () => setShowAddPicker(true) : handleCreateSkill}>
            <Plus className="mr-1 size-3.5" />
            Add Skill
          </Button>
        </div>,
        headerTarget
      )}
      {selectedItem && handleTarget && createPortal(
        <div
          className="flex h-full w-3 shrink-0 cursor-col-resize items-center justify-center"
          onMouseDown={onDragStart}
          onDoubleClick={() => setSkillEditorWidth(null)}
        >
          <div className="h-8 w-0.5 rounded-full bg-border" />
        </div>,
        handleTarget
      )}
      {selectedItem && editorTarget && createPortal(
        <ContextItemEditor
          key={selectedItem.id}
          item={selectedItem}
          validationState={validation}
          readOnly={isProject && selectedItem.scope === 'library'}
          onUpdate={(patch) => handleUpdateItem(selectedItem.id, patch)}
          onDelete={() => handleDeleteItem(selectedItem.id)}
          onClose={() => setSelectedSkillId(null)}
          updateInfo={updateMap.get(selectedItem.id) ?? null}
          onMarketplaceUpdate={() => handleMarketplaceUpdate(selectedItem.id)}
          onUnlink={() => handleUnlink(selectedItem)}
          syncStatus={statusMap.get(selectedItem.id) ?? null}
          onSyncToDisk={() => handleSyncSkillToDisk(selectedItem.id)}
          onSyncProviderToDisk={(provider) => handleSyncSkillProviderToDisk(selectedItem.id, provider)}
          onPullProviderFromDisk={(provider) => handlePullSkillProviderFromDisk(selectedItem.id, provider)}
        />,
        editorTarget
      )}
      {loadError && (
        <p className="mb-2 text-sm text-destructive">{loadError}</p>
      )}
      <div className="flex h-full min-h-0">
        {viewMode === 'graph' ? (
          <div className="flex-1 min-h-0">
            <SkillGraphCanvas
              items={sortedItems}
              scope={scope}
              selectedSkillId={selectedSkillId}
              onSelectSkill={setSelectedSkillId}
              onUpdateItem={handleUpdateItem}
              onCreateSkill={handleCreateSkill}
              syncHealthMap={syncHealthMap}
            />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-1">
            <SkillListView
              items={sortedItems}
              selectedSkillId={selectedSkillId}
              isProject={isProject}
              groupBy={skillGroupBy}
              onSelectSkill={setSelectedSkillId}
              onDeleteItem={handleDeleteItem}
              updateMap={updateMap}
              onMarketplaceUpdate={handleMarketplaceUpdate}
              syncHealthMap={syncHealthMap}
            />
          </div>
        )}
      </div>
      {isProject && projectId && projectPath && (
        <AddItemPicker
          open={showAddPicker}
          onOpenChange={setShowAddPicker}
          type="skill"
          projectId={projectId}
          projectPath={projectPath}
          enabledProviders={enabledProviders}
          existingLinks={linkedIds}
          onAdded={() => {
            setShowAddPicker(false)
            queryClient.invalidateQueries({ queryKey: trpc.aiConfig.listItems.queryKey() })
            queryClient.invalidateQueries({ queryKey: trpc.aiConfig.getProjectSkillsStatus.queryKey() })
          }}
        />
      )}
    </>
  )
}
