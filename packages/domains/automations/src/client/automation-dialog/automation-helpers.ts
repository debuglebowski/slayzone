import type {
  TriggerConfig,
  ConditionConfig,
  ActionConfig
} from '@slayzone/automations/shared'
import type { AiProviderOption, ConditionPresetType } from './automation-types'

export function triggerDescription(trigger: TriggerConfig): string {
  switch (trigger.type) {
    case 'task_status_change': {
      const from = trigger.params.fromStatus as string | undefined
      const to = trigger.params.toStatus as string | undefined
      if (from && to) return `Runs when a task moves from "${from}" to "${to}"`
      if (to) return `Runs when a task moves to "${to}"`
      if (from) return `Runs when a task leaves "${from}"`
      return 'Runs whenever a task changes status'
    }
    case 'task_created':
      return 'Runs when a new task is created in this project'
    case 'task_archived':
      return 'Runs when a task is archived'
    case 'task_tag_changed':
      return 'Runs when tags are added or removed from a task'
    case 'cron': {
      const expr = trigger.params.expression as string | undefined
      return expr ? `Runs on schedule: ${expr}` : 'Runs on a recurring schedule'
    }
    case 'manual':
      return 'Runs only when you click the play button'
    default:
      return ''
  }
}

export function conditionToPresetKey(c: ConditionConfig): ConditionPresetType {
  const field = c.params.field as string
  if (field === 'status') return 'status_is_some'
  if (field === 'priority') return 'priority_is_some'
  if (field === 'tags') return 'tags_contains_some'
  return 'status_is_some'
}

export function presetToCondition(key: ConditionPresetType): ConditionConfig {
  switch (key) {
    case 'status_is_some':
      return { type: 'task_property', params: { field: 'status', operator: 'in', value: [] } }
    case 'priority_is_some':
      return { type: 'task_property', params: { field: 'priority', operator: 'in', value: [] } }
    case 'tags_contains_some':
      return { type: 'task_property', params: { field: 'tags', operator: 'in', value: [] } }
  }
}

// Multi-select toggle helper
export function toggleValue(arr: string[], val: string): string[] {
  return arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]
}

export function newAiAction(provider: AiProviderOption | undefined): ActionConfig {
  return {
    type: 'ai',
    params: {
      provider: provider?.id ?? '',
      prompt: '',
      flags: provider?.defaultFlags ?? ''
    }
  }
}

// Validity is provider-aware: an AI action with a stale/disabled provider id
// fails validation so Save disables and the engine never runs it. Skip the
// existence check while providers haven't loaded to avoid Save flicker when
// editing an existing automation.
export function actionIsValid(
  action: ActionConfig,
  providers: AiProviderOption[],
  providersLoaded: boolean
): boolean {
  if (action.type === 'ai') {
    const providerId = (action.params.provider as string)?.trim()
    if (!providerId) return false
    if (!(action.params.prompt as string)?.trim()) return false
    if (providersLoaded && !providers.some((p) => p.id === providerId)) return false
    // Mirror engine's shell-injection guard so Save disables locally.
    if (((action.params.flags as string) ?? '').includes('{{')) return false
    return true
  }
  return !!(action.params.command as string)?.trim()
}
