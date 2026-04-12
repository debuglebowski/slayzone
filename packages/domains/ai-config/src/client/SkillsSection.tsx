import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { SkillGraphCanvas } from './SkillGraphCanvas'
import { SkillListView } from './SkillListView'
import { ContextItemEditor } from './ContextItemEditor'
import { GlobalContextFiles } from './GlobalContextFiles'
import { AddItemPicker } from './AddItemPicker'
import { SkillViewToggle, type SkillViewMode } from './SkillViewToggle'
import { getSkillValidation } from './skill-validation'
import { buildDefaultSkillContent } from '../shared'
import type { AiConfigItem, AiConfigScope, CliProvider, ConfigLevel, SyncHealth, SkillUpdateInfo, UpdateAiConfigItemInput } from '../shared'
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
  const scope: AiConfigScope = level === 'library' ? 'global' : 'project'
  const isProject = level === 'project' && !!projectId && !!projectPath

  const [items, setItems] = useState<AiConfigItem[]>([])
  const [linkedIds, setLinkedIds] = useState<string[]>([])
  const [syncHealthMap, setSyncHealthMap] = useState<Map<string, SyncHealth>>(new Map())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [showAddPicker, setShowAddPicker] = useState(false)
  const [enabledProviders, setEnabledProviders] = useState<CliProvider[]>([])
  const viewMode = (useContextManagerStore((s) => s.skillViewMode[scope]) ?? 'list') as SkillViewMode
  const setSkillViewMode = useContextManagerStore((s) => s.setSkillViewMode)
  const skillGroupBy = useContextManagerStore((s) => s.skillGroupBy)
  const setSkillGroupBy = useContextManagerStore((s) => s.setSkillGroupBy)
  const [updateMap, setUpdateMap] = useState<Map<string, SkillUpdateInfo>>(new Map())

  const bumpVersion = useCallback(() => setVersion(v => v + 1), [])

  useEffect(() => {
    let stale = false
    void (async () => {
      try {
        if (isProject && projectId && projectPath) {
          // Auto-create DB records for any new on-disk skill files
          await window.api.aiConfig.reconcileProjectSkills(projectId, projectPath)
        }
        const rows = await window.api.aiConfig.listItems({
          scope,
          projectId: isProject ? projectId : undefined,
          type: 'skill',
        })
        const newLinkedIds: string[] = []
        const healthMap = new Map<string, SyncHealth>()
        if (isProject && projectId && projectPath) {
          const linked = await window.api.aiConfig.getProjectSkillsStatus(projectId, projectPath)
          const ids = new Set(rows.map(r => r.id))
          for (const s of linked) {
            newLinkedIds.push(s.item.id)
            if (!ids.has(s.item.id)) rows.push(s.item)
            healthMap.set(s.item.id, aggregateProviderSyncHealth(s.providers))
          }
        }
        if (stale) return
        setItems(rows)
        setLinkedIds(newLinkedIds)
        setSyncHealthMap(healthMap)
        setLoadError(null)
      } catch {
        if (stale) return
        setLoadError('Failed to load skills')
      }
    })()
    return () => { stale = true }
  }, [scope, isProject, projectId, projectPath, version])

  useEffect(() => {
    if (!isProject || !projectId) return
    void window.api.aiConfig.getProjectProviders(projectId).then(setEnabledProviders)
  }, [isProject, projectId])

  // Load marketplace update info
  useEffect(() => {
    window.api.aiConfig.marketplace.checkUpdates().then((updates) => {
      const map = new Map<string, SkillUpdateInfo>()
      for (const u of updates) map.set(u.itemId, u)
      setUpdateMap(map)
    }).catch(() => {})
  }, [items])

  // Consume one-shot library skill selection from the store (set by Go-to-library button).
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

  const handleUpdateItem = useCallback(async (id: string, patch: Omit<UpdateAiConfigItemInput, 'id'>) => {
    const updated = await window.api.aiConfig.updateItem({ id, ...patch })
    if (updated) setItems(prev => prev.map(i => i.id === updated.id ? updated : i))
  }, [])

  const handleDeleteItem = useCallback(async (id: string) => {
    await window.api.aiConfig.deleteItem(id)
    setItems(prev => prev.filter(i => i.id !== id))
    if (selectedSkillId === id) setSelectedSkillId(null)
  }, [selectedSkillId])

  const handleMarketplaceUpdate = useCallback(async (itemId: string) => {
    const info = updateMap.get(itemId)
    if (!info) return
    const updated = await window.api.aiConfig.marketplace.updateSkill(itemId, info.entryId)
    if (updated) setItems(prev => prev.map(i => i.id === updated.id ? (updated as AiConfigItem) : i))
    setUpdateMap(prev => { const next = new Map(prev); next.delete(itemId); return next })
  }, [updateMap])

  const handleUnlink = useCallback(async (target: AiConfigItem) => {
    const hasMarketplace = (() => {
      try { return !!JSON.parse(target.metadata_json)?.marketplace } catch { return false }
    })()
    if (hasMarketplace) {
      const updated = await window.api.aiConfig.marketplace.unlinkSkill(target.id)
      if (updated) setItems(prev => prev.map(i => i.id === updated.id ? (updated as AiConfigItem) : i))
      return
    }
    if (isProject && projectId && target.scope === 'global') {
      await window.api.aiConfig.removeProjectSelection(projectId, target.id)
      setItems(prev => prev.filter(i => i.id !== target.id))
      setLinkedIds(prev => prev.filter(id => id !== target.id))
      if (selectedSkillId === target.id) setSelectedSkillId(null)
    }
  }, [isProject, projectId, selectedSkillId])

  const handleCreateSkill = useCallback(async () => {
    const existingSlugs = new Set(items.map(i => i.slug))
    const slug = nextAvailableSlug('new-skill', existingSlugs)
    const created = await window.api.aiConfig.createItem({
      type: 'skill',
      scope,
      projectId: isProject ? projectId : undefined,
      slug,
      content: buildDefaultSkillContent(slug),
    })
    setItems(prev => [created, ...prev])
    setSelectedSkillId(created.id)
  }, [items, scope, isProject, projectId])

  const sortedItems = useMemo(() => [...items].sort((a, b) => a.slug.localeCompare(b.slug)), [items])

  // Computer level — show global files filtered to skills
  if (level === 'computer') {
    return <GlobalContextFiles filter="skill" />
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
      const fromRight = window.innerWidth - ev.clientX - 12 // 12 = p-3 padding
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

  // Apply width to editor panel (null = 50% of available)
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
          readOnly={isProject && selectedItem.scope === 'global'}
          onUpdate={(patch) => handleUpdateItem(selectedItem.id, patch)}
          onDelete={() => handleDeleteItem(selectedItem.id)}
          onClose={() => setSelectedSkillId(null)}
          updateInfo={updateMap.get(selectedItem.id) ?? null}
          onMarketplaceUpdate={() => handleMarketplaceUpdate(selectedItem.id)}
          onUnlink={() => handleUnlink(selectedItem)}
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
          onAdded={() => { setShowAddPicker(false); bumpVersion() }}
        />
      )}
    </>
  )
}
