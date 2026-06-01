import { router } from './trpc'
import { agentTurnsRouter } from './routers/agent-turns'
import { tagsRouter } from './routers/tags'

export const appRouter = router({
  agentTurns: agentTurnsRouter,
  tags: tagsRouter
})

export type AppRouter = typeof appRouter
