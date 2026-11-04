import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getPtyDeps } from './pty-router-deps'
import { TRPCError } from '@trpc/server'
import { PtyOutputUnavailableError } from './runtime/pty-output-unavailable'

/** A read of scrollback held by an offline computer: SERVICE_UNAVAILABLE, not a crash. */
async function scrollback<T>(read: () => Promise<T> | T): Promise<T> {
  try {
    return await read()
  } catch (err) {
    if (err instanceof PtyOutputUnavailableError)
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: err.message, cause: err })
    throw err
  }
}
import { stopTaskAgents } from './task-events'
import { agentStarts, type AgentStartEntry } from './runtime/agent-starts'

// PTY router (IPC → tRPC migration, slice 3 / P17). Mirrors the `pty:*` /
// `agents*` / `session:*` / `chat:list` IPC handlers 1:1 plus the
// `webContents.send('pty:*')` event surface as subscriptions. Ops + the event
// emitter are injected via `setPtyDeps()` (electron + node-pty coupled). The
// renderer is still on IPC until slice 5; the same ops/emitter back both
// transports (dual-emit in pty-manager).
const anyInput = z.unknown()
const ops = (): ReturnType<typeof getPtyDeps>['ops'] => getPtyDeps().ops

export const ptyRouter = router({
  // Agent definitions CRUD
  agentsList: publicProcedure.query(() => ops().agentsList()),
  agentsTest: publicProcedure
    .input(z.object({ command: z.string() }))
    .query(({ input }) => ops().agentsTest(input.command)),
  agentsGet: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => ops().agentsGet(input.id)),
  agentsCreate: publicProcedure
    .input(anyInput)
    .mutation(({ input }) => ops().agentsCreate(input as never)),
  agentsUpdate: publicProcedure
    .input(z.object({ id: z.string(), updates: anyInput }))
    .mutation(({ input }) => ops().agentsUpdate(input.id, input.updates as never)),
  agentsDelete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => ops().agentsDelete(input.id)),
  agentsRestoreDefaults: publicProcedure.mutation(() => ops().agentsRestoreDefaults()),
  agentsResetToDefaultState: publicProcedure.mutation(() => ops().agentsResetToDefaultState()),

  // PTY ops
  create: publicProcedure.input(anyInput).mutation(({ input }) => ops().ptyCreate(input as never)),
  // Test-only (PLAYWRIGHT): capture createPty opts at the spawn chokepoint (no spawn).
  testSetPtyCreateCapture: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
      ops().setCreateCapture(input.enabled)
      return { ok: true }
    }),
  // Test-only (PLAYWRIGHT): warm-pool state per project ('booting' | 'ready' |
  // 'reserved'). A `pooled` ledger row exists from spawn, so it cannot tell a
  // booting agent (not reservable) from a ready one.
  testWarmStatus: publicProcedure.query(() => {
    if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
    return ops().warmStatus()
  }),
  testTakePtyCreateOpts: publicProcedure.query(() => {
    if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
    return ops().takeCreateOpts()
  }),
  // Test-only (PLAYWRIGHT): kill calls recorded while the create capture is on —
  // lifecycle specs assert reset/restart killed the (stubbed) session.
  testTakePtyKillCalls: publicProcedure.query(() => {
    if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
    return ops().takeKillCalls()
  }),
  // Test-only (PLAYWRIGHT). Unlike its five siblings above, this one had NO env
  // gate at all — it takes `anyInput` and reaches `execFile('ssh'|'docker', …)`
  // with caller-controlled `context.target`/`context.container`
  // (pty-manager.ts's `ptyTestExecutionContext`), so an ungated `full` (or,
  // before scopes existed, ANY) principal could invoke arbitrary ssh/docker exec
  // in production. Gated now, matching the pattern every sibling already follows.
  testExecutionContext: publicProcedure.input(anyInput).query(({ input }) => {
    if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
    return ops().ptyTestExecutionContext(input as never)
  }),
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
  // Every terminal + chat agent of one task, wherever it runs (closing a scratch
  // terminal's tab). The task and its conversations stay.
  killTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ input }) => stopTaskAgents(input.taskId)),
  touch: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) => ops().ptyTouch(input.sessionId)),
  interrupt: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) => ops().ptyInterrupt(input.sessionId)),
  // The tab showing this session was revealed: if its agent is still waiting for
  // an agent-start slot on its computer, start it next. No-op otherwise.
  prioritize: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) => ops().ptyPrioritize(input.sessionId)),
  // Renderer→main ensure-alive ACK — resolves the pending requestEnsureAlive
  // waiter by reqId. Mirrors the legacy `pty:ensure-alive:ack` IPC.
  ackEnsureAlive: publicProcedure
    .input(z.object({ reqId: z.number(), result: z.enum(['ok', 'already-alive', 'error']) }))
    .mutation(({ input }) => ops().ptyAckEnsureAlive(input.reqId, input.result)),
  exists: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => ops().ptyExists(input.sessionId)),
  getBuffer: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => scrollback(() => ops().ptyGetBuffer(input.sessionId))),
  clearBuffer: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) => scrollback(() => ops().ptyClearBuffer(input.sessionId))),
  getBufferSince: publicProcedure
    .input(z.object({ sessionId: z.string(), afterSeq: z.number() }))
    .query(({ input }) =>
      scrollback(() => ops().ptyGetBufferSince(input.sessionId, input.afterSeq))
    ),
  // One-round-trip attach for a terminal (re)mounting onto its session:
  // exists + state + the buffer after `afterSeq`, read back-to-back on the
  // server. Replaces three serial renderer→server round trips (exists → getState
  // → getBufferSince) per terminal — ~50 of them on a renderer boot. `buffer` is
  // read whether or not the PTY is live, exactly as `getBufferSince` would answer.
  // `size`: the session's terminal size now (null = no session), for a client that
  // renders it without resizing it (the phone; changes follow on `onResize`).
  attach: publicProcedure
    .input(z.object({ sessionId: z.string(), afterSeq: z.number() }))
    .query(async ({ input }) => {
      const exists = await ops().ptyExists(input.sessionId)
      const state = await ops().ptyGetState(input.sessionId)
      const size = await ops().ptyGetSize(input.sessionId)
      try {
        const buffer = await ops().ptyGetBufferSince(input.sessionId, input.afterSeq)
        return { exists, state, buffer, size }
      } catch (err) {
        if (!(err instanceof PtyOutputUnavailableError)) throw err
        // Its computer is offline: say so (the terminal shows it and re-attaches
        // on `onOutputAvailability`), rather than fail or hang the attach.
        return { exists, state, buffer: null, size, unavailable: 'computer-offline' as const }
      }
    }),
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
    .input(z.object({ mode: z.string(), taskId: z.string().optional() }))
    .query(({ input }) => ops().ptyValidate(input.mode as never, input.taskId)),
  setShellOverride: publicProcedure
    .input(z.object({ value: z.string().nullable() }))
    .mutation(({ input }) => ops().ptySetShellOverride(input.value)),
  // Warm-process gate: this window's full per-project open-task-tab snapshot,
  // keyed by ctx.windowId (same webContents id the IPC path reads off
  // event.sender). Window-close cleanup: the hub clears it once the window's last
  // socket stays closed (apps/hub warm-window-sockets.ts).
  warmSetProjectTabCounts: publicProcedure
    .input(z.object({ counts: z.record(z.string(), z.number()) }))
    .mutation(({ ctx, input }) => {
      if (ctx.windowId == null) throw new Error('windowId required')
      ops().warmSetProjectTabCounts(ctx.windowId, input.counts)
    }),

  // Streaming subscriptions — mirror the dual-emitted pty events (pty-manager
  // `ptyEvents`). High-frequency `onData` rides the observable's internal queue
  // for backpressure; cleanup unsubscribes on teardown.
  //
  // `sessionIds` is an OPTIONAL server-side filter, added for the web client:
  // this subscription is otherwise a firehose — every byte of every live
  // session on the hub, filtered only client-side today (PtyContext.tsx). That
  // is fine on a LAN desktop; it is a real bandwidth (and, on a scoped `read`
  // session, a real "every terminal" exposure — see scopes.ts) problem over
  // cellular. Omitting the field (every existing desktop caller passes
  // `undefined`) reproduces today's unfiltered behavior EXACTLY — this is
  // additive, not a breaking change to the subscription's shape.
  onData: publicProcedure
    .input(z.object({ sessionIds: z.array(z.string()).optional() }).optional())
    .subscription(({ input }) =>
      observable<{ sessionId: string; data: string; seq: number }>((emit) => {
        const filter = input?.sessionIds
        const handler = (sessionId: string, data: string, seq: number): void => {
          if (filter && !filter.includes(sessionId)) return
          emit.next({ sessionId, data, seq })
        }
        const { events: ev, ops: o } = getPtyDeps()
        ev.on('data', handler)
        // Watching is what makes a session's owner stream its bytes here at all.
        const unwatch = o?.ptyWatchOutput?.(filter ?? 'all')
        return () => {
          ev.off('data', handler)
          unwatch?.()
        }
      })
    ),
  /** A session's computer went offline / came back (its output + scrollback). */
  onOutputAvailability: publicProcedure.subscription(() =>
    observable<{ sessionId: string; available: boolean }>((emit) => {
      const handler = (sessionId: string, available: boolean): void =>
        emit.next({ sessionId, available })
      const ev = getPtyDeps().events
      ev.on('output-availability', handler)
      return () => ev.off('output-availability', handler)
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
  /** Claude background-job count per session (Bash run_in_background / Monitor). */
  onBackgroundJobs: publicProcedure.subscription(() =>
    observable<{ sessionId: string; count: number }>((emit) => {
      const handler = (sessionId: string, count: number): void => emit.next({ sessionId, count })
      const ev = getPtyDeps().events
      ev.on('background-jobs', handler)
      return () => ev.off('background-jobs', handler)
    })
  ),
  /** A session's terminal size changed (`pty.resize`): what `attach.size` reports now. */
  onResize: publicProcedure.subscription(() =>
    observable<{ sessionId: string; cols: number; rows: number }>((emit) => {
      const handler = (sessionId: string, cols: number, rows: number): void =>
        emit.next({ sessionId, cols, rows })
      const ev = getPtyDeps().events
      ev.on('resize', handler)
      return () => ev.off('resize', handler)
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
    observable<{
      sessionId: string
      exitCode: number | null
      errorCode: string | null
      /** Lifecycle cause (`startup-timeout`, `computer-restarted`, …); null when none. */
      exitReason: string | null
      /** The owner's own words for it (a spawn refusal's message); null when none. */
      exitDetail: string | null
    }>((emit) => {
      const handler = (
        sessionId: string,
        exitCode: number | null,
        errorCode: string | null,
        exitReason?: string | null,
        exitDetail?: string | null
      ): void =>
        emit.next({
          sessionId,
          exitCode,
          errorCode,
          exitReason: exitReason ?? null,
          exitDetail: exitDetail ?? null
        })
      const ev = getPtyDeps().events
      ev.on('exit', handler)
      return () => ev.off('exit', handler)
    })
  ),
  onPrompt: publicProcedure.subscription(() =>
    observable<{ sessionId: string; prompt: unknown }>((emit) => {
      const handler = (sessionId: string, prompt: unknown): void => emit.next({ sessionId, prompt })
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
  // Test-only: emit a `session-detected` event as the side-car's PTY adapter
  // does when it parses a session id out of `/status` (codex) / `/stats`
  // (gemini) output. Specs can't run a real CLI, so they fire this to drive the
  // renderer's onSessionDetected → persist path. PLAYWRIGHT-gated (menu.testEmit
  // pattern). Replaces the legacy host `pty:session-detected` IPC mock that the
  // tRPC cutover orphaned.
  testEmitSessionDetected: publicProcedure
    .input(z.object({ sessionId: z.string(), conversationId: z.string() }))
    .mutation(({ input }) => {
      if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
      getPtyDeps().events.emit('session-detected', input.sessionId, input.conversationId)
      return { ok: true }
    }),
  // Test-only: emit a `pty:exit` on the shared emitter (e.g. errorCode
  // SESSION_NOT_FOUND to drive the stale-session "Start fresh" overlay, or
  // exitReason `spawn-failed` + the computer's refusal as exitDetail). Specs run
  // against the stubbed createPty capture, so there is no real process to exit.
  // PLAYWRIGHT-gated (menu.testEmit pattern).
  testEmitExit: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        exitCode: z.number().nullable(),
        errorCode: z.string().nullable(),
        exitReason: z.string().nullable().optional(),
        exitDetail: z.string().nullable().optional()
      })
    )
    .mutation(({ input }) => {
      if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
      getPtyDeps().events.emit(
        'exit',
        input.sessionId,
        input.exitCode,
        input.errorCode,
        input.exitReason ?? null,
        input.exitDetail ?? null
      )
      return { ok: true }
    }),
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
  ),
  /**
   * Agents starting right now — `queued` (waiting for a start slot on their
   * computer) or `booting` (launched, no output yet). The current snapshot on
   * subscribe, then one per burst of changes. Drives the sidebar's startup card.
   */
  onAgentStarts: publicProcedure.subscription(() =>
    observable<AgentStartEntry[]>((emit) => {
      emit.next(agentStarts.snapshot())
      return agentStarts.subscribe((entries) => emit.next(entries))
    })
  ),
  // Per-process CPU/RSS sampler (host poller). Mirrors the legacy `pty:stats` send.
  onStats: publicProcedure.subscription(() =>
    observable<Record<string, { cpu: number; rss: number }>>((emit) => {
      const handler = (stats: Record<string, { cpu: number; rss: number }>): void =>
        emit.next(stats)
      const ev = getPtyDeps().events
      ev.on('stats', handler)
      return () => ev.off('stats', handler)
    })
  ),
  // Renderer re-fit request. Mirrors the legacy `pty:resize-needed` send.
  onResizeNeeded: publicProcedure.subscription(() =>
    observable<{ sessionId: string }>((emit) => {
      const handler = (sessionId: string): void => emit.next({ sessionId })
      const ev = getPtyDeps().events
      ev.on('resize-needed', handler)
      return () => ev.off('resize-needed', handler)
    })
  )
})

export type PtyRouter = typeof ptyRouter
/** The key api mounts `ptyRouter` at; a client calling `pty.*` types against this. */
export type PtyMounts = { pty: PtyRouter }
