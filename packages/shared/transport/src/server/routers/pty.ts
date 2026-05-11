import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '../trpc'
import { getPtyDeps } from '../app-deps'

const anyInput = z.unknown()
const ops = () => getPtyDeps().ops

export const ptyRouter = router({
  // Terminal modes CRUD
  modesList: publicProcedure.query(() => ops().terminalModesList()),
  modesTest: publicProcedure.input(z.object({ command: z.string() })).query(({ input }) =>
    ops().terminalModesTest(input.command),
  ),
  modesGet: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) =>
    ops().terminalModesGet(input.id),
  ),
  modesCreate: publicProcedure.input(anyInput).mutation(({ input }) =>
    ops().terminalModesCreate(input as never),
  ),
  modesUpdate: publicProcedure.input(z.object({ id: z.string(), updates: anyInput })).mutation(({ input }) =>
    ops().terminalModesUpdate(input.id, input.updates as never),
  ),
  modesDelete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) =>
    ops().terminalModesDelete(input.id),
  ),
  modesRestoreDefaults: publicProcedure.mutation(() => ops().terminalModesRestoreDefaults()),
  modesResetToDefaultState: publicProcedure.mutation(() => ops().terminalModesResetToDefaultState()),

  // PTY ops
  create: publicProcedure.input(anyInput).mutation(({ input }) => ops().ptyCreate(input as never)),
  testExecutionContext: publicProcedure.input(anyInput).query(({ input }) =>
    ops().ptyTestExecutionContext(input as never),
  ),
  ccsListProfiles: publicProcedure.query(() => ops().ptyCcsListProfiles()),
  write: publicProcedure
    .input(z.object({ sessionId: z.string(), data: z.string() }))
    .mutation(({ input }) => ops().ptyWrite(input.sessionId, input.data)),
  submit: publicProcedure
    .input(z.object({ sessionId: z.string(), text: z.string() }))
    .mutation(({ input }) => ops().ptySubmit(input.sessionId, input.text)),
  resize: publicProcedure
    .input(z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }))
    .mutation(({ input }) => ops().ptyResize(input.sessionId, input.cols, input.rows)),
  kill: publicProcedure.input(z.object({ sessionId: z.string() })).mutation(({ input }) =>
    ops().ptyKill(input.sessionId),
  ),
  exists: publicProcedure.input(z.object({ sessionId: z.string() })).query(({ input }) =>
    ops().ptyExists(input.sessionId),
  ),
  getBuffer: publicProcedure.input(z.object({ sessionId: z.string() })).query(({ input }) =>
    ops().ptyGetBuffer(input.sessionId),
  ),
  clearBuffer: publicProcedure.input(z.object({ sessionId: z.string() })).mutation(({ input }) =>
    ops().ptyClearBuffer(input.sessionId),
  ),
  getBufferSince: publicProcedure
    .input(z.object({ sessionId: z.string(), afterSeq: z.number() }))
    .query(({ input }) => ops().ptyGetBufferSince(input.sessionId, input.afterSeq)),
  list: publicProcedure.query(() => ops().ptyList()),
  chatList: publicProcedure.query(() => ops().chatList()),
  getState: publicProcedure.input(z.object({ sessionId: z.string() })).query(({ input }) =>
    ops().ptyGetState(input.sessionId),
  ),
  sessionList: publicProcedure.query(() => ops().sessionList()),
  sessionGetState: publicProcedure.input(z.object({ sessionId: z.string() })).query(({ input }) =>
    ops().sessionGetState(input.sessionId),
  ),
  setTheme: publicProcedure.input(anyInput).mutation(({ input }) => ops().ptySetTheme(input as never)),
  validate: publicProcedure.input(z.object({ mode: z.string() })).query(({ input }) =>
    ops().ptyValidate(input.mode as never),
  ),
  setShellOverride: publicProcedure.input(z.object({ value: z.string().nullable() })).mutation(({ input }) =>
    ops().ptySetShellOverride(input.value),
  ),

  // Streaming subscriptions
  onData: publicProcedure.subscription(() => observable<{ sessionId: string; data: string; seq: number }>((emit) => {
    const handler = (sessionId: string, data: string, seq: number) => emit.next({ sessionId, data, seq })
    const ev = getPtyDeps().events
    ev.on('data', handler)
    return () => ev.off('data', handler)
  })),
  onStateChange: publicProcedure.subscription(() => observable<{ sessionId: string; newState: string; oldState: string }>((emit) => {
    const handler = (sessionId: string, newState: string, oldState: string) => emit.next({ sessionId, newState, oldState })
    const ev = getPtyDeps().events
    ev.on('state-change', handler)
    return () => ev.off('state-change', handler)
  })),
  onTitleChange: publicProcedure.subscription(() => observable<{ sessionId: string; title: string }>((emit) => {
    const handler = (sessionId: string, title: string) => emit.next({ sessionId, title })
    const ev = getPtyDeps().events
    ev.on('title-change', handler)
    return () => ev.off('title-change', handler)
  })),
  onExit: publicProcedure.subscription(() => observable<{ sessionId: string; exitCode: number | null }>((emit) => {
    const handler = (sessionId: string, exitCode: number | null) => emit.next({ sessionId, exitCode })
    const ev = getPtyDeps().events
    ev.on('exit', handler)
    return () => ev.off('exit', handler)
  })),
  onPrompt: publicProcedure.subscription(() => observable<{ sessionId: string; prompt: unknown }>((emit) => {
    const handler = (sessionId: string, prompt: unknown) => emit.next({ sessionId, prompt })
    const ev = getPtyDeps().events
    ev.on('prompt', handler)
    return () => ev.off('prompt', handler)
  })),
  onSessionDetected: publicProcedure.subscription(() => observable<{ sessionId: string; conversationId: string }>((emit) => {
    const handler = (sessionId: string, conversationId: string) => emit.next({ sessionId, conversationId })
    const ev = getPtyDeps().events
    ev.on('session-detected', handler)
    return () => ev.off('session-detected', handler)
  })),
  onSessionNotFound: publicProcedure.subscription(() => observable<{ sessionId: string }>((emit) => {
    const handler = (sessionId: string) => emit.next({ sessionId })
    const ev = getPtyDeps().events
    ev.on('session-not-found', handler)
    return () => ev.off('session-not-found', handler)
  })),
  onDevServerDetected: publicProcedure.subscription(() => observable<{ sessionId: string; info: unknown }>((emit) => {
    const handler = (sessionId: string, info: unknown) => emit.next({ sessionId, info })
    const ev = getPtyDeps().events
    ev.on('dev-server-detected', handler)
    return () => ev.off('dev-server-detected', handler)
  })),
  onRespawnSuggested: publicProcedure.subscription(() => observable<{ taskId: string }>((emit) => {
    const handler = (taskId: string) => emit.next({ taskId })
    const ev = getPtyDeps().events
    ev.on('respawn-suggested', handler)
    return () => ev.off('respawn-suggested', handler)
  })),
  onRespawnForced: publicProcedure.subscription(() => observable<{ taskId: string; reqId: string }>((emit) => {
    const handler = (taskId: string, reqId: string) => emit.next({ taskId, reqId })
    const ev = getPtyDeps().events
    ev.on('respawn-forced', handler)
    return () => ev.off('respawn-forced', handler)
  })),
})
