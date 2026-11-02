import type { Task } from '@slayzone/task-contracts'
import type { ColumnConfig } from '@slayzone/projects-contracts'
import { isTerminalStatus } from '@slayzone/projects-contracts'

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

// Lives with the board's DOM-free grouping logic (`./kanban`, `@slayzone/tasks/board`).
export { splitActiveInactiveColumns } from './kanban'
