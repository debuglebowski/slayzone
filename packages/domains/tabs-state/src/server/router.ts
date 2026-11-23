import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { TypedEmitter } from '@slayzone/platform/events'
import { router, publicProcedure, type TrpcContext } from '@slayzone/trpc-server'
import { closeTab, listOpenTabs, openTab, reorderTabs } from './open-tabs-store'

/**
 * `openTabs`: the caller's open task tabs on this hub (`open-tabs-store.ts`). Every
 * client of one user reads and writes the same list — the desktop tab bar mirrors its
 * tabs of this hub's tasks here, the iPad shows and edits them — and `onChanged` tells
 * that user's other clients to read it again. Which tab is ACTIVE stays on each
 * client: two screens show two tasks.
 */
type OpenTabsEvents = { changed: [user: string] }
const openTabsEvents = new TypedEmitter<OpenTabsEvents>()
openTabsEvents.setMaxListeners(0)

/** The user from the verified connection; '' on a hub without login. */
const userOf = (ctx: TrpcContext): string => ctx.principal?.userId ?? ''

const changed = (ctx: TrpcContext, didChange: boolean): void => {
  if (didChange) openTabsEvents.emit('changed', userOf(ctx))
}

const taskInput = z.object({ taskId: z.string().min(1) })

export const openTabsRouter = router({
  list: publicProcedure.query(({ ctx }) => listOpenTabs(ctx.db, userOf(ctx))),

  open: publicProcedure.input(taskInput).mutation(async ({ ctx, input }) => {
    changed(ctx, await openTab(ctx.db, userOf(ctx), input.taskId))
  }),

  close: publicProcedure.input(taskInput).mutation(async ({ ctx, input }) => {
    changed(ctx, await closeTab(ctx.db, userOf(ctx), input.taskId))
  }),

  reorder: publicProcedure
    .input(z.object({ taskIds: z.array(z.string().min(1)) }))
    .mutation(async ({ ctx, input }) => {
      changed(ctx, await reorderTabs(ctx.db, userOf(ctx), input.taskIds))
    }),

  /** A refetch ping, only for the caller's own tabs (another user's change is not sent). */
  onChanged: publicProcedure.subscription(({ ctx }) =>
    observable<Record<string, never>>((emit) => {
      const me = userOf(ctx)
      const handler = (user: string): void => {
        if (user === me) emit.next({})
      }
      openTabsEvents.on('changed', handler)
      return () => openTabsEvents.off('changed', handler)
    })
  )
})

export type OpenTabsRouter = typeof openTabsRouter

/**
 * Where this domain's router sits in the app router. `@slayzone/api` mounts
 * `openTabsRouter` at `openTabs` (and asserts the slice in its `router.ts`).
 */
export type OpenTabsMounts = { openTabs: OpenTabsRouter }
