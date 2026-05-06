import type { Database } from 'better-sqlite3'
import {
  getColumnById,
  getDefaultStatus,
  getDoneStatus,
  getStatusByCategories,
  parseColumnsConfig,
  type ColumnConfig
} from '@slayzone/workflow'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'

export function toMs(value: string | null | undefined): number {
  if (!value) return 0
  let normalized = value
  if (normalized.includes(' ') && !normalized.includes('T')) {
    normalized = normalized.replace(' ', 'T') + 'Z'
  }
  const ts = Date.parse(normalized)
  return Number.isNaN(ts) ? 0 : ts
}

export function getProjectColumns(db: Database, projectId: string): ColumnConfig[] | null {
  const row = db.prepare('SELECT columns_config FROM projects WHERE id = ?').get(projectId) as
    | { columns_config: string | null }
    | undefined
  return parseColumnsConfig(row?.columns_config)
}

export function normalizeMarkdown(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

export function localStatusToGitHubState(status: string, columns: ColumnConfig[] | null): 'open' | 'closed' {
  const column = getColumnById(status, columns)
  if (!column) return 'open'
  return column.category === 'completed' || column.category === 'canceled' ? 'closed' : 'open'
}

export function githubStateToLocal(state: 'open' | 'closed', columns: ColumnConfig[] | null): string {
  if (state === 'closed') {
    return getStatusByCategories(['completed', 'canceled'], columns) ?? getDoneStatus(columns)
  }
  return getStatusByCategories(['unstarted', 'triage', 'backlog'], columns) ?? getDefaultStatus(columns)
}

export function parseGitHubExternalKey(externalKey: string): { owner: string; repo: string; number: number } | null {
  const match = externalKey.match(/^([^/]+)\/([^#]+)#(\d+)$/)
  if (!match) return null
  const number = Number.parseInt(match[3], 10)
  if (!Number.isFinite(number)) return null
  return { owner: match[1], repo: match[2], number }
}

export function upsertFieldState(db: Database, externalLinkId: string, field: string, localValue: unknown, externalValue: unknown, localUpdatedAt: string, externalUpdatedAt: string): void {
  db.prepare(`
    INSERT INTO external_field_state (
      id, external_link_id, field_name, last_local_value_json, last_external_value_json,
      last_local_updated_at, last_external_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(external_link_id, field_name) DO UPDATE SET
      last_local_value_json = excluded.last_local_value_json,
      last_external_value_json = excluded.last_external_value_json,
      last_local_updated_at = excluded.last_local_updated_at,
      last_external_updated_at = excluded.last_external_updated_at,
      updated_at = datetime('now')
  `).run(
    crypto.randomUUID(),
    externalLinkId,
    field,
    JSON.stringify(localValue),
    JSON.stringify(externalValue),
    localUpdatedAt,
    externalUpdatedAt
  )
}

export function linearStateToTaskStatus(stateType: string, columns: ColumnConfig[] | null): string {
  switch (stateType) {
    case 'backlog':
      return getStatusByCategories(['backlog', 'unstarted', 'triage'], columns) ?? getDefaultStatus(columns)
    case 'started':
      return getStatusByCategories(['started'], columns) ?? getDefaultStatus(columns)
    case 'completed':
      return getStatusByCategories(['completed'], columns) ?? getDoneStatus(columns)
    case 'canceled':
      return getStatusByCategories(['canceled', 'completed'], columns) ?? getDoneStatus(columns)
    case 'unstarted':
      return getStatusByCategories(['unstarted', 'triage', 'backlog'], columns) ?? getDefaultStatus(columns)
    case 'triage':
      return getStatusByCategories(['triage', 'unstarted', 'backlog'], columns) ?? getDefaultStatus(columns)
    default:
      return getDefaultStatus(columns)
  }
}

export function linearPriorityToLocal(priority: number): number {
  if (priority <= 1) return 5
  if (priority === 2) return 4
  if (priority === 3) return 3
  if (priority === 4) return 2
  if (priority >= 5) return 1
  return 3
}

export function localPriorityToLinear(priority: number): number {
  if (priority <= 1) return 4
  if (priority === 2) return 4
  if (priority === 3) return 3
  if (priority === 4) return 2
  if (priority >= 5) return 1
  return 3
}

export function buildDefaultProviderConfig(db: Database): { json: string; claudeFlags: string; codexFlags: string } {
  let rows: Array<{ id: string; default_flags: string | null }> = []
  try {
    rows = db.prepare('SELECT id, default_flags FROM terminal_modes WHERE enabled = 1').all() as Array<{ id: string; default_flags: string | null }>
  } catch {
    rows = []
  }
  if (rows.length === 0) {
    rows = DEFAULT_TERMINAL_MODES
      .filter((mode) => mode.enabled)
      .map((mode) => ({ id: mode.id, default_flags: mode.defaultFlags ?? '' }))
  }

  const config: Record<string, { flags: string }> = {}
  for (const row of rows) {
    config[row.id] = { flags: row.default_flags ?? '' }
  }

  return {
    json: JSON.stringify(config),
    claudeFlags: config['claude-code']?.flags ?? '',
    codexFlags: config['codex']?.flags ?? ''
  }
}
