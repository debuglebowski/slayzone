import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { updateTaskOp } from '@slayzone/task/server'
import { isKnownStatus } from '@slayzone/projects/shared'
import { getProjectColumns, getAllowedStatusesText, resolveCurrentTaskId } from './shared'
import { NOOP_TASK_BUS } from '../rest-api/types'
import type { McpToolsDeps } from './types'

export function registerUpdateTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'update_task',
    "Update a task's details (title, description, status, priority, assignee, due date). Prefer calling get_current_task_id first, then pass that as task_id. In task terminals, you can source task_id from local $SLAYZONE_TASK_ID. If empty (pre-warmed agent), pass session_id from $SLAYZONE_SESSION_ID instead.",
    {
      task_id: z
        .string()
        .optional()
        .describe('The task ID to update (read from $SLAYZONE_TASK_ID env var)'),
      session_id: z
        .string()
        .optional()
        .describe('Fallback when $SLAYZONE_TASK_ID is empty — pass $SLAYZONE_SESSION_ID instead'),
      title: z.string().optional().describe('New title'),
      description: z.string().nullable().optional().describe('New description (null to clear)'),
      status: z.string().optional().describe('New status'),
      priority: z.number().min(1).max(5).optional().describe('Priority 1-5 (1=highest)'),
      assignee: z.string().nullable().optional().describe('Assignee name (null to clear)'),
      due_date: z.string().nullable().optional().describe('Due date ISO string (null to clear)'),
      parent_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Reparent task. String = new parent id (must be in same project, no cycles, not archived). null = detach to root.'
        ),
      close: z.boolean().optional().describe('Close the task tab in the UI')
    },
    async ({ task_id, session_id, due_date, parent_id, close, ...fields }) => {
      const resolvedTaskId = await resolveCurrentTaskId(deps.db, task_id, session_id)
      if (!resolvedTaskId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No task ID available. Pass task_id (from $SLAYZONE_TASK_ID) or session_id (from $SLAYZONE_SESSION_ID).'
            }
          ],
          isError: true
        }
      }

      if (fields.status !== undefined) {
        const taskRow = (await deps.db
          .prepare('SELECT project_id FROM tasks WHERE id = ?')
          .get(resolvedTaskId)) as { project_id: string } | undefined
        if (!taskRow) {
          return {
            content: [{ type: 'text' as const, text: `Task ${resolvedTaskId} not found` }],
            isError: true
          }
        }

        const projectColumns = await getProjectColumns(deps.db, taskRow.project_id)
        if (!isKnownStatus(fields.status, projectColumns)) {
          const allowed = getAllowedStatusesText(projectColumns)
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown status "${fields.status}" for task ${resolvedTaskId}. Allowed statuses: ${allowed}.`
              }
            ],
            isError: true
          }
        }
      }

      let updated
      try {
        updated = await updateTaskOp(
          deps.db,
          { id: resolvedTaskId, ...fields, dueDate: due_date, parentId: parent_id },
          { ipcMain: deps.taskBus ?? NOOP_TASK_BUS }
        )
      } catch (err) {
        return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
      }
      if (!updated) {
        return {
          content: [{ type: 'text' as const, text: `Task ${resolvedTaskId} not found` }],
          isError: true
        }
      }
      deps.notifyRenderer()
      if (close) {
        deps.menu?.emit('close-task', resolvedTaskId)
        deps.legacyBroadcast?.('app:close-task', resolvedTaskId) // slice 5: drop legacy send
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(updated, null, 2)
          }
        ]
      }
    }
  )
}
