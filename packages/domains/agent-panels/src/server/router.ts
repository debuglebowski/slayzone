// The `app.floatingAgent` router: delegates to the host through the seam in
// `./router-deps`. `@slayzone/api` mounts it at `app.floatingAgent`.
import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getAgentPanelsHost, type FloatingAgentState } from './router-deps'

// Floating global agent panel — 10 ops + 3 streaming subs. Same ops/emitter
// back the still-live `floating-global-agent-panel:*` IPC (slice 5 cutover).
export const appFloatingAgentRouter = router({
  setEnabled: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => getAgentPanelsHost().floatingAgent.setEnabled(input.enabled)),
  setSessionId: publicProcedure
    .input(z.object({ sessionId: z.string().nullable() }))
    .mutation(({ input }) => getAgentPanelsHost().floatingAgent.setSessionId(input.sessionId)),
  setPanelOpen: publicProcedure
    .input(z.object({ isOpen: z.boolean() }))
    .mutation(({ input }) => getAgentPanelsHost().floatingAgent.setPanelOpen(input.isOpen)),
  toggleCollapse: publicProcedure.mutation(() =>
    getAgentPanelsHost().floatingAgent.toggleCollapse()
  ),
  resetSize: publicProcedure.mutation(() => getAgentPanelsHost().floatingAgent.resetSize()),
  detach: publicProcedure.mutation(() => getAgentPanelsHost().floatingAgent.detach()),
  reattach: publicProcedure.mutation(() => getAgentPanelsHost().floatingAgent.reattach()),
  getState: publicProcedure.query(() => getAgentPanelsHost().floatingAgent.getState()),
  getSession: publicProcedure.query(() => getAgentPanelsHost().floatingAgent.getSession()),
  getConfig: publicProcedure.query(() => getAgentPanelsHost().floatingAgent.getConfig()),
  onState: publicProcedure.subscription(() =>
    observable<FloatingAgentState>((emit) => {
      const handler = (payload: FloatingAgentState): void => emit.next(payload)
      const ev = getAgentPanelsHost().floatingAgent.events
      ev.on('state', handler)
      return () => ev.off('state', handler)
    })
  ),
  onSessionChanged: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const handler = (): void => emit.next()
      const ev = getAgentPanelsHost().floatingAgent.events
      ev.on('session-changed', handler)
      return () => ev.off('session-changed', handler)
    })
  ),
  onCollapseChanged: publicProcedure.subscription(() =>
    observable<{ collapsed: boolean }>((emit) => {
      const handler = (collapsed: boolean): void => emit.next({ collapsed })
      const ev = getAgentPanelsHost().floatingAgent.events
      ev.on('collapse-changed', handler)
      return () => ev.off('collapse-changed', handler)
    })
  )
})

export type AppFloatingAgentRouter = typeof appFloatingAgentRouter
/** Where `@slayzone/api` mounts it: `app.floatingAgent`. */
export type AppFloatingAgentMounts = { app: { floatingAgent: AppFloatingAgentRouter } }
