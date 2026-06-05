import { lazy, type LazyExoticComponent } from 'react'
// Props type isn't exported from the file-editor barrel, so once `FileEditorView`
// is an *exported* binding TS can't name it for declaration emit (TS4023). The
// `import type` (erased at runtime) gives an explicit, nameable annotation.
import type { FileEditorView as FileEditorViewComponent } from '@slayzone/file-editor/client/FileEditorView'

// Lazy-loaded: heavy components not needed for first paint.
// Centralised so every consumer shares one chunk + Suspense identity.
export const TaskDetailDataLoader = lazy(() =>
  import('@slayzone/task/client/TaskDetailDataLoader').then((m) => ({
    default: m.TaskDetailDataLoader
  }))
)
export const FileEditorView: LazyExoticComponent<typeof FileEditorViewComponent> = lazy(() =>
  import('@slayzone/file-editor/client/FileEditorView').then((m) => ({ default: m.FileEditorView }))
)
export const UserSettingsDialog = lazy(() =>
  import('@slayzone/settings/client/UserSettingsDialog').then((m) => ({
    default: m.UserSettingsDialog
  }))
)
export const TutorialAnimationModal = lazy(() =>
  import('@/components/tutorial/TutorialAnimationModal').then((m) => ({
    default: m.TutorialAnimationModal
  }))
)
// Home panels
export const UnifiedGitPanel = lazy(() =>
  import('@slayzone/worktrees').then((m) => ({ default: m.UnifiedGitPanel }))
)
export const TestPanel = lazy(() =>
  import('@slayzone/test-panel').then((m) => ({ default: m.TestPanel }))
)
export const ProcessesPanel = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.ProcessesPanel }))
)
export const AutomationsPanel = lazy(() =>
  import('@slayzone/automations').then((m) => ({ default: m.AutomationsPanel }))
)
// Overlay pages
export const LeaderboardPage = lazy(() =>
  import('@/components/leaderboard/LeaderboardPage').then((m) => ({ default: m.LeaderboardPage }))
)
export const UsageAnalyticsPage = lazy(() =>
  import('@slayzone/usage-analytics/client').then((m) => ({ default: m.UsageAnalyticsPage }))
)
export const ContextManagerPage = lazy(() =>
  import('@slayzone/ai-config/client').then((m) => ({ default: m.ContextManagerPage }))
)
// Dialogs
export const CreateTaskDialog = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.CreateTaskDialog }))
)
export const EditTaskDialog = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.EditTaskDialog }))
)
export const DeleteTaskDialog = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.DeleteTaskDialog }))
)
export const TemplatesSettingsTab = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.TemplatesSettingsTab }))
)
export const CreateProjectDialog = lazy(() =>
  import('@slayzone/projects').then((m) => ({ default: m.CreateProjectDialog }))
)
export const ProjectSettingsDialog = lazy(() =>
  import('@slayzone/projects').then((m) => ({ default: m.ProjectSettingsDialog }))
)
export const DeleteProjectDialog = lazy(() =>
  import('@slayzone/projects').then((m) => ({ default: m.DeleteProjectDialog }))
)
export const GroupSettingsDialog = lazy(() =>
  import('@slayzone/projects').then((m) => ({ default: m.GroupSettingsDialog }))
)
export const OnboardingDialog = lazy(() =>
  import('@slayzone/onboarding').then((m) => ({ default: m.OnboardingDialog }))
)
export const SearchDialog = lazy(() =>
  import('@/components/dialogs/SearchDialog').then((m) => ({ default: m.SearchDialog }))
)
export const CliInstallDialog = lazy(() =>
  import('@/components/dialogs/CliInstallDialog').then((m) => ({ default: m.CliInstallDialog }))
)
export const ChangelogDialog = lazy(() =>
  import('@/components/changelog/ChangelogDialog').then((m) => ({ default: m.ChangelogDialog }))
)
export const KanbanBoard = lazy(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.KanbanBoard }))
)
export const KanbanListView = lazy(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.KanbanListView }))
)
export const FilterBar = lazy(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.FilterBar }))
)
export const GlobalAgentSidePanel = lazy(() =>
  import('@/components/global-agent-panel/GlobalAgentSidePanel').then((m) => ({
    default: m.GlobalAgentSidePanel
  }))
)
export const AgentStatusSidePanel = lazy(() =>
  import('@/components/agent-status/AgentStatusSidePanel').then((m) => ({
    default: m.AgentStatusSidePanel
  }))
)
export const TerminalStatusDialog = lazy(() =>
  import('@slayzone/terminal').then((m) => ({ default: m.TerminalStatusDialog }))
)
