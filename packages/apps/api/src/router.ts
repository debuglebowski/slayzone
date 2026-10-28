import { router, type MountedRouter, type RouterMounts } from '@slayzone/trpc-server'
// The composition root: register the per-procedure tables with the gate chain, and wire
// the host seams of domain-owned routers, before any router is served.
import './procedure-policy'
import './settings-host-wiring'
import './domain-router-deps'
import { telemetryRouter, type TelemetryMounts } from '@slayzone/telemetry/server'
import {
  agentLifecycleRouter,
  chatRouter,
  ptyRouter,
  type AgentLifecycleMounts,
  type ChatMounts,
  type PtyMounts
} from '@slayzone/terminal/server'
import { processesRouter, type ProcessesMounts } from '@slayzone/processes/server'
import { appLevelRouter } from './routers/app'
import { aiConfigRouter, type AiConfigMounts } from '@slayzone/ai-config/server'
import {
  agentPromptsRouter,
  agentTurnsRouter,
  type AgentTurnsMounts
} from '@slayzone/agent-turns/server'
import { automationsRouter, type AutomationsMounts } from '@slayzone/automations/server'
import { diagnosticsRouter } from './routers/diagnostics'
import { feedbackRouter, type FeedbackMounts } from '@slayzone/feedback/server'
import { fileEditorRouter } from './routers/file-editor'
import { historyRouter, type HistoryMounts } from '@slayzone/history/server'
import { hubRouter } from './routers/hub'
import { integrationsRouter, type IntegrationsMounts } from '@slayzone/integrations/server'
import { menuRouter } from './routers/menu'
import { notifyRouter } from './routers/notify'
import {
  projectsRouter,
  projectGroupsRouter,
  type ProjectGroupsMounts,
  type ProjectsMounts
} from '@slayzone/projects/server'
import { computersRouter } from './routers/computers'
import { workspaceRouter } from './routers/workspace'
import { settingsRouter, type SettingsMounts } from '@slayzone/settings/server'
import { tagsRouter, type TagsMounts } from '@slayzone/tags/server'
import {
  taskRouter,
  agentSessionsRouter,
  templateRouter,
  type AgentSessionsMounts,
  type TemplateMounts,
  type TaskMounts
} from '@slayzone/task/server'
import { artifactsRouter, type ArtifactsMounts } from '@slayzone/task-artifacts/server'
import { taskTerminalsRouter, type TaskTerminalsMounts } from '@slayzone/task-terminals/server'
import { testPanelRouter, type TestPanelMounts } from '@slayzone/test-panel/server'
import { usageAnalyticsRouter } from './routers/usage-analytics'
import { worktreesRouter, type WorktreesMounts } from '@slayzone/worktrees/server'

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
  AssertAppSlice<IsAppSlice<AgentLifecycleMounts>>,
  AssertAppSlice<IsAppSlice<AiConfigMounts>>,
  AssertAppSlice<IsAppSlice<AgentSessionsMounts>>,
  AssertAppSlice<IsAppSlice<AgentTurnsMounts>>,
  AssertAppSlice<IsAppSlice<ArtifactsMounts>>,
  AssertAppSlice<IsAppSlice<AutomationsMounts>>,
  AssertAppSlice<IsAppSlice<ChatMounts>>,
  AssertAppSlice<IsAppSlice<FeedbackMounts>>,
  AssertAppSlice<IsAppSlice<HistoryMounts>>,
  AssertAppSlice<IsAppSlice<IntegrationsMounts>>,
  AssertAppSlice<IsAppSlice<ProcessesMounts>>,
  AssertAppSlice<IsAppSlice<ProjectGroupsMounts>>,
  AssertAppSlice<IsAppSlice<ProjectsMounts>>,
  AssertAppSlice<IsAppSlice<PtyMounts>>,
  AssertAppSlice<IsAppSlice<SettingsMounts>>,
  AssertAppSlice<IsAppSlice<TagsMounts>>,
  AssertAppSlice<IsAppSlice<TaskMounts>>,
  AssertAppSlice<IsAppSlice<TaskTerminalsMounts>>,
  AssertAppSlice<IsAppSlice<TelemetryMounts>>,
  AssertAppSlice<IsAppSlice<TemplateMounts>>,
  AssertAppSlice<IsAppSlice<TestPanelMounts>>,
  AssertAppSlice<IsAppSlice<WorktreesMounts>>
]
