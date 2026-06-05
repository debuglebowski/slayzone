import { router } from './trpc'
import { agentTurnsRouter } from './routers/agent-turns'
import { automationsRouter } from './routers/automations'
import { chatRouter } from './routers/chat'
import { diagnosticsRouter } from './routers/diagnostics'
import { fileEditorRouter } from './routers/file-editor'
import { historyRouter } from './routers/history'
import { integrationsRouter } from './routers/integrations'
import { projectsRouter } from './routers/projects'
import { ptyRouter } from './routers/pty'
import { settingsRouter } from './routers/settings'
import { tagsRouter } from './routers/tags'
import { taskRouter } from './routers/task'
import { templateRouter } from './routers/template'
import { artifactsRouter } from './routers/artifacts'
import { taskTerminalsRouter } from './routers/task-terminals'
import { testPanelRouter } from './routers/test-panel'
import { usageAnalyticsRouter } from './routers/usage-analytics'
import { worktreesRouter } from './routers/worktrees'

export const appRouter = router({
  agentTurns: agentTurnsRouter,
  automations: automationsRouter,
  artifacts: artifactsRouter,
  chat: chatRouter,
  diagnostics: diagnosticsRouter,
  fileEditor: fileEditorRouter,
  history: historyRouter,
  integrations: integrationsRouter,
  projects: projectsRouter,
  pty: ptyRouter,
  settings: settingsRouter,
  tags: tagsRouter,
  task: taskRouter,
  template: templateRouter,
  taskTerminals: taskTerminalsRouter,
  testPanel: testPanelRouter,
  usageAnalytics: usageAnalyticsRouter,
  worktrees: worktreesRouter
})

export type AppRouter = typeof appRouter
