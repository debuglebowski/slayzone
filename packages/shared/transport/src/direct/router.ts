/**
 * The client ↔ computer direct-link router (docs/direct-link.md).
 *
 * The computer serves it on `/direct/v1`. Desktop and mobile clients call it with
 * the same tRPC client stack they use for the hub (ws link, superjson wire). The
 * data shapes are the hub's `pty.*` shapes, so a client can switch between the hub
 * relay and the direct link without translating anything.
 *
 * Pure: no node imports. The computer's listener supplies a {@link DirectSocket}
 * per connection, holding the capabilities that socket presented. Every procedure
 * that touches a session first asks the socket for a live grant on it, and a stream
 * ends as soon as that grant does.
 *
 * @module transport/direct/router
 */
import { initTRPC, TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import { z } from 'zod'

/** Wire version (mirrors computer-transport `DIRECT_LINK_PROTOCOL`). */
export const DIRECT_ROUTER_PROTOCOL = 1

/** What a grant lets its bearer touch (structurally computer-transport's `DirectResource`). */
export type DirectGrantResource =
  | { kind: 'pty'; sessionId: string }
  | { kind: 'chat'; tabId: string; epoch: number }

/** A resource as a procedure names it (a chat tab without its epoch). */
export type DirectTarget = { kind: 'pty'; sessionId: string } | { kind: 'chat'; tabId: string }

export interface DirectGrantView {
  grantId: string
  resource: DirectGrantResource
  /** Remaining lifetime on the computer's clock. */
  expiresInMs: number
}

/** A live grant a socket holds, with the hub link that registered it. */
export interface DirectHeldGrant {
  grantId: string
  hubKey: string
  resource: DirectGrantResource
}

/** One authenticated client connection, as the computer's listener holds it. */
export interface DirectSocket {
  /** Add (or renew with) a capability. Null: unknown or expired token. */
  authorize(token: string): DirectGrantView | null
  /** A live grant this socket holds on `target`, or null. */
  grantFor(target: DirectTarget): DirectHeldGrant | null
  /** Called once when this socket no longer holds any grant on `target`. */
  onTargetEnded(target: DirectTarget, ended: () => void): () => void
}

export interface DirectContext {
  socket: DirectSocket
}

/** Same shape as the hub's `pty.getBufferSince` (terminal-contracts `BufferSinceResult`). */
export interface DirectBuffer {
  chunks: Array<{ seq: number; data: string }>
  currentSeq: number
  prelude: string
}

/** One hub's terminals on this computer (the computer's `DirectPtyService`). */
export interface DirectPtyService {
  attach(
    sessionId: string,
    afterSeq: number
  ): { exists: boolean; size: { cols: number; rows: number } | null; buffer: DirectBuffer }
  getBufferSince(sessionId: string, afterSeq: number): DirectBuffer
  /** False when the session has no live process. */
  write(sessionId: string, data: string): boolean
  watch(
    sessionId: string,
    onData: (chunk: { seq: number; data: string }) => void,
    onEnd: (reason: 'exit' | 'replaced' | 'disposed') => void
  ): (() => void) | null
}

/** One hub's chat on this computer (the computer's `DirectChatService`). */
export interface DirectChatService {
  read(
    tabId: string,
    epoch: number,
    method: 'getReplay' | 'openTimeline' | 'timelinePages' | 'searchTimeline',
    args: unknown[]
  ): Promise<unknown>
  watch(
    tabId: string,
    epoch: number,
    onEvent: (event: DirectChatEvent) => void,
    onEnd: (reason: 'epoch' | 'deleted' | 'disposed') => void
  ): (() => void) | null
}

/** One chat event, in the hub's `chat.onEvent` shape. */
export interface DirectChatEvent {
  tabId: string
  event: unknown
  seq: number
  live?: number
  at?: number
}

/** What the computer serves, per hub link (a grant names its hub). */
export interface DirectRouterServices {
  pty(hubKey: string): DirectPtyService | null
  chat?(hubKey: string): DirectChatService | null
}

/** One chunk of a session's output, as the hub's `pty.onData` emits it. */
export interface DirectPtyData {
  sessionId: string
  seq: number
  data: string
}

const t = initTRPC.context<DirectContext>().create({ transformer: wireSuperjson })

const sessionId = z.string().min(1).max(200)

function noCapability(): TRPCError {
  return new TRPCError({ code: 'FORBIDDEN', message: 'no capability for this session' })
}

const tabId = z.string().min(1).max(200)

export function createDirectRouter(services: DirectRouterServices) {
  /** The hub's terminals for a session this socket holds a grant on. */
  function ptyFor(ctx: DirectContext, id: string): DirectPtyService {
    const grant = ctx.socket.grantFor({ kind: 'pty', sessionId: id })
    const service = grant ? services.pty(grant.hubKey) : null
    if (!service) throw noCapability()
    return service
  }

  /** The hub's chat for a tab this socket holds a grant on, and the granted epoch. */
  function chatFor(ctx: DirectContext, id: string): { service: DirectChatService; epoch: number } {
    const grant = ctx.socket.grantFor({ kind: 'chat', tabId: id })
    const service = grant ? services.chat?.(grant.hubKey) : null
    if (!grant || grant.resource.kind !== 'chat' || !service) throw noCapability()
    return { service, epoch: grant.resource.epoch }
  }

  return t.router({
    /** Reachability + version, once authenticated. */
    ping: t.procedure.query(() => ({ protocol: DIRECT_ROUTER_PROTOCOL })),
    /**
     * Present another capability on this socket: a renewal before the current one
     * expires, or a grant for another session/tab on the same computer.
     */
    authorize: t.procedure
      .input(z.object({ token: z.string().min(1).max(200) }))
      .mutation(({ ctx, input }): DirectGrantView => {
        const grant = ctx.socket.authorize(input.token)
        if (!grant)
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'unknown or expired capability' })
        return grant
      }),

    pty: t.router({
      /** Like the hub's `pty.attach` minus `state` (the client reads that from the hub). */
      attach: t.procedure
        .input(z.object({ sessionId, afterSeq: z.number().int().min(-1) }))
        .query(({ ctx, input }) =>
          ptyFor(ctx, input.sessionId).attach(input.sessionId, input.afterSeq)
        ),
      getBufferSince: t.procedure
        .input(z.object({ sessionId, afterSeq: z.number().int().min(-1) }))
        .query(({ ctx, input }) =>
          ptyFor(ctx, input.sessionId).getBufferSince(input.sessionId, input.afterSeq)
        ),
      /**
       * Keystrokes and pastes. The computer writes them and reports submits and Esc
       * to the hub (`pty-input`), so attention and turn tracking match a relayed
       * write. Resize, interrupt and touch stay hub calls (it owns those records).
       */
      write: t.procedure
        .input(z.object({ sessionId, data: z.string().max(1_000_000) }))
        .mutation(({ ctx, input }) =>
          ptyFor(ctx, input.sessionId).write(input.sessionId, input.data)
        ),
      /**
       * Live output. Completes when the process ends; errors FORBIDDEN when the
       * socket's grant on the session ends (the client re-issues through the hub).
       * Subscribe BEFORE `attach`, then drop chunks at or below the attach's
       * `currentSeq`: gap-free, as with the hub.
       */
      onData: t.procedure.input(z.object({ sessionId })).subscription(({ ctx, input }) => {
        const service = ptyFor(ctx, input.sessionId)
        return observable<DirectPtyData>((emit) => {
          const stopWatch = service.watch(
            input.sessionId,
            (chunk) => emit.next({ sessionId: input.sessionId, seq: chunk.seq, data: chunk.data }),
            () => emit.complete()
          )
          if (!stopWatch) {
            emit.complete()
            return () => undefined
          }
          const stopGrant = ctx.socket.onTargetEnded(
            { kind: 'pty', sessionId: input.sessionId },
            () => emit.error(noCapability())
          )
          return () => {
            stopWatch()
            stopGrant()
          }
        })
      })
    }),

    /**
     * Chat history reads and the live event stream (the hub's `chat.*` shapes). The
     * computer checks the granted ownership epoch on every read, as for a relayed
     * one. Commands that need the hub's coordination (send, queue, rewind, …) stay
     * hub calls.
     */
    chat: t.router({
      getReplay: t.procedure
        .input(z.object({ tabId, afterSeq: z.number() }))
        .query(({ ctx, input }) => {
          const { service, epoch } = chatFor(ctx, input.tabId)
          return service.read(input.tabId, epoch, 'getReplay', [input.tabId, input.afterSeq])
        }),
      openTimeline: t.procedure
        .input(z.object({ tabId, version: z.string().max(200) }))
        .query(({ ctx, input }) => {
          const { service, epoch } = chatFor(ctx, input.tabId)
          return service.read(input.tabId, epoch, 'openTimeline', [input.tabId, input.version])
        }),
      timelinePages: t.procedure
        .input(
          z.object({
            tabId,
            pages: z.array(z.number().int().nonnegative()).max(512),
            asOfSeq: z.number().int(),
            epoch: z.number().int()
          })
        )
        .query(({ ctx, input }) => {
          const { service, epoch } = chatFor(ctx, input.tabId)
          return service.read(input.tabId, epoch, 'timelinePages', [
            input.tabId,
            input.pages,
            input.asOfSeq,
            input.epoch
          ])
        }),
      searchTimeline: t.procedure
        .input(z.object({ tabId, query: z.string().max(1000) }))
        .query(({ ctx, input }) => {
          const { service, epoch } = chatFor(ctx, input.tabId)
          return service.read(input.tabId, epoch, 'searchTimeline', [input.tabId, input.query])
        }),
      /**
       * The tab's events. Errors FORBIDDEN when the grant ends or the conversation
       * moves (its epoch changed) or is deleted: the client goes back to the hub.
       */
      onEvent: t.procedure.input(z.object({ tabId })).subscription(({ ctx, input }) => {
        const { service, epoch } = chatFor(ctx, input.tabId)
        return observable<DirectChatEvent>((emit) => {
          const stopWatch = service.watch(
            input.tabId,
            epoch,
            (event) => emit.next(event),
            () => emit.error(noCapability())
          )
          if (!stopWatch) {
            emit.error(noCapability())
            return () => undefined
          }
          const stopGrant = ctx.socket.onTargetEnded({ kind: 'chat', tabId: input.tabId }, () =>
            emit.error(noCapability())
          )
          return () => {
            stopWatch()
            stopGrant()
          }
        })
      })
    })
  })
}

export type DirectRouter = ReturnType<typeof createDirectRouter>
