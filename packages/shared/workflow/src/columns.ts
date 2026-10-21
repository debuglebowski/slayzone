import {
  DEFAULT_COLUMNS,
  WORKFLOW_CATEGORIES,
  type ColumnConfig,
  type WorkflowCategory
} from './types'

export const TERMINAL_CATEGORIES: readonly WorkflowCategory[] = ['completed', 'canceled'] as const
export const DONE_CATEGORIES: readonly WorkflowCategory[] = ['completed'] as const
const CATEGORY_ORDER = new Map(WORKFLOW_CATEGORIES.map((category, index) => [category, index]))

function isValidCategory(category: unknown): category is WorkflowCategory {
  return typeof category === 'string' && WORKFLOW_CATEGORIES.includes(category as WorkflowCategory)
}

function cloneColumns(columns: ColumnConfig[]): ColumnConfig[] {
  return columns.map((column) => ({ ...column }))
}

export function sortColumns(columns: ColumnConfig[]): ColumnConfig[] {
  return [...columns].sort((a, b) => {
    const aCategoryOrder =
      CATEGORY_ORDER.get(a.category as WorkflowCategory) ?? Number.MAX_SAFE_INTEGER
    const bCategoryOrder =
      CATEGORY_ORDER.get(b.category as WorkflowCategory) ?? Number.MAX_SAFE_INTEGER
    if (aCategoryOrder !== bCategoryOrder) return aCategoryOrder - bCategoryOrder
    if (a.position !== b.position) return a.position - b.position
    return String(a.id ?? '').localeCompare(String(b.id ?? ''))
  })
}

export function validateColumns(columns: ColumnConfig[]): ColumnConfig[] {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('Project must have at least one status column')
  }

  const seenIds = new Set<string>()
  const normalized = sortColumns(columns).map((col, index) => {
    const id = col.id?.trim()
    const label = col.label?.trim()
    const color = col.color?.trim()

    if (!id) throw new Error('Status column id is required')
    if (!label) throw new Error(`Status column "${id}" must have a label`)
    if (!color) throw new Error(`Status column "${id}" must have a color`)
    if (!isValidCategory(col.category)) {
      throw new Error(`Status column "${id}" has invalid category "${String(col.category)}"`)
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate status column id "${id}"`)
    }
    seenIds.add(id)

    return {
      id,
      label,
      color,
      position: index,
      category: col.category
    }
  })

  const hasCompleted = normalized.some((c) => isCompletedCategory(c.category))
  if (!hasCompleted) {
    throw new Error('Project must have at least one completed status column')
  }

  const hasNonTerminal = normalized.some((c) => !isTerminalCategory(c.category))
  if (!hasNonTerminal) {
    throw new Error('Project must have at least one non-terminal status column')
  }

  return normalized
}

export function parseColumnsConfig(raw: unknown): ColumnConfig[] | null {
  if (raw == null) return null

  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }

  if (!Array.isArray(parsed)) return null

  try {
    return validateColumns(parsed as ColumnConfig[])
  } catch {
    return null
  }
}

export function resolveColumns(config: ColumnConfig[] | null | undefined): ColumnConfig[] {
  if (!config) return cloneColumns(DEFAULT_COLUMNS)
  try {
    return validateColumns(config)
  } catch {
    return cloneColumns(DEFAULT_COLUMNS)
  }
}

export function getColumnById(
  statusId: string,
  columns: ColumnConfig[] | null | undefined
): ColumnConfig | null {
  return resolveColumns(columns).find((column) => column.id === statusId) ?? null
}

export function getStatusByCategory(
  category: WorkflowCategory,
  columns: ColumnConfig[] | null | undefined
): string | null {
  return resolveColumns(columns).find((column) => column.category === category)?.id ?? null
}

export function getStatusByCategories(
  categories: readonly WorkflowCategory[],
  columns: ColumnConfig[] | null | undefined
): string | null {
  for (const category of categories) {
    const match = getStatusByCategory(category, columns)
    if (match) return match
  }
  return null
}

export function isCompletedCategory(category: WorkflowCategory): boolean {
  return DONE_CATEGORIES.includes(category)
}

export function isTerminalCategory(category: WorkflowCategory): boolean {
  return TERMINAL_CATEGORIES.includes(category)
}

export function isTerminalStatus(
  statusId: string,
  columns: ColumnConfig[] | null | undefined
): boolean {
  const column = getColumnById(statusId, columns)
  if (column) return isTerminalCategory(column.category)
  return statusId === 'done'
}

export function isCompletedStatus(
  statusId: string,
  columns: ColumnConfig[] | null | undefined
): boolean {
  const column = getColumnById(statusId, columns)
  if (column) return isCompletedCategory(column.category)
  return statusId === 'done'
}

export function getFirstCompletedStatus(columns: ColumnConfig[] | null | undefined): string | null {
  return getStatusByCategories(DONE_CATEGORIES, columns)
}

export function getFirstNonTerminalStatus(columns: ColumnConfig[] | null | undefined): string {
  const match = resolveColumns(columns).find((column) => !isTerminalCategory(column.category))
  return match?.id ?? 'inbox'
}

export function getDefaultStatus(columns: ColumnConfig[] | null | undefined): string {
  return getFirstNonTerminalStatus(columns)
}

export function getDoneStatus(columns: ColumnConfig[] | null | undefined): string {
  return getFirstCompletedStatus(columns) ?? 'done'
}

export function isKnownStatus(
  statusId: string,
  columns: ColumnConfig[] | null | undefined
): boolean {
  return resolveColumns(columns).some((column) => column.id === statusId)
}

/**
 * The statuses valid in EVERY one of several projects — what a bulk status change
 * across them may offer. Each project's columns are resolved exactly as the backend
 * validates a status (`isKnownStatus`: missing/invalid config → defaults); the
 * result is the first project's columns whose id every project has. Empty when
 * they share none (or no project is given).
 */
export function getSharedStatusColumns(
  columnSets: ReadonlyArray<ColumnConfig[] | null | undefined>
): ColumnConfig[] {
  if (columnSets.length === 0) return []
  const [first, ...rest] = columnSets.map((columns) => resolveColumns(columns))
  return first.filter((column) => rest.every((columns) => columns.some((c) => c.id === column.id)))
}

export function normalizeStatusOrDefault(
  statusId: string,
  columns: ColumnConfig[] | null | undefined
): string {
  return isKnownStatus(statusId, columns) ? statusId : getDefaultStatus(columns)
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[\s_]+/g, '-')
}

export function resolveStatusId(
  input: string,
  columns: ColumnConfig[] | null | undefined
): string | null {
  const resolved = resolveColumns(columns)
  const byId = resolved.find((col) => col.id === input)
  if (byId) return byId.id
  const lower = input.toLowerCase()
  const byLabel = resolved.find((col) => col.label.toLowerCase() === lower)
  if (byLabel) return byLabel.id
  const slug = slugify(input)
  const bySlug = resolved.find((col) => slugify(col.label) === slug)
  if (bySlug) return bySlug.id
  return null
}
