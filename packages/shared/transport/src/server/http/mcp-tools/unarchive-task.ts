import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { unarchiveTaskOp } from '@slayzone/task/server'
import { unarchiveInputSchema } from '@slayzone/task/shared'
import { NOOP_TASK_BUS } from '../rest-api/types'
import { resolveCurrentTaskId } from './shared'
import type { McpToolsDeps } from './types'

export function registerUnarchiveTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'unarchive_task',
    'Unarchive a task (restores from archive back to the kanban). Accepts a task id. In task terminals, source from $SLAYZONE_TASK_ID. If empty (pre-warmed agent), pass session_id from $SLAYZONE_SESSION_ID instead.',
    {
      ...unarchiveInputSchema.shape,
      id: unarchiveInputSchema.shape.id.optional(),
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
      let unarchived
      try {
        unarchived = await unarchiveTaskOp(deps.db, resolvedId, {
          ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
          onMutation: deps.notifyRenderer
        })
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true
        }
      }
      if (!unarchived) {
        return {
          content: [{ type: 'text' as const, text: `Task ${resolvedId} not found` }],
          isError: true
        }
      }
      deps.notifyRenderer()
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(unarchived, null, 2)
          }
        ]
      }
    }
  )
}
