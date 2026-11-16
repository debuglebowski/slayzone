import { z } from 'zod'
import { chatRouteSchema } from '../shared'
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const chatTestRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('test.seedEvents'),
    route: chatRouteSchema,
    fromSeq: sequence,
    events: z.array(z.object({ kind: z.string().min(1).max(100) }).passthrough()).max(1000)
  }),
  z.object({
    kind: z.literal('test.readEvents'),
    route: chatRouteSchema,
    afterSeq: z.number().int().min(-1),
    limit: z.number().int().min(1).max(1000)
  }),
  z.object({
    kind: z.literal('test.projection'),
    route: chatRouteSchema,
    action: z.enum(['read', 'corrupt-page', 'corrupt-checkpoint'])
  }),
  z.object({
    kind: z.literal('test.seedPrompts'),
    route: chatRouteSchema,
    prompts: z
      .array(
        z.object({
          id: z.string().min(1).max(200),
          agentId: z.string().min(1).max(100),
          text: z.string().max(1_000_000),
          cliSessionId: z.string().max(200).nullable(),
          createdAt: sequence
        })
      )
      .max(1000)
  }),
  z.object({
    kind: z.literal('test.storageSlack'),
    route: chatRouteSchema,
    megabytes: z.number().int().min(1).max(1024)
  }),
  z.object({
    kind: z.literal('test.watchdog'),
    timings: z
      .object({
        startingBoundMs: z.number().positive(),
        runningStallMs: z.number().positive(),
        killGraceMs: z.number().positive(),
        spawnReplyBoundMs: z.number().positive().optional()
      })
      .nullable()
  })
])

export type ComputerChatTestRequest = z.infer<typeof chatTestRequestSchema>
