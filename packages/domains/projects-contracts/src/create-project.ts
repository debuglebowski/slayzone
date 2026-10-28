import type { ColumnConfig } from './types'
import { validateColumns } from './columns'
// The narrow subpath, not the `@slayzone/ui` barrel: this file is isomorphic
// (also imported server-side), and the barrel re-exports the whole React
// component kit — this subpath is a handful of side-effect-free functions.
import { safeRandomUUID } from '@slayzone/ui/secure-context'

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

function normalizeProjectName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Project name cannot be empty.')
  }
  return trimmed
}

function normalizeProjectColor(color: string): string {
  const trimmed = color.trim()
  if (!HEX_COLOR_RE.test(trimmed)) {
    throw new Error(`Invalid color "${color}". Expected format: #RRGGBB`)
  }
  return trimmed
}

interface PrepareProjectCreateInput {
  name: string
  color: string
  path?: string | null
  columnsConfig?: ColumnConfig[] | null
}

export interface PreparedProjectCreate {
  id: string
  name: string
  color: string
  path: string | null
  columnsConfig: ColumnConfig[] | null
  columnsConfigJson: string | null
  createdAt: string
  updatedAt: string
}

export function prepareProjectCreate(input: PrepareProjectCreateInput): PreparedProjectCreate {
  const columnsConfig = input.columnsConfig ? validateColumns(input.columnsConfig) : null
  const name = normalizeProjectName(input.name)
  const color = normalizeProjectColor(input.color)
  const path = typeof input.path === 'string' ? input.path.trim() || null : (input.path ?? null)
  const now = new Date().toISOString()

  return {
    id: safeRandomUUID(),
    name,
    color,
    path,
    columnsConfig,
    columnsConfigJson: columnsConfig ? JSON.stringify(columnsConfig) : null,
    createdAt: now,
    updatedAt: now
  }
}
