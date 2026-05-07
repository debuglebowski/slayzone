import { router } from './trpc'
import { agentTurnsRouter } from './routers/agent-turns'
import { automationsRouter } from './routers/automations'
import { diagnosticsRouter } from './routers/diagnostics'
import { fileEditorRouter } from './routers/file-editor'
import { historyRouter } from './routers/history'
import { projectsRouter } from './routers/projects'
import { settingsRouter } from './routers/settings'
import { tagsRouter } from './routers/tags'
import { taskTerminalsRouter } from './routers/task-terminals'
import { testPanelRouter } from './routers/test-panel'
import { usageAnalyticsRouter } from './routers/usage-analytics'

export const appRouter = router({
  agentTurns: agentTurnsRouter,
  automations: automationsRouter,
  diagnostics: diagnosticsRouter,
  fileEditor: fileEditorRouter,
  history: historyRouter,
  projects: projectsRouter,
  settings: settingsRouter,
  tags: tagsRouter,
  taskTerminals: taskTerminalsRouter,
  testPanel: testPanelRouter,
  usageAnalytics: usageAnalyticsRouter,
})

export type AppRouter = typeof appRouter
