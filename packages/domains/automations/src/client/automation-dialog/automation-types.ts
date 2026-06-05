import type {
  Automation,
  CreateAutomationInput,
  UpdateAutomationInput
} from '@slayzone/automations/shared'

export interface AiProviderOption {
  id: string
  label: string
  type: string
  defaultFlags: string
  headlessCommand: string
}

export interface AutomationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  automation?: Automation | null
  projectId: string
  tags: Array<{ id: string; name: string }>
  onSave: (data: CreateAutomationInput | UpdateAutomationInput) => void
}

// --- Condition presets ---

export type ConditionPresetType = 'status_is_some' | 'priority_is_some' | 'tags_contains_some'

export interface ConditionPreset {
  key: ConditionPresetType
  label: string
}
