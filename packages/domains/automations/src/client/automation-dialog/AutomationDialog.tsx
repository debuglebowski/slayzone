import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Button,
  Input,
  Label
} from '@slayzone/ui'
import {
  type TriggerConfig,
  type ConditionConfig,
  type ActionConfig,
  type CreateAutomationInput,
  type UpdateAutomationInput
} from '@slayzone/automations/shared'
import type { AiProviderOption, AutomationDialogProps } from './automation-types'
import { EMPTY_TRIGGER, EMPTY_RUN_COMMAND } from './automation-constants'
import { actionIsValid } from './automation-helpers'
import { TriggerSection } from './TriggerSection'
import { ConditionSection } from './ConditionSection'
import { ActionSection } from './ActionSection'

export function AutomationDialog({
  open,
  onOpenChange,
  automation,
  projectId,
  tags,
  onSave
}: AutomationDialogProps) {
  const trpc = useTRPC()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [trigger, setTrigger] = useState<TriggerConfig>(EMPTY_TRIGGER)
  const [conditions, setConditions] = useState<ConditionConfig[]>([])
  const [actions, setActions] = useState<ActionConfig[]>([{ ...EMPTY_RUN_COMMAND }])
  const [catchupOnStart, setCatchupOnStart] = useState(true)

  // Provider list — only fetched while the dialog is open (mirrors the old
  // open-gated load). `providersLoaded` flips true once the query settles, and
  // on error we fall back to an empty list (same as the old `.catch`).
  const modesQuery = useQuery(trpc.pty.modesList.queryOptions(undefined, { enabled: open }))
  const providers = useMemo<AiProviderOption[]>(() => {
    if (modesQuery.isError) return []
    return (modesQuery.data ?? [])
      .filter((m) => m.enabled && !!m.headlessCommand?.trim())
      .map((m) => ({
        id: m.id,
        label: m.label,
        type: m.type,
        defaultFlags: m.defaultFlags ?? '',
        headlessCommand: m.headlessCommand ?? ''
      }))
  }, [modesQuery.data, modesQuery.isError])
  const providersLoaded = open && (modesQuery.isSuccess || modesQuery.isError)

  useEffect(() => {
    if (automation) {
      setName(automation.name)
      setDescription(automation.description ?? '')
      setTrigger(automation.trigger_config)
      setConditions(automation.conditions)
      setActions(automation.actions.length > 0 ? automation.actions : [{ ...EMPTY_RUN_COMMAND }])
      setCatchupOnStart(automation.catchup_on_start)
    } else {
      setName('')
      setDescription('')
      setTrigger({ ...EMPTY_TRIGGER })
      setConditions([])
      setActions([{ ...EMPTY_RUN_COMMAND }])
      setCatchupOnStart(true)
    }
  }, [automation, open])

  const handleSave = () => {
    if (!name.trim()) return
    const validActions = actions.filter((a) => actionIsValid(a, providers, providersLoaded))
    if (validActions.length === 0) return

    if (automation) {
      onSave({
        id: automation.id,
        name: name.trim(),
        description: description.trim() || undefined,
        trigger_config: trigger,
        conditions,
        actions: validActions,
        catchup_on_start: catchupOnStart
      } satisfies UpdateAutomationInput)
    } else {
      onSave({
        project_id: projectId,
        name: name.trim(),
        description: description.trim() || undefined,
        trigger_config: trigger,
        conditions,
        actions: validActions,
        catchup_on_start: catchupOnStart
      } satisfies CreateAutomationInput)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: 672 }}>
        <DialogHeader>
          <DialogTitle>{automation ? 'Edit Automation' : 'New Automation'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 max-h-[60vh] overflow-y-auto pr-1">
          {/* Name */}
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Auto-cleanup worktrees"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label>
              Description <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this automation do?"
            />
          </div>

          {/* WHEN */}
          <TriggerSection
            trigger={trigger}
            setTrigger={setTrigger}
            catchupOnStart={catchupOnStart}
            setCatchupOnStart={setCatchupOnStart}
          />

          {/* ONLY IF */}
          <ConditionSection conditions={conditions} setConditions={setConditions} tags={tags} />

          {/* THEN */}
          <ActionSection
            actions={actions}
            setActions={setActions}
            providers={providers}
            providersLoaded={providersLoaded}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || !actions.some((a) => actionIsValid(a, providers, providersLoaded))}
          >
            {automation ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
