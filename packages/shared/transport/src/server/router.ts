import { router } from './trpc'
import { agentTurnsRouter } from './routers/agent-turns'
import { automationsRouter } from './routers/automations'
import { chatRouter } from './routers/chat'
import { diagnosticsRouter } from './routers/diagnostics'
import { fileEditorRouter } from './routers/file-editor'
import { historyRouter } from './routers/history'
import { tagsRouter } from './routers/tags'
import { testPanelRouter } from './routers/test-panel'
import { usageAnalyticsRouter } from './routers/usage-analytics'

export const appRouter = router({
  agentTurns: agentTurnsRouter,
  automations: automationsRouter,
  chat: chatRouter,
  diagnostics: diagnosticsRouter,
  fileEditor: fileEditorRouter,
  history: historyRouter,
  tags: tagsRouter,
  testPanel: testPanelRouter,
  usageAnalytics: usageAnalyticsRouter
})

export type AppRouter = typeof appRouter
