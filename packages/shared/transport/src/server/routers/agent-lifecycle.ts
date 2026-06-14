import { observable } from '@trpc/server/observable'
import type { AgentLifecycleEvent } from '@slayzone/terminal/shared'
import { router, publicProcedure } from '../trpc'
import { getAgentLifecycleEvents } from '../app-deps'

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
