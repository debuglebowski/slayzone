import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '../trpc'
import { getChatDeps } from '../app-deps'

const anyInput = z.unknown()
const ops = () => getChatDeps().ops
const queueOps = () => getChatDeps().queueOps

export const chatRouter = router({
  // Core chat ops
  supports: publicProcedure.input(z.object({ mode: z.string() })).query(({ input }) =>
    ops().supports(input.mode),
  ),
  create: publicProcedure.input(anyInput).mutation(({ input }) => ops().create(input as never)),
  send: publicProcedure
    .input(z.object({ tabId: z.string(), text: z.string() }))
    .mutation(({ input }) => ops().send(input.tabId, input.text)),
  sendToolResult: publicProcedure
    .input(z.object({ tabId: z.string(), args: anyInput }))
    .mutation(({ input }) => ops().sendToolResult(input.tabId, input.args as never)),
  respondPermission: publicProcedure
    .input(z.object({ tabId: z.string(), args: anyInput }))
    .mutation(({ input }) => ops().respondPermission(input.tabId, input.args as never)),
  interrupt: publicProcedure.input(anyInput).mutation(({ input }) =>
    ops().interrupt(input as never),
  ),
  abortAndPop: publicProcedure.input(anyInput).mutation(({ input }) =>
    ops().abortAndPop(input as never),
  ),
  kill: publicProcedure.input(z.object({ tabId: z.string() })).mutation(({ input }) =>
    ops().kill(input.tabId),
  ),
  remove: publicProcedure.input(z.object({ tabId: z.string() })).mutation(({ input }) =>
    ops().remove(input.tabId),
  ),
  reset: publicProcedure.input(anyInput).mutation(({ input }) => ops().reset(input as never)),
  getBufferSince: publicProcedure
    .input(z.object({ tabId: z.string(), afterSeq: z.number() }))
    .query(({ input }) => ops().getBufferSince(input.tabId, input.afterSeq)),
  getInfo: publicProcedure.input(z.object({ tabId: z.string() })).query(({ input }) =>
    ops().getInfo(input.tabId),
  ),
  inspectPermissions: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().inspectPermissions(input.taskId, input.mode)),

  // Mode/model/effort
  getMode: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getMode(input.taskId, input.mode)),
  getAutoEligibility: publicProcedure.query(() => ops().getAutoEligibility()),
  setMode: publicProcedure.input(anyInput).mutation(({ input }) => ops().setMode(input as never)),
  getModel: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getModel(input.taskId, input.mode)),
  setModel: publicProcedure.input(anyInput).mutation(({ input }) => ops().setModel(input as never)),
  getEffort: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .query(({ input }) => ops().getEffort(input.taskId, input.mode)),
  setEffort: publicProcedure.input(anyInput).mutation(({ input }) => ops().setEffort(input as never)),

  // Project metadata
  listSkills: publicProcedure.input(z.object({ cwd: z.string() })).query(({ input }) =>
    ops().listSkills(input.cwd),
  ),
  listCommands: publicProcedure.input(z.object({ cwd: z.string() })).query(({ input }) =>
    ops().listCommands(input.cwd),
  ),
  listAgents: publicProcedure.input(z.object({ cwd: z.string() })).query(({ input }) =>
    ops().listAgents(input.cwd),
  ),
  listFiles: publicProcedure
    .input(z.object({ cwd: z.string(), query: z.string(), limit: z.number().optional() }))
    .query(({ input }) => ops().listFiles(input.cwd, input.query, input.limit)),
  bumpAutocompleteUsage: publicProcedure
    .input(z.object({ source: z.string(), name: z.string() }))
    .mutation(({ input }) => ops().bumpAutocompleteUsage(input.source, input.name)),
  getAutocompleteUsage: publicProcedure.query(() => ops().getAutocompleteUsage()),

  // Queue
  queue: router({
    list: publicProcedure.input(z.object({ tabId: z.string() })).query(({ input }) =>
      queueOps().list(input.tabId),
    ),
    push: publicProcedure
      .input(z.object({ tabId: z.string(), send: z.string(), original: z.string() }))
      .mutation(({ input }) => queueOps().push(input.tabId, input.send, input.original)),
    remove: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) =>
      queueOps().remove(input.id),
    ),
    clear: publicProcedure.input(z.object({ tabId: z.string() })).mutation(({ input }) =>
      queueOps().clear(input.tabId),
    ),
  }),

  // Chat streaming events
  onEvent: publicProcedure.subscription(() => observable<{ tabId: string; event: unknown; seq: number }>((emit) => {
    const handler = (tabId: string, event: unknown, seq: number) => emit.next({ tabId, event, seq })
    const ev = getChatDeps().events
    ev.on('event', handler)
    return () => ev.off('event', handler)
  })),
  onExit: publicProcedure.subscription(() => observable<{ tabId: string; sessionId: string; code: number | null; signal: string | null }>((emit) => {
    const handler = (tabId: string, sessionId: string, code: number | null, signal: string | null) =>
      emit.next({ tabId, sessionId, code, signal })
    const ev = getChatDeps().events
    ev.on('exit', handler)
    return () => ev.off('exit', handler)
  })),
  onQueueChanged: publicProcedure.subscription(() => observable<{ tabId: string }>((emit) => {
    const handler = (tabId: string) => emit.next({ tabId })
    const ev = getChatDeps().queueEvents
    ev.on('queue-changed', handler)
    return () => ev.off('queue-changed', handler)
  })),
  onQueueDrained: publicProcedure.subscription(() => observable<{ tabId: string; original: string }>((emit) => {
    const handler = (tabId: string, original: string) => emit.next({ tabId, original })
    const ev = getChatDeps().queueEvents
    ev.on('queue-drained', handler)
    return () => ev.off('queue-drained', handler)
  })),
})
