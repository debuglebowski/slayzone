import type { TriggerConfig, ActionConfig } from '@slayzone/automations/shared'
import type { ConditionPreset } from './automation-types'

export const CONDITION_PRESETS: ConditionPreset[] = [
  { key: 'status_is_some', label: 'Task status is any of...' },
  { key: 'priority_is_some', label: 'Task priority is any of...' },
  { key: 'tags_contains_some', label: 'Task tags contains any of...' }
]

export const PRIORITY_OPTIONS = [
  { value: '1', label: 'Urgent' },
  { value: '2', label: 'High' },
  { value: '3', label: 'Medium' },
  { value: '4', label: 'Low' },
  { value: '5', label: 'None' }
]

export const EMPTY_TRIGGER: TriggerConfig = { type: 'task_status_change', params: {} }
export const EMPTY_RUN_COMMAND: ActionConfig = { type: 'run_command', params: { command: '' } }

export const CRON_PRESETS = [
  ['*/15 * * * *', 'Every 15 min'],
  ['0 * * * *', 'Every hour'],
  ['0 9 * * *', 'Daily at 9am'],
  ['0 9 * * 1-5', 'Weekdays at 9am'],
  ['0 0 * * 0', 'Weekly (Sun midnight)']
] as const
