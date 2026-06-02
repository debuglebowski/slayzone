import { router } from './trpc'
import { agentTurnsRouter } from './routers/agent-turns'
import { historyRouter } from './routers/history'
import { tagsRouter } from './routers/tags'

export const appRouter = router({
  agentTurns: agentTurnsRouter,
  history: historyRouter,
  tags: tagsRouter
})

export type AppRouter = typeof appRouter
