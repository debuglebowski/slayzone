import { z } from 'zod'
import type { WorkspaceCaptureResult, WorkspaceCaptureBegin } from '@slayzone/terminal-contracts'

export const workspaceCaptureParamsSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,200}$/),
  scope: z.string().min(1).max(500),
  rootPath: z.string().max(10_000),
  projectId: z.string().nullish()
})
export const workspaceCaptureBeginSchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  rootPath: z.string().optional(),
  reason: z.string().optional()
}) satisfies z.ZodType<WorkspaceCaptureBegin & { rootPath?: string }>
export const workspaceCaptureResultSchema = z.object({
  status: z.enum(['complete', 'partial', 'unavailable']),
  reason: z.string().optional(),
  files: z.array(
    z.object({
      path: z.string(),
      oldPath: z.string().optional(),
      kind: z.enum(['added', 'modified', 'deleted', 'renamed']),
      additions: z.number().nullable(),
      deletions: z.number().nullable(),
      binary: z.boolean(),
      diff: z.string().nullable(),
      omitted: z.enum(['binary', 'size-limit', 'capture-failed']).optional()
    })
  )
}) satisfies z.ZodType<WorkspaceCaptureResult>
