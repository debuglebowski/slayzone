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
