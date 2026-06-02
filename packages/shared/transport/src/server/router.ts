import { router } from './trpc'
import { agentTurnsRouter } from './routers/agent-turns'
import { automationsRouter } from './routers/automations'
import { diagnosticsRouter } from './routers/diagnostics'
import { historyRouter } from './routers/history'
import { tagsRouter } from './routers/tags'
import { usageAnalyticsRouter } from './routers/usage-analytics'

export const appRouter = router({
  agentTurns: agentTurnsRouter,
  automations: automationsRouter,
  diagnostics: diagnosticsRouter,
  history: historyRouter,
  tags: tagsRouter,
  usageAnalytics: usageAnalyticsRouter
})

export type AppRouter = typeof appRouter
