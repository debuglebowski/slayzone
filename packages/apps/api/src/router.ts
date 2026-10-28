import { router } from '@slayzone/trpc-server'
// The composition root: register the per-procedure tables with the gate chain, and add
// the composition's host deps to the context type, before any router is served.
import './procedure-policy'
import './automation-engine-context'
import { appLevelRouter } from './routers/app'
import { agentLifecycleRouter } from './routers/agent-lifecycle'
import { aiConfigRouter } from './routers/ai-config'
import { agentPromptsRouter, agentTurnsRouter } from '@slayzone/agent-turns/server'
import { agentSessionsRouter } from '@slayzone/task/server'
import { automationsRouter } from './routers/automations'
import { chatRouter } from './routers/chat'
import { diagnosticsRouter } from './routers/diagnostics'
import { feedbackRouter } from './routers/feedback'
import { fileEditorRouter } from './routers/file-editor'
import { historyRouter } from '@slayzone/history/server'
import { hubRouter } from './routers/hub'
import { integrationsRouter } from './routers/integrations'
import { menuRouter } from './routers/menu'
import { notifyRouter } from './routers/notify'
import { processesRouter } from './routers/processes'
import { projectsRouter } from './routers/projects'
import { projectGroupsRouter } from './routers/project-groups'
import { ptyRouter } from './routers/pty'
import { computersRouter } from './routers/computers'
import { workspaceRouter } from './routers/workspace'
import { settingsRouter } from './routers/settings'
import { tagsRouter } from './routers/tags'
import { taskRouter } from './routers/task'
import { telemetryRouter } from './routers/telemetry'
import { templateRouter } from './routers/template'
import { artifactsRouter } from './routers/artifacts'
import { taskTerminalsRouter } from './routers/task-terminals'
import { testPanelRouter } from './routers/test-panel'
import { usageAnalyticsRouter } from './routers/usage-analytics'
import { worktreesRouter } from './routers/worktrees'

export const appRouter = router({
  app: appLevelRouter,
  agentLifecycle: agentLifecycleRouter,
  aiConfig: aiConfigRouter,
  agentPrompts: agentPromptsRouter,
  agentSessions: agentSessionsRouter,
  agentTurns: agentTurnsRouter,
  automations: automationsRouter,
  artifacts: artifactsRouter,
  chat: chatRouter,
  diagnostics: diagnosticsRouter,
  feedback: feedbackRouter,
  fileEditor: fileEditorRouter,
  history: historyRouter,
  hub: hubRouter,
  integrations: integrationsRouter,
  menu: menuRouter,
  notify: notifyRouter,
  processes: processesRouter,
  projects: projectsRouter,
  projectGroups: projectGroupsRouter,
  pty: ptyRouter,
  computers: computersRouter,
  settings: settingsRouter,
  workspace: workspaceRouter,
  tags: tagsRouter,
  task: taskRouter,
  telemetry: telemetryRouter,
  template: templateRouter,
  taskTerminals: taskTerminalsRouter,
  testPanel: testPanelRouter,
  usageAnalytics: usageAnalyticsRouter,
  worktrees: worktreesRouter
})

export type AppRouter = typeof appRouter
