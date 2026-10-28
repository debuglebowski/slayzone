import {
  router,
  type AssertSlice,
  type IsMountedSlice,
  type RouterMounts
} from '@slayzone/trpc-server'
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
import {
  menuRouter,
  type MenuMounts,
  type AppAuthMounts,
  type AppClipboardMounts,
  type AppDialogMounts,
  type AppFilesMounts,
  type AppMetaMounts,
  type AppScreenshotMounts,
  type AppShellMounts,
  type AppShortcutsMounts,
  type AppTaskWindowsMounts,
  type AppWindowMounts
} from '@slayzone/host-capabilities/server'
import type { AppBackupMounts, AppExportImportMounts } from '@slayzone/settings/server'
import {
  usageAnalyticsRouter,
  type AppLeaderboardMounts,
  type UsageAnalyticsMounts
} from '@slayzone/usage-analytics/server'
import type { AppUsageMounts } from '@slayzone/terminal/server'
import type { AppFeedbackMounts } from '@slayzone/feedback/server'
import type { AppBrowserMounts, AppWebviewMounts } from '@slayzone/task-browser/server'
import type { AppFloatingAgentMounts } from '@slayzone/agent-panels/server'
import { aiConfigRouter, type AiConfigMounts } from '@slayzone/ai-config/server'
import {
  agentPromptsRouter,
  agentTurnsRouter,
  type AgentTurnsMounts
} from '@slayzone/agent-turns/server'
import { automationsRouter, type AutomationsMounts } from '@slayzone/automations/server'
import { diagnosticsRouter, type DiagnosticsMounts } from '@slayzone/diagnostics/server'
import { feedbackRouter, type FeedbackMounts } from '@slayzone/feedback/server'
import {
  fileEditorRouter,
  workspaceRouter,
  type FileEditorMounts,
  type WorkspaceMounts
} from '@slayzone/file-editor/server'
import { historyRouter, type HistoryMounts } from '@slayzone/history/server'
import { hubRouter } from './routers/hub'
import { integrationsRouter, type IntegrationsMounts } from '@slayzone/integrations/server'
import { notifyRouter, type NotifyMounts } from '@slayzone/notify/server'
import {
  projectsRouter,
  projectGroupsRouter,
  type ProjectGroupsMounts,
  type ProjectsMounts
} from '@slayzone/projects/server'
import { computersRouter, type ComputersMounts } from '@slayzone/computers/server'
import { settingsRouter, type SettingsMounts } from '@slayzone/settings-core/server'
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
// type that drifted from what is mounted fails `pnpm typecheck`. A mount may be
// nested (`{ app: { meta: MetaRouter } }`): the router at `app.meta`, without the
// rest of `app` (see `IsMountedSlice` in `@slayzone/trpc-server`).
// ---------------------------------------------------------------------------

type IsAppSlice<TMounts extends RouterMounts> = IsMountedSlice<TMounts, AppRouter>
type AssertAppSlice<T extends true> = AssertSlice<T>

export type DomainRouterSlices = [
  // The `app.*` routers, each owned by its package (`./routers/app.ts`).
  AssertAppSlice<IsAppSlice<AppAuthMounts>>,
  AssertAppSlice<IsAppSlice<AppBackupMounts>>,
  AssertAppSlice<IsAppSlice<AppBrowserMounts>>,
  AssertAppSlice<IsAppSlice<AppClipboardMounts>>,
  AssertAppSlice<IsAppSlice<AppDialogMounts>>,
  AssertAppSlice<IsAppSlice<AppExportImportMounts>>,
  AssertAppSlice<IsAppSlice<AppFeedbackMounts>>,
  AssertAppSlice<IsAppSlice<AppFilesMounts>>,
  AssertAppSlice<IsAppSlice<AppFloatingAgentMounts>>,
  AssertAppSlice<IsAppSlice<AppLeaderboardMounts>>,
  AssertAppSlice<IsAppSlice<AppMetaMounts>>,
  AssertAppSlice<IsAppSlice<AppScreenshotMounts>>,
  AssertAppSlice<IsAppSlice<AppShellMounts>>,
  AssertAppSlice<IsAppSlice<AppShortcutsMounts>>,
  AssertAppSlice<IsAppSlice<AppTaskWindowsMounts>>,
  AssertAppSlice<IsAppSlice<AppUsageMounts>>,
  AssertAppSlice<IsAppSlice<AppWebviewMounts>>,
  AssertAppSlice<IsAppSlice<AppWindowMounts>>,
  // The domains:
  AssertAppSlice<IsAppSlice<AgentLifecycleMounts>>,
  AssertAppSlice<IsAppSlice<AiConfigMounts>>,
  AssertAppSlice<IsAppSlice<AgentSessionsMounts>>,
  AssertAppSlice<IsAppSlice<AgentTurnsMounts>>,
  AssertAppSlice<IsAppSlice<ArtifactsMounts>>,
  AssertAppSlice<IsAppSlice<AutomationsMounts>>,
  AssertAppSlice<IsAppSlice<ChatMounts>>,
  AssertAppSlice<IsAppSlice<ComputersMounts>>,
  AssertAppSlice<IsAppSlice<DiagnosticsMounts>>,
  AssertAppSlice<IsAppSlice<FeedbackMounts>>,
  AssertAppSlice<IsAppSlice<FileEditorMounts>>,
  AssertAppSlice<IsAppSlice<HistoryMounts>>,
  AssertAppSlice<IsAppSlice<IntegrationsMounts>>,
  AssertAppSlice<IsAppSlice<MenuMounts>>,
  AssertAppSlice<IsAppSlice<NotifyMounts>>,
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
  AssertAppSlice<IsAppSlice<UsageAnalyticsMounts>>,
  AssertAppSlice<IsAppSlice<WorkspaceMounts>>,
  AssertAppSlice<IsAppSlice<WorktreesMounts>>
]
