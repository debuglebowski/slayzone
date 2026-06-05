import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '../trpc'
import { getPtyDeps } from '../app-deps'

// PTY router (IPC → tRPC migration, slice 3 / P17). Mirrors the `pty:*` /
// `terminalModes:*` / `session:*` / `chat:list` IPC handlers 1:1 plus the
// `webContents.send('pty:*')` event surface as subscriptions. Ops + the event
// emitter are injected via `setPtyDeps()` (electron + node-pty coupled). The
// renderer is still on IPC until slice 5; the same ops/emitter back both
// transports (dual-emit in pty-manager). `warm:setProjectTabCounts` stays
// IPC-only — it needs the deferred `ctx.windowId` capability.
const anyInput = z.unknown()
const ops = (): ReturnType<typeof getPtyDeps>['ops'] => getPtyDeps().ops

export const ptyRouter = router({
  // Terminal modes CRUD
  modesList: publicProcedure.query(() => ops().terminalModesList()),
  modesTest: publicProcedure
    .input(z.object({ command: z.string() }))
    .query(({ input }) => ops().terminalModesTest(input.command)),
  modesGet: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => ops().terminalModesGet(input.id)),
  modesCreate: publicProcedure
    .input(anyInput)
    .mutation(({ input }) => ops().terminalModesCreate(input as never)),
  modesUpdate: publicProcedure
    .input(z.object({ id: z.string(), updates: anyInput }))
    .mutation(({ input }) => ops().terminalModesUpdate(input.id, input.updates as never)),
  modesDelete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => ops().terminalModesDelete(input.id)),
  modesRestoreDefaults: publicProcedure.mutation(() => ops().terminalModesRestoreDefaults()),
  modesResetToDefaultState: publicProcedure.mutation(() => ops().terminalModesResetToDefaultState()),

  // PTY ops
  create: publicProcedure.input(anyInput).mutation(({ input }) => ops().ptyCreate(input as never)),
  testExecutionContext: publicProcedure
    .input(anyInput)
    .query(({ input }) => ops().ptyTestExecutionContext(input as never)),
  write: publicProcedure
    .input(z.object({ sessionId: z.string(), data: z.string() }))
    .mutation(({ input }) => ops().ptyWrite(input.sessionId, input.data)),
  submit: publicProcedure
    .input(z.object({ sessionId: z.string(), text: z.string() }))
    .mutation(({ input }) => ops().ptySubmit(input.sessionId, input.text)),
  resize: publicProcedure
    .input(z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }))
    .mutation(({ input }) => ops().ptyResize(input.sessionId, input.cols, input.rows)),
  kill: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) => ops().ptyKill(input.sessionId)),
  touch: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) => ops().ptyTouch(input.sessionId)),
  interrupt: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) => ops().ptyInterrupt(input.sessionId)),
  exists: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => ops().ptyExists(input.sessionId)),
  getBuffer: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => ops().ptyGetBuffer(input.sessionId)),
  clearBuffer: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) => ops().ptyClearBuffer(input.sessionId)),
  getBufferSince: publicProcedure
    .input(z.object({ sessionId: z.string(), afterSeq: z.number() }))
    .query(({ input }) => ops().ptyGetBufferSince(input.sessionId, input.afterSeq)),
  list: publicProcedure.query(() => ops().ptyList()),
  chatList: publicProcedure.query(() => ops().chatList()),
  getState: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => ops().ptyGetState(input.sessionId)),
  sessionList: publicProcedure.query(() => ops().sessionList()),
  sessionGetState: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => ops().sessionGetState(input.sessionId)),
  setTheme: publicProcedure
    .input(anyInput)
    .mutation(({ input }) => ops().ptySetTheme(input as never)),
  validate: publicProcedure
    .input(z.object({ mode: z.string() }))
    .query(({ input }) => ops().ptyValidate(input.mode as never)),
  setShellOverride: publicProcedure
    .input(z.object({ value: z.string().nullable() }))
    .mutation(({ input }) => ops().ptySetShellOverride(input.value)),

  // Streaming subscriptions — mirror the dual-emitted pty events (pty-manager
  // `ptyEvents`). High-frequency `onData` rides the observable's internal queue
  // for backpressure; cleanup unsubscribes on teardown.
  onData: publicProcedure.subscription(() =>
    observable<{ sessionId: string; data: string; seq: number }>((emit) => {
      const handler = (sessionId: string, data: string, seq: number): void =>
        emit.next({ sessionId, data, seq })
      const ev = getPtyDeps().events
      ev.on('data', handler)
      return () => ev.off('data', handler)
    })
  ),
  onStateChange: publicProcedure.subscription(() =>
    observable<{ sessionId: string; newState: string; oldState: string }>((emit) => {
      const handler = (sessionId: string, newState: string, oldState: string): void =>
        emit.next({ sessionId, newState, oldState })
      const ev = getPtyDeps().events
      ev.on('state-change', handler)
      return () => ev.off('state-change', handler)
    })
  ),
  onTitleChange: publicProcedure.subscription(() =>
    observable<{ sessionId: string; title: string }>((emit) => {
      const handler = (sessionId: string, title: string): void => emit.next({ sessionId, title })
      const ev = getPtyDeps().events
      ev.on('title-change', handler)
      return () => ev.off('title-change', handler)
    })
  ),
  onExit: publicProcedure.subscription(() =>
    observable<{ sessionId: string; exitCode: number | null; errorCode: string | null }>((emit) => {
      const handler = (sessionId: string, exitCode: number | null, errorCode: string | null): void =>
        emit.next({ sessionId, exitCode, errorCode })
      const ev = getPtyDeps().events
      ev.on('exit', handler)
      return () => ev.off('exit', handler)
    })
  ),
  onPrompt: publicProcedure.subscription(() =>
    observable<{ sessionId: string; prompt: unknown }>((emit) => {
      const handler = (sessionId: string, prompt: unknown): void =>
        emit.next({ sessionId, prompt })
      const ev = getPtyDeps().events
      ev.on('prompt', handler)
      return () => ev.off('prompt', handler)
    })
  ),
  onSessionDetected: publicProcedure.subscription(() =>
    observable<{ sessionId: string; conversationId: string }>((emit) => {
      const handler = (sessionId: string, conversationId: string): void =>
        emit.next({ sessionId, conversationId })
      const ev = getPtyDeps().events
      ev.on('session-detected', handler)
      return () => ev.off('session-detected', handler)
    })
  ),
  onDevServerDetected: publicProcedure.subscription(() =>
    observable<{ sessionId: string; url: string }>((emit) => {
      const handler = (sessionId: string, url: string): void => emit.next({ sessionId, url })
      const ev = getPtyDeps().events
      ev.on('dev-server-detected', handler)
      return () => ev.off('dev-server-detected', handler)
    })
  ),
  onRespawnSuggested: publicProcedure.subscription(() =>
    observable<{ taskId: string }>((emit) => {
      const handler = (taskId: string): void => emit.next({ taskId })
      const ev = getPtyDeps().events
      ev.on('respawn-suggested', handler)
      return () => ev.off('respawn-suggested', handler)
    })
  ),
  onEnsureAlive: publicProcedure.subscription(() =>
    observable<{ taskId: string; reqId: number; force: boolean }>((emit) => {
      const handler = (taskId: string, reqId: number, force: boolean): void =>
        emit.next({ taskId, reqId, force })
      const ev = getPtyDeps().events
      ev.on('ensure-alive', handler)
      return () => ev.off('ensure-alive', handler)
    })
  ),
  onHibernateWarn: publicProcedure.subscription(() =>
    observable<{ sessionId: string; graceSecs: number }>((emit) => {
      const handler = (sessionId: string, graceSecs: number): void =>
        emit.next({ sessionId, graceSecs })
      const ev = getPtyDeps().events
      ev.on('hibernate-warn', handler)
      return () => ev.off('hibernate-warn', handler)
    })
  ),
  onHibernateCancelled: publicProcedure.subscription(() =>
    observable<{ sessionId: string }>((emit) => {
      const handler = (sessionId: string): void => emit.next({ sessionId })
      const ev = getPtyDeps().events
      ev.on('hibernate-cancelled', handler)
      return () => ev.off('hibernate-cancelled', handler)
    })
  ),
  onHibernated: publicProcedure.subscription(() =>
    observable<{ sessionId: string }>((emit) => {
      const handler = (sessionId: string): void => emit.next({ sessionId })
      const ev = getPtyDeps().events
      ev.on('hibernated', handler)
      return () => ev.off('hibernated', handler)
    })
  )
})
