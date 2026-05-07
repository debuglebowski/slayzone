import { parseColumnsConfig } from '@slayzone/projects/shared'
import type { Project } from '@slayzone/projects/shared'

export function parseProject(row: Record<string, unknown> | undefined): Project | null {
  if (!row) return null
  return {
    ...row,
    columns_config: parseColumnsConfig(row.columns_config),
    execution_context: row.execution_context ? (() => { try { return JSON.parse(row.execution_context as string) } catch { return null } })() : null,
    task_automation_config: row.task_automation_config ? (() => { try { return JSON.parse(row.task_automation_config as string) } catch { return null } })() : null,
    lock_config: row.lock_config ? (() => { try { return JSON.parse(row.lock_config as string) } catch { return null } })() : null
  } as Project
}
