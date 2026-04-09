/**
 * Task status styling - shared across all components
 */
import type { LucideIcon } from 'lucide-react'
import { Inbox, CircleDashed, Circle, CircleDot, Eye, CircleCheck, CircleX } from 'lucide-react'

export type TaskStatusStyle = {
  bg: string
  text: string
  label: string
  icon: LucideIcon
  iconClass: string
}

const TASK_STATUS_STYLES: Record<string, TaskStatusStyle> = {
  inbox: { bg: 'bg-gray-200', text: 'text-gray-700', label: 'Inbox', icon: Inbox, iconClass: 'text-gray-500' },
  backlog: { bg: 'bg-slate-200', text: 'text-slate-700', label: 'Backlog', icon: CircleDashed, iconClass: 'text-slate-400' },
  todo: { bg: 'bg-blue-200', text: 'text-blue-700', label: 'Todo', icon: Circle, iconClass: 'text-blue-500' },
  in_progress: { bg: 'bg-yellow-200', text: 'text-yellow-700', label: 'In Progress', icon: CircleDot, iconClass: 'text-yellow-500' },
  review: { bg: 'bg-purple-200', text: 'text-purple-700', label: 'Review', icon: Eye, iconClass: 'text-purple-500' },
  done: { bg: 'bg-green-200', text: 'text-green-700', label: 'Done', icon: CircleCheck, iconClass: 'text-green-500' },
  canceled: { bg: 'bg-slate-200', text: 'text-slate-700', label: 'Canceled', icon: CircleX, iconClass: 'text-slate-500' }
}

const COLOR_MAP: Record<string, { bg: string; text: string; iconClass: string }> = {
  gray: { bg: 'bg-gray-200', text: 'text-gray-700', iconClass: 'text-gray-500' },
  slate: { bg: 'bg-slate-200', text: 'text-slate-700', iconClass: 'text-slate-500' },
  blue: { bg: 'bg-blue-200', text: 'text-blue-700', iconClass: 'text-blue-500' },
  yellow: { bg: 'bg-yellow-200', text: 'text-yellow-700', iconClass: 'text-yellow-500' },
  purple: { bg: 'bg-purple-200', text: 'text-purple-700', iconClass: 'text-purple-500' },
  green: { bg: 'bg-green-200', text: 'text-green-700', iconClass: 'text-green-500' },
  red: { bg: 'bg-red-200', text: 'text-red-700', iconClass: 'text-red-500' },
  orange: { bg: 'bg-orange-200', text: 'text-orange-700', iconClass: 'text-orange-500' }
}

export interface ColumnStatusConfig {
  id: string
  label: string
  color: string
  position: number
  category?: string
}

function getCategoryIcon(category?: string): LucideIcon {
  switch (category) {
    case 'triage':
      return Inbox
    case 'backlog':
      return CircleDashed
    case 'unstarted':
      return Circle
    case 'started':
      return CircleDot
    case 'completed':
      return CircleCheck
    case 'canceled':
      return CircleX
    default:
      return Circle
  }
}

export function getTaskStatusStyle(status: string | undefined): TaskStatusStyle | null {
  if (!status) return null
  return TASK_STATUS_STYLES[status] ?? null
}

export function getColumnStatusStyle(
  status: string | undefined,
  columns?: ColumnStatusConfig[] | null
): TaskStatusStyle | null {
  if (!status) return null
  const column = columns?.find((item) => item.id === status)
  if (!column) return getTaskStatusStyle(status)
  const color = COLOR_MAP[column.color] ?? COLOR_MAP.gray
  return {
    bg: color.bg,
    text: color.text,
    label: column.label,
    icon: getCategoryIcon(column.category),
    iconClass: color.iconClass
  }
}

export const TASK_STATUS_ORDER = [
  'inbox',
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'canceled'
] as const

export const taskStatusOptions = TASK_STATUS_ORDER.map((status) => ({
  value: status,
  label: TASK_STATUS_STYLES[status].label
}))

export type StatusOption = { value: string; label: string; icon: LucideIcon; iconClass: string }

export function buildStatusOptions(columns?: ColumnStatusConfig[] | null): StatusOption[] {
  if (!columns || columns.length === 0) {
    return TASK_STATUS_ORDER.map((status) => {
      const s = TASK_STATUS_STYLES[status]
      return { value: status, label: s.label, icon: s.icon, iconClass: s.iconClass }
    })
  }
  return [...columns]
    .sort((a, b) => a.position - b.position)
    .map((column) => {
      const color = COLOR_MAP[column.color] ?? COLOR_MAP.gray
      return {
        value: column.id,
        label: column.label,
        icon: getCategoryIcon(column.category),
        iconClass: color.iconClass
      }
    })
}
