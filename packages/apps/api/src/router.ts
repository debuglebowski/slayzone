import { router, type MountedRouter, type RouterMounts } from '@slayzone/trpc-server'
// The composition root: register the per-procedure tables with the gate chain, and add
// the composition's host deps to the context type, before any router is served.
import './procedure-policy'
import './automation-engine-context'
import { telemetryRouter } from '@slayzone/telemetry/server'
import { agentLifecycleRouter } from '@slayzone/terminal/server'
import { processesRouter } from '@slayzone/processes/server'
import { appLevelRouter } from './routers/app'
import { aiConfigRouter } from './routers/ai-config'
import {
  agentPromptsRouter,
  agentTurnsRouter,
  type AgentTurnsMounts
} from '@slayzone/agent-turns/server'
import { agentSessionsRouter } from '@slayzone/task/server'
import { automationsRouter } from './routers/automations'
import { chatRouter } from './routers/chat'
import { diagnosticsRouter } from './routers/diagnostics'
import { feedbackRouter } from '@slayzone/feedback/server'
import { fileEditorRouter } from './routers/file-editor'
import { historyRouter } from '@slayzone/history/server'
import { hubRouter } from './routers/hub'
import { integrationsRouter } from './routers/integrations'
import { menuRouter } from './routers/menu'
import { notifyRouter } from './routers/notify'
import { projectsRouter } from './routers/projects'
import { projectGroupsRouter } from '@slayzone/projects/server'
import { ptyRouter } from './routers/pty'
import { computersRouter } from './routers/computers'
import { workspaceRouter } from './routers/workspace'
import { settingsRouter } from './routers/settings'
import { tagsRouter, type TagsMounts } from '@slayzone/tags/server'
import { taskRouter } from './routers/task'
import { templateRouter } from '@slayzone/task/server'
import { artifactsRouter } from './routers/artifacts'
import { taskTerminalsRouter } from '@slayzone/task-terminals/server'
import { testPanelRouter, type TestPanelMounts } from '@slayzone/test-panel/server'
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

// ---------------------------------------------------------------------------
// Domain router slices. A domain's client is typed against the routers it mounts
// (`typedTrpc<XMounts>()` in `@slayzone/transport/client`), not the whole
// AppRouter. That view shares the one runtime client, and tRPC calls are path-based,
// so it is sound exactly when the slice IS this router's slice at the same keys.
// One line per migrated domain: a wrong mount key, a renamed key here, or a slice
// type that drifted from what is mounted fails `pnpm typecheck`.
// ---------------------------------------------------------------------------

type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type IsAppSlice<TMounts extends RouterMounts> =
  Exactly<
    MountedRouter<TMounts>['_def']['record'],
    Pick<AppRouter['_def']['record'], keyof TMounts & keyof AppRouter['_def']['record']>
  > extends true
    ? keyof TMounts extends keyof AppRouter['_def']['record']
      ? true
      : false
    : false
type AssertAppSlice<T extends true> = T

export type DomainRouterSlices = [
  AssertAppSlice<IsAppSlice<AgentTurnsMounts>>,
  AssertAppSlice<IsAppSlice<TagsMounts>>,
  AssertAppSlice<IsAppSlice<TestPanelMounts>>
]
