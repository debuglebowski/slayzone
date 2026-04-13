import { useCallback, useEffect, useState } from 'react'
import { Check, AlertCircle, Circle, Trash2, Sparkles } from 'lucide-react'
import { cn } from '@slayzone/ui'
import { buildDefaultSkillContent } from '../shared'
import type { AiConfigItem, AiConfigItemType, CliProvider, ProjectSkillStatus, SyncHealth, UpdateAiConfigItemInput } from '../shared'
import { PROVIDER_LABELS } from '../shared/provider-registry'
import { LibraryItemPicker } from './LibraryItemPicker'
import { ContextItemEditor } from './ContextItemEditor'
import { toSyncBadgeLabel } from './sync-view-model'
import { getSkillValidation } from './skill-validation'

interface ProjectSkillsProps {
  projectId: string
  projectPath: string
  type?: AiConfigItemType
  openPickerTrigger?: number
  openCreateTrigger?: number
  onChanged?: () => void
}

function StatusBadge({ provider, syncHealth }: {
  provider: CliProvider
  syncHealth: SyncHealth
}) {
  const health = syncHealth
  const isNotSynced = health === 'not_synced'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
        health === 'synced' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
        health === 'stale' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
        health === 'unmanaged' && 'bg-muted text-muted-foreground',
        isNotSynced && 'bg-muted text-muted-foreground'
      )}
    >
      {health === 'synced' && <Check className="size-2.5" />}
      {health === 'stale' && <AlertCircle className="size-2.5" />}
      {health === 'unmanaged' && <Circle className="size-2.5" />}
      {`${PROVIDER_LABELS[provider]} ${toSyncBadgeLabel(health)}`}
    </span>
  )
}

export function ProjectSkills({ projectId, projectPath, type, openPickerTrigger, openCreateTrigger, onChanged }: ProjectSkillsProps) {
  const [allItems, setAllItems] = useState<ProjectSkillStatus[]>([])
  const [localItems, setLocalItems] = useState<AiConfigItem[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPicker, setShowPicker] = useState(false)

  const skills = type ? allItems.filter(s => s.item.type === type) : allItems

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [linked, local] = await Promise.all([
        window.api.aiConfig.getProjectSkillsStatus(projectId, projectPath),
        window.api.aiConfig.listItems({ scope: 'project', projectId, type })
      ])
      setAllItems(linked)
      setLocalItems(local)
    } finally {
      setLoading(false)
    }
  }, [projectId, projectPath, type])

  useEffect(() => {
    if (openPickerTrigger && openPickerTrigger > 0) setShowPicker(true)
  }, [openPickerTrigger])

  useEffect(() => {
    if (!openCreateTrigger || openCreateTrigger <= 0) return
    void handleCreate()
  }, [openCreateTrigger])

  useEffect(() => { void load() }, [load])

  const handleRemove = async (itemId: string) => {
    await window.api.aiConfig.removeProjectSelection(projectId, itemId)
    await load()
    onChanged?.()
  }

  const handleItemLoaded = async () => {
    setShowPicker(false)
    await load()
    onChanged?.()
  }

  const handleCreate = async () => {
    const slug = 'new-skill'
    const created = await window.api.aiConfig.createItem({
      type: 'skill',
      scope: 'project',
      projectId,
      slug,
      content: buildDefaultSkillContent(slug)
    })
    setLocalItems(prev => [created, ...prev])
    setEditingId(created.id)
    onChanged?.()
  }

  const handleUpdate = async (itemId: string, patch: Omit<UpdateAiConfigItemInput, 'id'>) => {
    const updated = await window.api.aiConfig.updateItem({ id: itemId, ...patch })
    if (!updated) return
    setLocalItems(prev => prev.map(item => item.id === updated.id ? updated : item))
    onChanged?.()
  }

  const handleDelete = async (itemId: string) => {
    await window.api.aiConfig.deleteItem(itemId)
    setLocalItems(prev => prev.filter(item => item.id !== itemId))
    setEditingId(null)
    onChanged?.()
  }

  // Filter out root_instructions from local items
  const filteredLocal = localItems.filter(i => i.type !== 'root_instructions')

  return (
    <div className="space-y-4">
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : skills.length === 0 && filteredLocal.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
          <Sparkles className="size-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium text-foreground">
            No skills yet
          </p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Create a project-specific skill or add one from your library.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Project-local items */}
          {filteredLocal.map(item => (
            <div key={item.id}>
              {editingId === item.id ? (
                <ContextItemEditor
                  item={item}
                  validationState={getSkillValidation(item)}
                  onUpdate={(patch) => handleUpdate(item.id, patch)}
                  onDelete={() => handleDelete(item.id)}
                  onClose={() => setEditingId(null)}
                />
              ) : (
                <button
                  onClick={() => setEditingId(item.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-md border bg-surface-3 px-3 py-2.5 text-left transition-colors"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{item.slug}</p>
                  </div>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    Local
                  </span>
                </button>
              )}
            </div>
          ))}

          {/* Linked library items */}
          {skills.map(({ item, providers }) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 rounded-md border bg-surface-3 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{item.slug}</p>
              </div>
              <div className="flex items-center gap-2">
                {(Object.entries(providers) as Array<[CliProvider, { syncHealth: SyncHealth }]>).map(
                  ([provider, { syncHealth }]) => (
                    <StatusBadge key={provider} provider={provider} syncHealth={syncHealth} />
                  )
                )}
                <button
                  className="rounded p-1 text-muted-foreground hover:text-destructive"
                  onClick={() => handleRemove(item.id)}
                  title="Remove from project"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showPicker && (
        <LibraryItemPicker
          projectId={projectId}
          projectPath={projectPath}
          existingLinks={skills.map(s => s.item.id)}
          type={type === 'skill' ? type : undefined}
          onLoaded={handleItemLoaded}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}
