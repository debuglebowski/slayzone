import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '../trpc'
import { getChatDeps } from '../app-deps'

const ops = (): ReturnType<typeof getChatDeps>['ops'] => getChatDeps().ops
const queueOps = (): ReturnType<typeof getChatDeps>['queueOps'] => getChatDeps().queueOps

// Structural input schemas. Value-level validation (which chatMode/effort/model/
// collaboration string is valid for a given provider) lives in the ops layer
// (`isChatEffort`, `isValidChatModeForMode`, … all throw) — the domain owns its
// vocabulary, so the boundary only parses shape + primitive types. The schemas'
// inferred types are assignable to the ops params, so no `as never` casts are
// needed and tsc verifies any drift between schema and ops signature.
const chatCreateOpts = z.object({
  tabId: z.string(),
  taskId: z.string(),
  mode: z.string(),
  cwd: z.string(),
  providerFlagsOverride: z.string().nullish()
})
const toolResultArgs = z.object({
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().optional()
})
const permissionArgs = z.object({
  requestId: z.string(),
  decision: z.discriminatedUnion('behavior', [
    z.object({
      behavior: z.literal('allow'),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(z.unknown()).optional()
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string(),
      interrupt: z.boolean().optional()
    })
  ])
})

export const chatRouter = router({
  // Core session ops
  supports: publicProcedure
    .input(z.object({ mode: z.string() }))
    .query(({ input }) => ops().supports(input.mode)),
  hydrate: publicProcedure.input(chatCreateOpts).mutation(({ input }) => ops().hydrate(input)),
  start: publicProcedure.input(chatCreateOpts).mutation(({ input }) => ops().start(input)),
  send: publicProcedure
    .input(z.object({ tabId: z.string(), text: z.string() }))
    .mutation(({ input }) => ops().send(input.tabId, input.text)),
  sendToolResult: publicProcedure
    .input(z.object({ tabId: z.string(), args: toolResultArgs }))
    .mutation(({ input }) => ops().sendToolResult(input.tabId, input.args)),
  respondPermission: publicProcedure
    .input(z.object({ tabId: z.string(), args: permissionArgs }))
    .mutation(({ input }) => ops().respondPermission(input.tabId, input.args)),
  interrupt: publicProcedure.input(chatCreateOpts).mutation(({ input }) => ops().interrupt(input)),
  abortAndPop: publicProcedure
    .input(chatCreateOpts)
    .mutation(({ input }) => ops().abortAndPop(input)),
  kill: publicProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ input }) => ops().kill(input.tabId)),
  remove: publicProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ input }) => ops().remove(input.tabId)),
  reset: publicProcedure.input(chatCreateOpts).mutation(({ input }) => ops().reset(input)),
  getBufferSince: publicProcedure
    .input(z.object({ tabId: z.string(), afterSeq: z.number() }))
    .query(({ input }) => ops().getBufferSince(input.tabId, input.afterSeq)),
  getInfo: publicProcedure
    .input(z.object({ tabId: z.string() }))
    .query(({ input }) => ops().getInfo(input.tabId)),
  inspectPermissions: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().inspectPermissions(input.taskId, input.mode)),

  // Permission mode / model / effort / collaboration / fast mode
  getMode: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getMode(input.taskId, input.mode)),
  getAutoEligibility: publicProcedure.query(() => ops().getAutoEligibility()),
  setMode: publicProcedure
    .input(chatCreateOpts.extend({ chatMode: z.string() }))
    .mutation(({ input }) => ops().setMode(input)),
  getModel: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getModel(input.taskId, input.mode)),
  setModel: publicProcedure
    .input(chatCreateOpts.extend({ chatModel: z.string() }))
    .mutation(({ input }) => ops().setModel(input)),
  getEffort: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getEffort(input.taskId, input.mode)),
  setEffort: publicProcedure
    .input(chatCreateOpts.extend({ chatEffort: z.string() }))
    .mutation(({ input }) => ops().setEffort(input)),
  getCollaboration: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getCollaboration(input.taskId, input.mode)),
  setCollaboration: publicProcedure
    .input(chatCreateOpts.extend({ chatCollaboration: z.string() }))
    .mutation(({ input }) => ops().setCollaboration(input)),
  getFastMode: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getFastMode(input.taskId, input.mode)),
  setFastMode: publicProcedure
    .input(chatCreateOpts.extend({ chatFastMode: z.boolean() }))
    .mutation(({ input }) => ops().setFastMode(input)),

  // Project metadata
  listSkills: publicProcedure
    .input(z.object({ cwd: z.string() }))
    .query(({ input }) => ops().listSkills(input.cwd)),
  listCommands: publicProcedure
    .input(z.object({ cwd: z.string() }))
    .query(({ input }) => ops().listCommands(input.cwd)),
  listAgents: publicProcedure
    .input(z.object({ cwd: z.string() }))
    .query(({ input }) => ops().listAgents(input.cwd)),
  listFiles: publicProcedure
    .input(z.object({ cwd: z.string(), query: z.string(), limit: z.number().optional() }))
    .query(({ input }) => ops().listFiles(input.cwd, input.query, input.limit)),
  bumpAutocompleteUsage: publicProcedure
    .input(z.object({ source: z.string(), name: z.string() }))
    .mutation(({ input }) => ops().bumpAutocompleteUsage(input.source, input.name)),
  getAutocompleteUsage: publicProcedure.query(() => ops().getAutocompleteUsage()),

  // Queue (mirrors the `chat:queue:*` IPC channels)
  queue: router({
    list: publicProcedure
      .input(z.object({ tabId: z.string() }))
      .query(({ input }) => queueOps().list(input.tabId)),
    push: publicProcedure
      .input(z.object({ tabId: z.string(), send: z.string(), original: z.string() }))
      .mutation(({ input }) => queueOps().push(input.tabId, input.send, input.original)),
    remove: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => queueOps().remove(input.id)),
    clear: publicProcedure
      .input(z.object({ tabId: z.string() }))
      .mutation(({ input }) => queueOps().clear(input.tabId))
  }),

  // Streaming subscriptions — replace the 4 `webContents.send` broadcasts.
  // Source emitters are dual-emitted in the terminal domain; IPC stays until
  // the renderer cuts over (slice 5).
  onEvent: publicProcedure.subscription(() =>
    observable<{ tabId: string; event: unknown; seq: number }>((emit) => {
      const handler = (tabId: string, event: unknown, seq: number): void => {
        emit.next({ tabId, event, seq })
      }
      const ev = getChatDeps().events
      ev.on('event', handler)
      return () => {
        ev.off('event', handler)
      }
    })
  ),
  onExit: publicProcedure.subscription(() =>
    observable<{ tabId: string; sessionId: string; code: number | null; signal: string | null }>(
      (emit) => {
        const handler = (
          tabId: string,
          sessionId: string,
          code: number | null,
          signal: string | null
        ): void => {
          emit.next({ tabId, sessionId, code, signal })
        }
        const ev = getChatDeps().events
        ev.on('exit', handler)
        return () => {
          ev.off('exit', handler)
        }
      }
    )
  ),
  onQueueChanged: publicProcedure.subscription(() =>
    observable<{ tabId: string }>((emit) => {
      const handler = (tabId: string): void => {
        emit.next({ tabId })
      }
      const ev = getChatDeps().queueEvents
      ev.on('queue-changed', handler)
      return () => {
        ev.off('queue-changed', handler)
      }
    })
  ),
  onQueueDrained: publicProcedure.subscription(() =>
    observable<{ tabId: string; original: string }>((emit) => {
      const handler = (tabId: string, original: string): void => {
        emit.next({ tabId, original })
      }
      const ev = getChatDeps().queueEvents
      ev.on('queue-drained', handler)
      return () => {
        ev.off('queue-drained', handler)
      }
    })
  )
})
