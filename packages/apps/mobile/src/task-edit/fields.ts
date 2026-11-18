/**
 * A task's editable fields as choices, the way desktop offers them: status from the
 * project's own columns (`@slayzone/workflow`, the board's workflow), desktop's five
 * priorities, quick due dates, and templates on create. Pure: no React, no hub.
 */
import type { TaskTemplate } from '@slayzone/task-contracts'
import { addDaysISO, PRIORITY_LABELS } from '@slayzone/tasks/board'
import { type ColumnConfig, isKnownStatus, resolveColumns } from '@slayzone/workflow'
import type { BoardProject } from '../hub-board'

export interface FieldChoice {
  key: string
  label: string
}

/** The project's columns in their order (no columns of its own: the default workflow). */
export function statusChoices(project: BoardProject | undefined): FieldChoice[] {
  return resolveColumns(project?.columns_config).map((c) => ({ key: c.id, label: c.label }))
}

export function statusLabel(status: string, project: BoardProject | undefined): string {
  return resolveColumns(project?.columns_config).find((c) => c.id === status)?.label ?? status
}

export const PRIORITY_CHOICES: readonly FieldChoice[] = Object.entries(PRIORITY_LABELS)
  .map(([key, label]) => ({ key, label }))
  .sort((a, b) => Number(a.key) - Number(b.key))

export const priorityLabel = (priority: number): string =>
  PRIORITY_LABELS[priority] ?? `P${priority}`

export interface DueChoice extends FieldChoice {
  /** `YYYY-MM-DD`; null = no due date. */
  date: string | null
}

/** Quick due dates from `today` (`YYYY-MM-DD`); any other day is picked on the calendar. */
export function dueChoices(today: string): DueChoice[] {
  return [
    { key: 'none', label: 'No due date', date: null },
    { key: 'today', label: 'Today', date: today },
    { key: 'tomorrow', label: 'Tomorrow', date: addDaysISO(today, 1) },
    { key: 'week', label: 'In a week', date: addDaysISO(today, 7) }
  ]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A `YYYY-MM-DD` day the short way ("Nov 18"; "Dec 31, 2025" when not `today`'s year). */
export function formatDay(day: string, today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined
  if (!m || !month) return day
  const short = `${month} ${Number(m[3])}`
  return m[1] === today.slice(0, 4) ? short : `${short}, ${m[1]}`
}

export function dueLabel(due: string | null, today: string): string {
  if (!due) return 'No due date'
  if (due === today) return 'Due today'
  if (due === addDaysISO(today, 1)) return 'Due tomorrow'
  if (due < today) return `Overdue: ${formatDay(due, today)}`
  return `Due ${formatDay(due, today)}`
}

/** A due date on a card: Yesterday / Today / Tomorrow, else the short day. */
export function dueDayLabel(due: string, today: string): string {
  if (due === today) return 'Today'
  if (due === addDaysISO(today, 1)) return 'Tomorrow'
  if (due === addDaysISO(today, -1)) return 'Yesterday'
  return formatDay(due, today)
}

/** A typed due date: `YYYY-MM-DD` naming a real day, else null. */
export function parseDueDate(text: string): string | null {
  const value = text.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return date.toISOString().slice(0, 10) === value ? value : null
}

/** The template choice key of "no template". */
export const NO_TEMPLATE = '__none__'

/**
 * The project's templates as choices, and the one preselected. The hub applies the
 * template a create names, else the project's default (`getTemplateForTask`): with a
 * default there is no way to create without one (desktop's "None" sends nothing, and the
 * default applies anyway), so "No template" is offered only when the project has none.
 */
export function templateChoices(templates: readonly TaskTemplate[]): {
  choices: FieldChoice[]
  initial: string
} {
  if (templates.length === 0) return { choices: [], initial: NO_TEMPLATE }
  const byTemplate = templates.map((t) => ({ key: t.id, label: t.name }))
  const fallback = templates.find((t) => t.is_default)
  if (fallback) return { choices: byTemplate, initial: fallback.id }
  return {
    choices: [{ key: NO_TEMPLATE, label: 'No template' }, ...byTemplate],
    initial: NO_TEMPLATE
  }
}

/**
 * What a template fills in on create, as desktop's dialog does (its status when the
 * project has it, its priority) — except a field the user chose, or the screen was opened
 * with (a column's "+" names its status).
 */
export function applyTemplate(
  fields: { status: string; priority: number },
  template: TaskTemplate | undefined,
  columns: ColumnConfig[] | null | undefined,
  explicit: { status: boolean; priority: boolean }
): { status: string; priority: number } {
  if (!template) return fields
  const status =
    !explicit.status && template.default_status && isKnownStatus(template.default_status, columns)
      ? template.default_status
      : fields.status
  const priority =
    !explicit.priority && template.default_priority != null
      ? template.default_priority
      : fields.priority
  return { status, priority }
}

/** A `YYYY-MM-DD` day as a Date at that day's local midnight (what a date picker shows). */
export function dateOfDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

/** The local calendar day of `date`, as `YYYY-MM-DD` (what a date picker picked). */
export function dayOfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
