import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '../trpc'
import { getProcessesDeps } from '../app-deps'

const anyInput = z.unknown()

// Processes router — lifecycle ops + 4 streaming subscriptions over the injected
// `processEvents` TypedEmitter. Same ops/emitter back the still-live IPC handlers
// (coexistence until the renderer drops IPC in slice 5).
export const processesRouter = router({
  create: publicProcedure.input(anyInput).mutation(({ input }) => {
    const i = input as {
      projectId: string | null
      taskId: string | null
      label: string
      command: string
      cwd: string
      autoRestart: boolean
    }
    return getProcessesDeps().create(i.projectId, i.taskId, i.label, i.command, i.cwd, i.autoRestart)
  }),
  spawn: publicProcedure.input(anyInput).mutation(({ input }) => {
    const i = input as {
      projectId: string | null
      taskId: string | null
      label: string
      command: string
      cwd: string
      autoRestart: boolean
    }
    return getProcessesDeps().spawn(i.projectId, i.taskId, i.label, i.command, i.cwd, i.autoRestart)
  }),
  update: publicProcedure
    .input(z.object({ processId: z.string(), updates: anyInput }))
    .mutation(({ input }) => getProcessesDeps().update(input.processId, input.updates as never)),
  stop: publicProcedure
    .input(z.object({ processId: z.string() }))
    .mutation(({ input }) => getProcessesDeps().stop(input.processId)),
  kill: publicProcedure
    .input(z.object({ processId: z.string() }))
    .mutation(({ input }) => getProcessesDeps().kill(input.processId)),
  restart: publicProcedure
    .input(z.object({ processId: z.string() }))
    .mutation(({ input }) => getProcessesDeps().restart(input.processId)),
  listForTask: publicProcedure
    .input(z.object({ taskId: z.string().nullable(), projectId: z.string().nullable() }))
    .query(({ input }) => getProcessesDeps().listForTask(input.taskId, input.projectId)),
  listAll: publicProcedure.query(() => getProcessesDeps().listAll()),
  killTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ input }) => getProcessesDeps().killTask(input.taskId)),

  // Streaming events
  onLog: publicProcedure.subscription(() =>
    observable<{ id: string; line: string }>((emit) => {
      const handler = (id: string, line: string): void => emit.next({ id, line })
      const ev = getProcessesDeps().events
      ev.on('log', handler)
      return () => ev.off('log', handler)
    })
  ),
  onStatus: publicProcedure.subscription(() =>
    observable<{ id: string; status: string }>((emit) => {
      const handler = (id: string, status: string): void => emit.next({ id, status })
      const ev = getProcessesDeps().events
      ev.on('status', handler)
      return () => ev.off('status', handler)
    })
  ),
  onTitle: publicProcedure.subscription(() =>
    observable<{ id: string; title: string | null }>((emit) => {
      const handler = (id: string, title: string | null): void => emit.next({ id, title })
      const ev = getProcessesDeps().events
      ev.on('title', handler)
      return () => ev.off('title', handler)
    })
  ),
  onStats: publicProcedure.subscription(() =>
    observable<Record<string, { cpu: number; rss: number }>>((emit) => {
      const handler = (stats: Record<string, { cpu: number; rss: number }>): void => emit.next(stats)
      const ev = getProcessesDeps().events
      ev.on('stats', handler)
      return () => ev.off('stats', handler)
    })
  )
})
