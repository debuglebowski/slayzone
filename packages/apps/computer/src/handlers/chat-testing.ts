import { z } from 'zod'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { createComputerChatRuntime } from '@slayzone/chat-runtime/server'
import { chatRouteSchema } from '@slayzone/chat-runtime/shared'

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

/** Deliberately narrow fault injection; never expose arbitrary computer SQL. */
export async function handleChatTesting(
  r: ReturnType<typeof createComputerChatRuntime>,
  req: z.infer<typeof chatTestRequestSchema>
) {
  if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
  if (Buffer.byteLength(JSON.stringify(req)) > 8 * 1024 * 1024)
    throw new Error('Test batch exceeds byte limit')
  if (req.kind === 'test.watchdog') {
    r.ops.testSetWatchdogTimings(req.timings)
    return { ok: true }
  }
  const { id, epoch } = req.route,
    owner = r.storage.conversation(id)
  if (!owner || owner.identity.epoch !== epoch || owner.state !== 'active')
    throw new Error('Test storage ownership mismatch')
  if (r.storage.taskLifecycle(owner.identity.taskId).state !== 'active')
    throw new Error('Task chat is paused or deleted')
  return r.retention.access(id, async () => {
    if (req.kind === 'test.readEvents')
      return r.storage.compose((db) => {
        const result: Array<{ seq: number; event: AgentEvent }> = []
        let bytes = 0
        for (const row of db
          .prepare(
            'SELECT seq,event FROM events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?'
          )
          .iterate(id, req.afterSeq, req.limit) as Iterable<{ seq: number; event: string }>) {
          bytes += Buffer.byteLength(row.event)
          if (bytes > 8 * 1024 * 1024) {
            if (!result.length) throw new Error('Test event exceeds byte limit')
            break
          }
          result.push({ seq: row.seq, event: JSON.parse(row.event) as AgentEvent })
        }
        return result
      })
    if (req.kind === 'test.seedPrompts') {
      r.storage.transaction(() => {
        for (const prompt of req.prompts)
          r.storage.putRecord(id, epoch, {
            kind: 'prompt',
            id: prompt.id,
            value: { ...prompt, taskId: owner.identity.taskId },
            at: prompt.createdAt
          })
      })
      return { ok: true }
    }
    if (req.kind === 'test.seedEvents') {
      if (r.transport.getSessionInfo(owner.identity.tabId)?.pid)
        throw new Error('Cannot seed a live chat')
      await r.transport.removeSession(owner.identity.tabId)
      r.storage.transaction(() => {
        for (const [index, event] of req.events.entries()) {
          const seq = req.fromSeq + index
          if (!Number.isSafeInteger(seq)) throw new Error('Invalid test event sequence')
          if (
            r.storage.appendAt(id, epoch, seq, event as AgentEvent, Date.now()) === 'clash' &&
            JSON.stringify(r.storage.read(id, seq - 1, seq + 1)[0]?.event) !== JSON.stringify(event)
          )
            throw new Error('Test event sequence conflict')
        }
      })
      return { ok: true }
    }
    if (req.action === 'corrupt-checkpoint') {
      if (r.transport.getSessionInfo(owner.identity.tabId)?.pid)
        throw new Error('Cannot unload a live chat')
      await r.transport.removeSession(owner.identity.tabId)
    }
    const checkpoint = r.storage.getRecord<{ version: string; seq: number; data: string }>(
      id,
      'timeline',
      'checkpoint'
    )
    if (req.action === 'corrupt-checkpoint' && checkpoint)
      r.storage.putRecord(id, epoch, {
        kind: 'timeline',
        id: 'checkpoint',
        value: { ...checkpoint, data: '{oops' },
        at: Date.now()
      })
    if (req.action === 'corrupt-page') {
      const page = r.storage.getRecord<Record<string, unknown>>(id, 'timeline', 'page:0')
      if (!page) throw new Error('Test page is missing')
      r.storage.putRecord(id, epoch, {
        kind: 'timeline',
        id: 'page:0',
        value: { ...page, rows: '{oops' },
        at: Date.now()
      })
    }
    return { checkpoint, lastSeq: r.storage.nextSeq(id) - 1 }
  })
}
