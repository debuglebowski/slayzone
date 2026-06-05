import type { Task } from '@slayzone/task/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { isTerminalStatus } from '@slayzone/projects/shared'
import type { Column } from './kanban'

export function formatSnoozeTimeLeft(until: string): string {
  const ms = new Date(until).getTime() - Date.now()
  if (ms <= 0) return '0m'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

export function computeSubTaskCounts(
  tasks: Task[],
  columns?: ColumnConfig[] | null
): Map<string, { done: number; total: number }> {
  const counts = new Map<string, { done: number; total: number }>()
  for (const t of tasks) {
    if (!t.parent_id) continue
    const entry = counts.get(t.parent_id) ?? { done: 0, total: 0 }
    entry.total++
    if (isTerminalStatus(t.status, columns)) entry.done++
    counts.set(t.parent_id, entry)
  }
  return counts
}

export function splitActiveInactiveColumns(
  baseTasks: Task[],
  activeTaskIds: Set<string>,
  showEmptyColumns: boolean
): Column[] {
  const active: Task[] = []
  const rest: Task[] = []
  for (const t of baseTasks) {
    if (activeTaskIds.has(t.id)) active.push(t)
    else rest.push(t)
  }
  const cols: Column[] = []
  if (active.length > 0 || showEmptyColumns)
    cols.push({ id: 'active', title: 'Active', tasks: active })
  if (rest.length > 0 || showEmptyColumns)
    cols.push({ id: 'inactive', title: 'Inactive', tasks: rest })
  return cols
}
