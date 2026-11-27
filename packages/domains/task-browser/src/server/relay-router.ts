// `app.browserRelay` — the wire for `./browser-relay.ts`. A client's browser panel
// serves its task's live tabs here; the hub's REST browser routes reach them through
// the relay. The web views never touch the hub: the panel drives its own client's
// browser host directly (`../shared/browser-host.ts`).
import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { publicProcedure, router, type TrpcContext } from '@slayzone/trpc-server'
import type { BrowserRelayFrame } from '../shared'
import type { BrowserRelay } from './browser-relay'

export interface BrowserRelayRouterDeps {
  relay: BrowserRelay
  /** Genuine user input in a task's browser panel — the hub's idle-close clock. */
  onEngaged: (taskId: string) => void
}

let deps: BrowserRelayRouterDeps | null = null

export function setBrowserRelayRouterDeps(next: BrowserRelayRouterDeps): void {
  deps = next
}

function relayDeps(): BrowserRelayRouterDeps {
  if (!deps)
    throw new Error(
      'browser relay deps not initialized — the hub wires them when it composes the server'
    )
  return deps
}

/** The principal a host is bound to: the user on a hub with login, else null. */
const principalKey = (ctx: TrpcContext): string | null => ctx.principal?.userId ?? null

/** A host id that is not the caller's reads as "no such host", never as a 500. */
function onHost<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof Error && err.message === 'Unknown browser host') {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
    }
    throw err
  }
}

const id = z.string().min(1).max(200)

export const appBrowserRelayRouter = router({
  /** A panel for `taskId` comes online: `hello` with its host id, then requests. */
  serve: publicProcedure
    .input(z.object({ taskId: id, clientKey: id }))
    .subscription(({ input, ctx }) =>
      observable<BrowserRelayFrame>((emit) => {
        const { detach } = relayDeps().relay.attachHost({
          taskId: input.taskId,
          principalKey: principalKey(ctx),
          clientKey: input.clientKey,
          send: (frame) => emit.next(frame)
        })
        return detach
      })
    ),
  /** The host's live tabs, in full (idempotent). */
  sync: publicProcedure
    .input(
      z.object({
        hostId: id,
        tabIds: z.array(id).max(500),
        activeTabId: id.nullable(),
        isolatedTabIds: z.array(id).max(500).optional(),
        primary: z.boolean().optional()
      })
    )
    .mutation(({ input, ctx }) => onHost(() => relayDeps().relay.sync(principalKey(ctx), input))),
  /** A desktop app that can host the browser panel is connected (for as long as this
   *  stays open), so `slay browser` can say "no desktop app" when none is. */
  present: publicProcedure.subscription(({ ctx }) =>
    observable<never>(() => relayDeps().relay.attachClient(principalKey(ctx)))
  ),
  /** The client is still working on a request (a slow page load): no timeout yet. */
  progress: publicProcedure
    .input(z.object({ hostId: id, requestId: id }))
    .mutation(({ input, ctx }) =>
      onHost(() => relayDeps().relay.progress(principalKey(ctx), input))
    ),
  /** The answer to one relayed request. */
  reply: publicProcedure
    .input(
      z.discriminatedUnion('ok', [
        z.object({ hostId: id, requestId: id, ok: z.literal(true), result: z.unknown() }),
        z.object({ hostId: id, requestId: id, ok: z.literal(false), error: z.string().max(10_000) })
      ])
    )
    .mutation(({ input, ctx }) =>
      onHost(() =>
        relayDeps().relay.reply(
          principalKey(ctx),
          input.ok
            ? { hostId: input.hostId, requestId: input.requestId, ok: true, result: input.result }
            : { hostId: input.hostId, requestId: input.requestId, ok: false, error: input.error }
        )
      )
    ),
  /**
   * The user used task `taskId`'s browser on client `clientKey` — input in any of the
   * task's web views (browser tabs AND web panels, panel open or not) or its panel.
   * Keeps the task's agent awake (idle-close) and makes that client the one
   * `slay browser` reaches. Sent by one app-level listener per window, so it needs no
   * mounted panel. `hostId` (a panel's own chrome was used): that panel, of several
   * browser panels of the task on the client, is the one `slay browser` reaches.
   */
  engaged: publicProcedure
    .input(z.object({ taskId: id, clientKey: id, hostId: id.optional() }))
    .mutation(({ input, ctx }) => {
      const { relay, onEngaged } = relayDeps()
      relay.noteUse(principalKey(ctx), input.clientKey, input.taskId, input.hostId)
      onEngaged(input.taskId)
    })
})

export type AppBrowserRelayRouter = typeof appBrowserRelayRouter
/** The mount shape — `app.browserRelay` — for a client typing against just this router. */
export type AppBrowserRelayMounts = { app: { browserRelay: AppBrowserRelayRouter } }
