import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getProcessesDeps } from './processes-deps'

/** Far past any real value (a label is a tab title, a command one shell line, a cwd a
 *  path, Windows long paths included): only a client sending junk reaches them. */
const LABEL_MAX = 500
const COMMAND_MAX = 32_768
const CWD_MAX = 32_768

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0, { message: 'must not be blank' })

/**
 * The fields a client sets on a process. Validated here, before the process manager:
 * a missing label once reached its database insert, whose floated rejection ended the
 * hub's process (T-102). Strict, so `update` cannot write anything else onto the
 * manager's live record (its pid, log buffer, handle). `cwd` may be empty (the
 * renderer sends `''` when it has none); the ids are checked by the owner gate (T-17).
 */
const processFields = {
  projectId: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  label: nonBlank(LABEL_MAX),
  command: nonBlank(COMMAND_MAX),
  cwd: z.string().max(CWD_MAX),
  autoRestart: z.boolean()
}
const newProcessInput = z.strictObject(processFields)
const processUpdates = z.strictObject(processFields).partial()

// Processes router — lifecycle ops + 4 streaming subscriptions over the injected
// `processEvents` TypedEmitter. Same ops/emitter back the still-live IPC handlers
// (coexistence until the renderer drops IPC in slice 5).
export const processesRouter = router({
  create: publicProcedure
    .input(newProcessInput)
    .mutation(({ input: i }) =>
      getProcessesDeps().create(i.projectId, i.taskId, i.label, i.command, i.cwd, i.autoRestart)
    ),
  spawn: publicProcedure
    .input(newProcessInput)
    .mutation(({ input: i }) =>
      getProcessesDeps().spawn(i.projectId, i.taskId, i.label, i.command, i.cwd, i.autoRestart)
    ),
  update: publicProcedure
    .input(z.object({ processId: z.string(), updates: processUpdates }))
    .mutation(({ input }) => getProcessesDeps().update(input.processId, input.updates)),
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
      const handler = (stats: Record<string, { cpu: number; rss: number }>): void =>
        emit.next(stats)
      const ev = getProcessesDeps().events
      ev.on('stats', handler)
      return () => ev.off('stats', handler)
    })
  )
})
