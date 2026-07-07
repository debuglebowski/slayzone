import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { archiveTaskOp } from '@slayzone/task/server'
import { ArchiveTaskInput } from '@slayzone/task/shared'
import { NOOP_TASK_BUS } from '../rest-api/types'
import { resolveCurrentTaskId } from './shared'
import type { McpToolsDeps } from './types'

export function registerArchiveTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'archive_task',
    'Archive a task (hides from kanban, preserves in DB). Accepts a task id. In task terminals, source from $SLAYZONE_TASK_ID. If empty (pre-warmed agent), pass session_id from $SLAYZONE_SESSION_ID instead.',
    {
      ...ArchiveTaskInput.shape,
      id: ArchiveTaskInput.shape.id.optional(),
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
      let archived
      try {
        archived = await archiveTaskOp(deps.db, resolvedId, {
          ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
          onMutation: deps.notifyRenderer
        })
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true
        }
      }
      if (!archived) {
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
            text: JSON.stringify(archived, null, 2)
          }
        ]
      }
    }
  )
}
