import { observable } from '@trpc/server/observable'
import type { AgentLifecycleEvent } from '@slayzone/terminal-contracts'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getAgentLifecycleEvents } from './agent-lifecycle-events'

export const agentLifecycleRouter = router({
  onEvent: publicProcedure.subscription(() =>
    observable<AgentLifecycleEvent>((emit) => {
      const ev = getAgentLifecycleEvents()
      const handler = (event: AgentLifecycleEvent): void => emit.next(event)
      ev.on('event', handler)
      return () => ev.off('event', handler)
    })
  )
})

export type AgentLifecycleRouter = typeof agentLifecycleRouter

/**
 * Where this router sits in the app router. `@slayzone/api` mounts `agentLifecycleRouter` at
 * `agentLifecycle` and asserts the slice in its `router.ts`.
 */
export type AgentLifecycleMounts = { agentLifecycle: AgentLifecycleRouter }
