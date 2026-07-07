import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { deleteTaskOp } from '@slayzone/task/server'
import { deleteTaskInputSchema } from '@slayzone/task/shared'
import { NOOP_TASK_BUS } from '../rest-api/types'
import { resolveCurrentTaskId } from './shared'
import type { McpToolsDeps } from './types'

export function registerDeleteTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'delete_task',
    'Permanently delete a task (soft-delete via deleted_at). Accepts a task id. In task terminals, source from $SLAYZONE_TASK_ID. If empty (pre-warmed agent), pass session_id from $SLAYZONE_SESSION_ID instead. Fails if the task is linked to an external provider.',
    {
      ...deleteTaskInputSchema.shape,
      id: deleteTaskInputSchema.shape.id.optional(),
      session_id: z
        .string()
        .optional()
        .describe('Fallback when $SLAYZONE_TASK_ID is empty — pass $SLAYZONE_SESSION_ID instead')
    },
    async ({ id, session_id }) => {
      const resolvedId = await resolveCurrentTaskId(deps.db, id, session_id)
      if (!resolvedId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No task ID available. Pass id (from $SLAYZONE_TASK_ID) or session_id (from $SLAYZONE_SESSION_ID).'
            }
          ],
          isError: true
        }
      }

      let result
      try {
        result = await deleteTaskOp(deps.db, resolvedId, {
          ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
          onMutation: deps.notifyRenderer
        })
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true
        }
      }

      if (result === false) {
        return {
          content: [{ type: 'text' as const, text: `Task ${resolvedId} not found` }],
          isError: true
        }
      }

      if (typeof result === 'object' && result.blocked) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task ${resolvedId} cannot be deleted: linked to an external provider. Unlink first.`
            }
          ],
          isError: true
        }
      }

      deps.notifyRenderer()
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ id: resolvedId, deleted: true }, null, 2)
          }
        ]
      }
    }
  )
}
