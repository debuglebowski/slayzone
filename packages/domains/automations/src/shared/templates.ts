export interface TemplateContext {
  task?: {
    id: string
    name: string
    status: string
    priority: number
    worktree_path?: string | null
    branch?: string | null
    agent_id?: string | null
    agent_flags?: string | null
  }
  project?: {
    id: string
    name: string
    /** The project's folder on the computer sharing the hub's machine; null = none. */
    path: string | null
  }
  trigger?: {
    old_status?: string
    new_status?: string
  }
}

/**
 * Retired variable names → their current key, per group. User-authored
 * automations stored in the DB still reference the old names, so they keep
 * resolving; they are not listed in {@link TEMPLATE_VARIABLES}.
 */
const LEGACY_TEMPLATE_KEYS: Partial<Record<keyof TemplateContext, Record<string, string>>> = {
  task: {
    terminal_mode: 'agent_id',
    terminal_mode_flags: 'agent_flags'
  }
}

export function resolveTemplate(template: unknown, ctx: TemplateContext): string {
  if (typeof template !== 'string') return ''
  return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_match, group: string, key: string) => {
    const obj = ctx[group as keyof TemplateContext]
    if (!obj || typeof obj !== 'object') return ''
    const resolvedKey = LEGACY_TEMPLATE_KEYS[group as keyof TemplateContext]?.[key] ?? key
    const value = (obj as Record<string, unknown>)[resolvedKey]
    return value != null ? String(value) : ''
  })
}

export const TEMPLATE_VARIABLES: readonly { name: string; desc: string }[] = [
  { name: 'task.id', desc: 'Task ID' },
  { name: 'task.name', desc: 'Task name' },
  { name: 'task.status', desc: 'Current status' },
  { name: 'task.priority', desc: 'Priority 1-5' },
  { name: 'task.worktree_path', desc: 'Git worktree path' },
  { name: 'task.branch', desc: 'Git branch' },
  { name: 'task.agent_id', desc: 'Agent' },
  { name: 'task.agent_flags', desc: 'Agent flags' },
  { name: 'project.name', desc: 'Project name' },
  { name: 'project.path', desc: 'Project filesystem path' },
  { name: 'trigger.old_status', desc: 'Status before change' },
  { name: 'trigger.new_status', desc: 'Status after change' }
] as const
