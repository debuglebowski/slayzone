import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { updateTask } from '@slayzone/task/main'
import { getDefaultStatus, isKnownStatus } from '@slayzone/projects/shared'
import {
  resolveCurrentTaskId,
  getProjectColumns,
  getAllowedStatusesText,
  buildDefaultProviderConfig,
} from './shared'
import type { McpToolsDeps } from './types'

export function registerCreateSubtaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'create_subtask',
    'Create a subtask under a parent task. Prefer calling get_current_task_id first, then pass that as parent_task_id. In task terminals, you can source parent_task_id from local $SLAYZONE_TASK_ID.',
    {
      parent_task_id: z.string().optional().describe('Parent task ID (recommended: pass $SLAYZONE_TASK_ID)'),
      title: z.string().describe('Subtask title'),
      description: z.string().nullable().optional().describe('Subtask description (null to clear)'),
      status: z.string().optional().describe('Initial status (default: first non-terminal project status)'),
      priority: z.number().min(1).max(5).optional().describe('Priority 1-5 (1=highest, default: 3)'),
      assignee: z.string().nullable().optional().describe('Assignee name (null to clear)'),
      due_date: z.string().nullable().optional().describe('Due date ISO string (null to clear)')
    },
    async ({ parent_task_id, due_date, title, description, status, priority, assignee }) => {
      const resolvedParentId = resolveCurrentTaskId(parent_task_id)
      if (!resolvedParentId) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No parent task ID available. Pass parent_task_id (recommended from $SLAYZONE_TASK_ID).'
          }],
          isError: true
        }
      }

      const parent = deps.db.prepare('SELECT id, project_id, terminal_mode FROM tasks WHERE id = ?').get(resolvedParentId) as
        | { id: string; project_id: string; terminal_mode: string | null }
        | undefined

      if (!parent) {
        return {
          content: [{
            type: 'text' as const,
            text: `Parent task ${resolvedParentId} not found`
          }],
          isError: true
        }
      }

      const id = randomUUID()
      const terminalMode = parent.terminal_mode
        ?? (deps.db.prepare("SELECT value FROM settings WHERE key = 'default_terminal_mode'")
          .get() as { value: string } | undefined)?.value
        ?? 'claude-code'
      const providerConfig = buildDefaultProviderConfig(deps.db)
      const projectColumns = getProjectColumns(deps.db, parent.project_id)
      if (status && !isKnownStatus(status, projectColumns)) {
        const allowed = getAllowedStatusesText(projectColumns)
        return {
          content: [{
            type: 'text' as const,
            text: `Unknown status "${status}" for project ${parent.project_id}. Allowed statuses: ${allowed}.`
          }],
          isError: true
        }
      }
      const initialStatus =
        status ?? getDefaultStatus(projectColumns)

      deps.db.prepare(`
        INSERT INTO tasks (
          id, project_id, parent_id, title, description, assignee,
          status, priority, due_date, terminal_mode, provider_config,
          claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
          is_temporary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        parent.project_id,
        parent.id,
        title,
        description ?? null,
        assignee ?? null,
        initialStatus,
        priority ?? 3,
        due_date ?? null,
        terminalMode,
        JSON.stringify(providerConfig),
        providerConfig['claude-code']?.flags ?? '',
        providerConfig.codex?.flags ?? '',
        providerConfig['cursor-agent']?.flags ?? '',
        providerConfig.gemini?.flags ?? '',
        providerConfig.opencode?.flags ?? '',
        0
      )

      const created = updateTask(deps.db, { id })
      if (!created) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create subtask under ${resolvedParentId}` }],
          isError: true
        }
      }

      deps.notifyRenderer()
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(created, null, 2)
        }]
      }
    }
  )
}
