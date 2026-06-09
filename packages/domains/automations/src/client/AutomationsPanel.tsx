import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useSubscription } from '@slayzone/transport/client'
import { Button } from '@slayzone/ui'
import { Plus, Zap } from 'lucide-react'
import type {
  Automation,
  CreateAutomationInput,
  UpdateAutomationInput
} from '@slayzone/automations/shared'
import type { Tag } from '@slayzone/tags/shared'
import { AutomationCard } from './AutomationCard'
import { AutomationDialog } from './automation-dialog'

interface AutomationsPanelProps {
  projectId: string
}

export function AutomationsPanel({ projectId }: AutomationsPanelProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Automation | null>(null)

  const automationsQuery = useQuery(
    trpc.automations.getByProject.queryOptions({ projectId }, { enabled: !!projectId })
  )
  const automations = automationsQuery.data ?? []

  const tagsQuery = useQuery(trpc.tags.list.queryOptions())
  const tags = (tagsQuery.data ?? []).filter((t: Tag) => t.project_id === projectId)

  // AutomationEngine mutations fan out via `automations.onChanged`; translate
  // each into a cache invalidation (no payload — the queries re-fetch).
  useSubscription(
    trpc.automations.onChanged.subscriptionOptions(undefined, {
      enabled: !!projectId,
      onData: () => {
        queryClient.invalidateQueries(trpc.automations.getByProject.queryFilter({ projectId }))
        queryClient.invalidateQueries(trpc.tags.list.queryFilter())
      }
    })
  )

  const invalidateAutomations = (): void => {
    queryClient.invalidateQueries(trpc.automations.getByProject.queryFilter({ projectId }))
  }

  const createMutation = useMutation(
    trpc.automations.create.mutationOptions({ onSuccess: invalidateAutomations })
  )
  const updateMutation = useMutation(
    trpc.automations.update.mutationOptions({ onSuccess: invalidateAutomations })
  )
  const toggleMutation = useMutation(
    trpc.automations.toggle.mutationOptions({ onSuccess: invalidateAutomations })
  )
  const deleteMutation = useMutation(
    trpc.automations.delete.mutationOptions({ onSuccess: invalidateAutomations })
  )
  const runManualMutation = useMutation(
    trpc.automations.runManual.mutationOptions({ onSuccess: invalidateAutomations })
  )

  const handleSave = async (data: CreateAutomationInput | UpdateAutomationInput) => {
    if ('id' in data) {
      await updateMutation.mutateAsync(data)
    } else {
      await createMutation.mutateAsync(data)
    }
  }

  const handleToggle = async (id: string, enabled: boolean) => {
    await toggleMutation.mutateAsync({ id, enabled })
  }

  const handleDelete = async (id: string) => {
    await deleteMutation.mutateAsync({ id })
  }

  const handleDuplicate = async (automation: Automation) => {
    await createMutation.mutateAsync({
      project_id: automation.project_id,
      name: `${automation.name} (copy)`,
      description: automation.description ?? undefined,
      trigger_config: automation.trigger_config,
      conditions: automation.conditions,
      actions: automation.actions
    })
  }

  const handleRunManual = async (id: string) => {
    await runManualMutation.mutateAsync({ id })
  }

  const handleLoadRuns = (automationId: string) => {
    return queryClient.fetchQuery(
      trpc.automations.getRuns.queryOptions({ automationId, limit: 10 })
    )
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
          automations.map((a) => (
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
        tags={tags.map((t) => ({ id: t.id, name: t.name }))}
        onSave={handleSave}
      />
    </div>
  )
}
