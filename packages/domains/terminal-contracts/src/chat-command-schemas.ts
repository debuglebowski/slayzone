/**
 * Inputs of the chat commands a client may send either through the hub or straight
 * to the computer (docs/direct-link.md). One definition for both routers, so the two
 * paths cannot drift.
 */
import { z } from 'zod'

/** `chat.respondPermission` args: the user's answer to a permission prompt. */
export const chatPermissionArgsSchema = z.object({
  requestId: z.string(),
  /** Prompt row the user picked (display only; persisted on permission-resolved). */
  optionId: z.string().optional(),
  decision: z.discriminatedUnion('behavior', [
    z.object({
      behavior: z.literal('allow'),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(z.unknown()).optional(),
      scope: z.literal('session').optional(),
      amendment: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('execpolicy'), command: z.array(z.string()) }),
          z.object({
            kind: z.literal('network'),
            host: z.string(),
            action: z.enum(['allow', 'deny'])
          })
        ])
        .optional()
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string(),
      interrupt: z.boolean().optional()
    })
  ])
})

/** `chat.sendToolResult` args. */
export const chatToolResultArgsSchema = z.object({
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().optional()
})

/** `chat.tabState.saveScroll` anchor. */
export const chatScrollAnchorSchema = z.union([
  z.object({ atBottom: z.literal(true) }).strict(),
  z
    .object({
      atBottom: z.literal(false),
      key: z.string().min(1).max(500),
      offsetPx: z.number(),
      row: z.number().int().nonnegative().optional()
    })
    .strict()
])

/** Optional fences on a tab-state write: the provider and conversation it was meant for. */
export const chatTabStateExpectationsSchema = z.object({
  expectedMode: z.string().optional(),
  expectedOwnership: z
    .object({ id: z.string().min(1), epoch: z.number().int().positive() })
    .optional()
})

/** A draft with no attachments: the only kind a client may save directly (the hub seals files). */
export const chatTextDraftSchema = z.object({
  text: z.string().max(1_000_000),
  attachments: z.array(z.never()).max(0)
})
