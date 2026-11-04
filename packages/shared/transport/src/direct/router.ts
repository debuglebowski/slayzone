/**
 * The client ↔ computer direct-link router (docs/direct-link.md).
 *
 * The computer serves it on `/direct/v1`. Desktop and mobile clients call it with
 * the same tRPC client stack they use for the hub (ws link, superjson wire), so a
 * client path can switch between the hub relay and the direct link with no change
 * in data shapes.
 *
 * Pure: no node imports. The computer's listener supplies {@link DirectSocket} per
 * connection, which holds the capabilities that socket presented; every procedure
 * that touches a session or tab first asks it for a live grant on that resource.
 *
 * @module transport/direct/router
 */
import { initTRPC, TRPCError } from '@trpc/server'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import { z } from 'zod'

/** Wire version (mirrors computer-transport `DIRECT_LINK_PROTOCOL`). */
export const DIRECT_ROUTER_PROTOCOL = 1

/** What a grant lets its bearer touch (structurally computer-transport's `DirectResource`). */
export type DirectGrantResource =
  | { kind: 'pty'; sessionId: string }
  | { kind: 'chat'; tabId: string; epoch: number }

export interface DirectGrantView {
  grantId: string
  resource: DirectGrantResource
  /** Remaining lifetime on the computer's clock. */
  expiresInMs: number
}

/** One authenticated client connection, as the computer's listener holds it. */
export interface DirectSocket {
  /** Add (or renew with) a capability. Null: unknown or expired token. */
  authorize(token: string): DirectGrantView | null
}

export interface DirectContext {
  socket: DirectSocket
}

const t = initTRPC.context<DirectContext>().create({ transformer: wireSuperjson })

export function createDirectRouter() {
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
        if (!grant) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'unknown or expired capability' })
        return grant
      })
  })
}

export type DirectRouter = ReturnType<typeof createDirectRouter>
