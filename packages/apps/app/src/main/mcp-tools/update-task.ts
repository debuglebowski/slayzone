import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { updateTaskOp } from '@slayzone/task/main'
import { isKnownStatus } from '@slayzone/projects/shared'
import { broadcastToWindows } from '../broadcast-to-windows'
import { getProjectColumns, getAllowedStatusesText } from './shared'
import type { McpToolsDeps } from './types'

export function registerUpdateTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'update_task',
    'Update a task\'s details (title, description, status, priority, assignee, due date). Prefer calling get_current_task_id first, then pass that as task_id. In task terminals, you can source task_id from local $SLAYZONE_TASK_ID.',
    {
      task_id: z.string().describe('The task ID to update (read from $SLAYZONE_TASK_ID env var)'),
      title: z.string().optional().describe('New title'),
      description: z.string().nullable().optional().describe('New description (null to clear)'),
      status: z.string().optional().describe('New status'),
      priority: z.number().min(1).max(5).optional().describe('Priority 1-5 (1=highest)'),
      assignee: z.string().nullable().optional().describe('Assignee name (null to clear)'),
      due_date: z.string().nullable().optional().describe('Due date ISO string (null to clear)'),
      parent_id: z.string().nullable().optional().describe('Reparent task. String = new parent id (must be in same project, no cycles, not archived). null = detach to root.'),
      close: z.boolean().optional().describe('Close the task tab in the UI')
    },
    async ({ task_id, due_date, parent_id, close, ...fields }) => {
      if (fields.status !== undefined) {
        const taskRow = deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(task_id) as
          | { project_id: string }
          | undefined
        if (!taskRow) {
          return { content: [{ type: 'text' as const, text: `Task ${task_id} not found` }], isError: true }
        }

        const projectColumns = getProjectColumns(deps.db, taskRow.project_id)
        if (!isKnownStatus(fields.status, projectColumns)) {
          const allowed = getAllowedStatusesText(projectColumns)
          return {
            content: [{
              type: 'text' as const,
              text: `Unknown status "${fields.status}" for task ${task_id}. Allowed statuses: ${allowed}.`
            }],
            isError: true
          }
        }
      }

      let updated
      try {
        updated = await updateTaskOp(
          deps.db,
          { id: task_id, ...fields, dueDate: due_date, parentId: parent_id },
          { ipcMain }
        )
      } catch (err) {
        return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
      }
      if (!updated) {
        return { content: [{ type: 'text' as const, text: `Task ${task_id} not found` }], isError: true }
      }
      deps.notifyRenderer()
      if (close) {
        broadcastToWindows('app:close-task', task_id)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(updated, null, 2)
        }]
      }
    }
  )
}
