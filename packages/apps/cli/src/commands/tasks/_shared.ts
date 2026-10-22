// Re-exported for existing call sites; implementation lives in a decoupled,
// unit-testable module (no CLI DB/api graph).
export { cliAuthor } from './cli-author'

export interface TaskRow extends Record<string, unknown> {
  id: string
  project_id: string
  title: string
  status: string
  priority: number
  project_name: string
  created_at: string
}

export interface TemplateRow extends Record<string, unknown> {
  id: string
  terminal_mode: string | null
  default_status: string | null
  default_priority: number | null
  provider_config: string | null
}

export function mergeTemplateProviderConfig(
  base: Record<string, { flags: string }>,
  template: TemplateRow | null
): Record<string, { flags: string }> {
  if (!template?.provider_config) return base
  try {
    const tpc = JSON.parse(template.provider_config) as Record<string, { flags?: string }>
    const merged = { ...base }
    for (const [mode, conf] of Object.entries(tpc)) {
      if (conf.flags !== undefined) merged[mode] = { ...merged[mode], flags: conf.flags }
    }
    return merged
  } catch {
    return base
  }
}

/**
 * Resolve the target task id: the explicit arg, else `$SLAYZONE_TASK_ID`. Every
 * agent has the latter — a pre-warmed one too, which boots with the id its task is
 * created under. Async only so callers keep one shape.
 */
export async function resolveId(explicit?: string): Promise<string> {
  const id = explicit ?? process.env.SLAYZONE_TASK_ID
  if (id) return id
  console.error('No task ID provided and $SLAYZONE_TASK_ID is not set.')
  process.exit(1)
}

/** Minimal shape printTasks renders — satisfied by both TaskRow and TaskJson. */
export interface PrintableTask {
  id: string
  status: string
  title: string
  project_name?: string | null
}

export function printTasks(tasks: PrintableTask[], blockedIds?: Set<string>) {
  if (tasks.length === 0) {
    console.log('No tasks found.')
    return
  }
  const idW = 9
  const statusW = 12
  console.log(`${'ID'.padEnd(idW)}  ${'STATUS'.padEnd(statusW)}  ${'PROJECT'.padEnd(16)}  TITLE`)
  console.log(`${'-'.repeat(idW)}  ${'-'.repeat(statusW)}  ${'-'.repeat(16)}  ${'-'.repeat(30)}`)
  for (const t of tasks) {
    const id = String(t.id).slice(0, 8).padEnd(idW)
    const status = String(t.status).padEnd(statusW)
    const project = String(t.project_name ?? '')
      .slice(0, 16)
      .padEnd(16)
    const prefix = blockedIds?.has(t.id) ? '[B] ' : ''
    console.log(`${id}  ${status}  ${project}  ${prefix}${t.title}`)
  }
}
