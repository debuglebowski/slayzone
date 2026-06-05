import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { ProjectSkillStatus } from '../shared'
import { AddItemPicker } from './AddItemPicker'
import { SkillHelpCard } from './SkillHelpCard'
import { SkillItemDetail } from './SkillItemDetail'
import type { ItemSectionProps } from './ItemSection.types'

export function ItemSection({
  type,
  linkedItems,
  localItems,
  enabledProviders,
  projectId,
  projectPath,
  onOpenContextManager,
  onChanged
}: ItemSectionProps) {
  const [showPicker, setShowPicker] = useState(false)

  const allItems = [
    ...localItems.map((item) => ({
      item,
      providers: {} as ProjectSkillStatus['providers'],
      isLocal: true
    })),
    ...linkedItems.map((s) => ({
      item: s.item,
      providers: s.providers,
      isLocal: s.item.scope === 'project'
    }))
  ].sort((a, b) => a.item.slug.localeCompare(b.item.slug))
  const existingLinks = linkedItems.map((s) => s.item.id)

  const handleRemove = async (itemId: string, isLocal: boolean) => {
    if (isLocal) {
      await window.api.aiConfig.deleteItem(itemId)
    } else {
      await window.api.aiConfig.removeProjectSelection(projectId, itemId)
    }
    onChanged()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {allItems.map(({ item, providers, isLocal }) => (
          <SkillItemDetail
            key={item.id}
            item={item}
            providers={providers}
            enabledProviders={enabledProviders}
            isLocal={isLocal}
            projectId={projectId}
            projectPath={projectPath}
            onGoToLibrary={
              !isLocal && onOpenContextManager ? () => onOpenContextManager('skill') : undefined
            }
            onChanged={onChanged}
            onRemove={() => handleRemove(item.id, isLocal)}
          />
        ))}
        <div
          data-testid={`project-context-add-${type}`}
          className="mt-1 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 cursor-pointer text-muted-foreground transition-colors hover:bg-muted/15 hover:text-foreground"
          onClick={() => setShowPicker(true)}
        >
          <Plus className="size-3 shrink-0" />
          <span className="text-xs">Add skill</span>
        </div>
      </div>
      <SkillHelpCard testId="project-skill-help-card" className="mt-3 shrink-0" />

      <AddItemPicker
        open={showPicker}
        onOpenChange={setShowPicker}
        type={type}
        projectId={projectId}
        projectPath={projectPath}
        enabledProviders={enabledProviders}
        existingLinks={existingLinks}
        onAdded={() => {
          setShowPicker(false)
          onChanged()
        }}
      />
    </div>
  )
}
