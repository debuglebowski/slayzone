import { router } from './trpc'
import { agentTurnsRouter } from './routers/agent-turns'
import { diagnosticsRouter } from './routers/diagnostics'
import { historyRouter } from './routers/history'
import { projectsRouter } from './routers/projects'
import { tagsRouter } from './routers/tags'

export const appRouter = router({
  agentTurns: agentTurnsRouter,
  diagnostics: diagnosticsRouter,
  history: historyRouter,
  projects: projectsRouter,
  tags: tagsRouter,
})

export type AppRouter = typeof appRouter
