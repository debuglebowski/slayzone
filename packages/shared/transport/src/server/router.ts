import { router } from './trpc'
import { agentTurnsRouter } from './routers/agent-turns'
import { diagnosticsRouter } from './routers/diagnostics'
import { historyRouter } from './routers/history'
import { tagsRouter } from './routers/tags'

export const appRouter = router({
  agentTurns: agentTurnsRouter,
  diagnostics: diagnosticsRouter,
  history: historyRouter,
  tags: tagsRouter
})

export type AppRouter = typeof appRouter
