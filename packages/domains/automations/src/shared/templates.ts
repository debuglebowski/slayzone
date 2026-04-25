export interface TemplateContext {
  task?: {
    id: string
    name: string
    status: string
    priority: number
    worktree_path?: string | null
    branch?: string | null
    terminal_mode?: string | null
    terminal_mode_flags?: string | null
  }
  project?: {
    id: string
    name: string
    path: string
  }
  trigger?: {
    old_status?: string
    new_status?: string
  }
}

export function resolveTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_match, group: string, key: string) => {
    const obj = ctx[group as keyof TemplateContext]
    if (!obj || typeof obj !== 'object') return ''
    const value = (obj as Record<string, unknown>)[key]
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
  { name: 'task.terminal_mode', desc: 'Terminal mode' },
  { name: 'task.terminal_mode_flags', desc: 'Terminal mode flags' },
  { name: 'project.name', desc: 'Project name' },
  { name: 'project.path', desc: 'Project filesystem path' },
  { name: 'trigger.old_status', desc: 'Status before change' },
  { name: 'trigger.new_status', desc: 'Status after change' },
] as const
