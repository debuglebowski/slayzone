import { useState, useEffect, useCallback } from 'react'
import { Button } from '@slayzone/ui'
import { Plus, Zap } from 'lucide-react'
import type { Automation, CreateAutomationInput, UpdateAutomationInput } from '@slayzone/automations/shared'
import type { Tag } from '@slayzone/tags/shared'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { AutomationCard } from './AutomationCard'
import { AutomationDialog } from './AutomationDialog'

interface AutomationsPanelProps {
  projectId: string
}

export function AutomationsPanel({ projectId }: AutomationsPanelProps) {
  const [automations, setAutomations] = useState<Automation[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Automation | null>(null)

  const loadData = useCallback(() => {
    if (!projectId) return
    window.api.automations.getByProject(projectId).then(setAutomations)
    getTrpcVanillaClient().tags.list.query().then((all) => setTags(all.filter((t: Tag) => t.project_id === projectId)))
  }, [projectId])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    return window.api.automations.onChanged(loadData)
  }, [loadData])

  const handleSave = async (data: CreateAutomationInput | UpdateAutomationInput) => {
    if ('id' in data) {
      await window.api.automations.update(data)
    } else {
      await window.api.automations.create(data)
    }
    loadData()
  }

  const handleToggle = async (id: string, enabled: boolean) => {
    await window.api.automations.toggle(id, enabled)
    loadData()
  }

  const handleDelete = async (id: string) => {
    await window.api.automations.delete(id)
    loadData()
  }

  const handleDuplicate = async (automation: Automation) => {
    await window.api.automations.create({
      project_id: automation.project_id,
      name: `${automation.name} (copy)`,
      description: automation.description ?? undefined,
      trigger_config: automation.trigger_config,
      conditions: automation.conditions,
      actions: automation.actions,
    })
    loadData()
  }

  const handleRunManual = async (id: string) => {
    await window.api.automations.runManual(id)
    loadData()
  }

  const handleLoadRuns = (automationId: string) => {
    return window.api.automations.getRuns(automationId, 10)
  }

  const handleEdit = (automation: Automation) => {
    setEditing(automation)
    setDialogOpen(true)
  }

  const handleNew = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          Automations
        </h3>
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleNew}>
          <Plus className="w-3 h-3 mr-1" /> New
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {automations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-2 p-4">
            <Zap className="w-8 h-8 opacity-30" />
            <p className="text-sm">No automations yet</p>
            <p className="text-xs">Create one to automate repetitive tasks</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={handleNew}>
              <Plus className="w-3 h-3 mr-1" /> Create Automation
            </Button>
          </div>
        ) : (
          automations.map(a => (
            <AutomationCard
              key={a.id}
              automation={a}
              onToggle={handleToggle}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onDuplicate={handleDuplicate}
              onRunManual={handleRunManual}
              onLoadRuns={handleLoadRuns}
            />
          ))
        )}
      </div>

      <AutomationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        automation={editing}
        projectId={projectId}
        tags={tags.map(t => ({ id: t.id, name: t.name }))}
        onSave={handleSave}
      />
    </div>
  )
}
