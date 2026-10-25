import { lazyWithPreload, type PreloadableLazy } from '@slayzone/ui'
// Props type isn't exported from the file-editor barrel, so once `FileEditorView`
// is an *exported* binding TS can't name it for declaration emit (TS4023). The
// `import type` (erased at runtime) gives an explicit, nameable annotation.
import type { FileEditorView as FileEditorViewComponent } from '@slayzone/file-editor/client/FileEditorView'

// Lazy-loaded: heavy components not needed for first paint.
// Centralised so every consumer shares one chunk + Suspense identity. `.preload()`
// warms a chunk ahead of first use — see useIdlePreload.
export const TaskDetailDataLoader = lazyWithPreload(() =>
  import('@slayzone/task/client/TaskDetailDataLoader').then((m) => ({
    default: m.TaskDetailDataLoader
  }))
)
export const FileEditorView: PreloadableLazy<typeof FileEditorViewComponent> = lazyWithPreload(() =>
  import('@slayzone/file-editor/client/FileEditorView').then((m) => ({ default: m.FileEditorView }))
)
export const UserSettingsDialog = lazyWithPreload(() =>
  import('@slayzone/settings/client/UserSettingsDialog').then((m) => ({
    default: m.UserSettingsDialog
  }))
)
export const TutorialAnimationModal = lazyWithPreload(() =>
  import('@slayzone/onboarding/client/TutorialAnimationModal').then((m) => ({
    default: m.TutorialAnimationModal
  }))
)
// Home panels
export const UnifiedGitPanel = lazyWithPreload(() =>
  import('@slayzone/worktrees').then((m) => ({ default: m.UnifiedGitPanel }))
)
export const TestPanel = lazyWithPreload(() =>
  import('@slayzone/test-panel').then((m) => ({ default: m.TestPanel }))
)
export const ProcessesPanel = lazyWithPreload(() =>
  import('@slayzone/task').then((m) => ({ default: m.ProcessesPanel }))
)
export const AutomationsPanel = lazyWithPreload(() =>
  import('@slayzone/automations').then((m) => ({ default: m.AutomationsPanel }))
)
// Overlay pages
export const LeaderboardPage = lazyWithPreload(() =>
  import('@slayzone/leaderboard').then((m) => ({ default: m.LeaderboardPage }))
)
export const UsageAnalyticsPage = lazyWithPreload(() =>
  import('@slayzone/usage-analytics/client').then((m) => ({ default: m.UsageAnalyticsPage }))
)
export const ContextManagerPage = lazyWithPreload(() =>
  import('@slayzone/ai-config/client').then((m) => ({ default: m.ContextManagerPage }))
)
// Dialogs
export const CreateTaskDialog = lazyWithPreload(() =>
  import('@slayzone/task').then((m) => ({ default: m.CreateTaskDialog }))
)
export const EditTaskDialog = lazyWithPreload(() =>
  import('@slayzone/task').then((m) => ({ default: m.EditTaskDialog }))
)
export const DeleteTaskDialog = lazyWithPreload(() =>
  import('@slayzone/task').then((m) => ({ default: m.DeleteTaskDialog }))
)
export const TemplatesSettingsTab = lazyWithPreload(() =>
  import('@slayzone/task').then((m) => ({ default: m.TemplatesSettingsTab }))
)
export const CreateProjectDialog = lazyWithPreload(() =>
  import('@slayzone/projects').then((m) => ({ default: m.CreateProjectDialog }))
)
export const ProjectSettingsDialog = lazyWithPreload(() =>
  import('@slayzone/projects').then((m) => ({ default: m.ProjectSettingsDialog }))
)
export const DeleteProjectDialog = lazyWithPreload(() =>
  import('@slayzone/projects').then((m) => ({ default: m.DeleteProjectDialog }))
)
export const GroupSettingsDialog = lazyWithPreload(() =>
  import('@slayzone/projects').then((m) => ({ default: m.GroupSettingsDialog }))
)
export const OnboardingDialog = lazyWithPreload(() =>
  import('@slayzone/onboarding/client/OnboardingDialog').then((m) => ({
    default: m.OnboardingDialog
  }))
)
export const SearchDialog = lazyWithPreload(() =>
  import('@slayzone/search').then((m) => ({ default: m.SearchDialog }))
)
export const CliInstallDialog = lazyWithPreload(() =>
  import('@slayzone/settings/client/CliInstallDialog').then((m) => ({
    default: m.CliInstallDialog
  }))
)
export const ChangelogDialog = lazyWithPreload(() =>
  import('@slayzone/onboarding/client/ChangelogDialog').then((m) => ({
    default: m.ChangelogDialog
  }))
)
export const KanbanBoard = lazyWithPreload(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.KanbanBoard }))
)
export const KanbanListView = lazyWithPreload(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.KanbanListView }))
)
export const FilterBar = lazyWithPreload(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.FilterBar }))
)
export const GlobalAgentSidePanel = lazyWithPreload(() =>
  import('@slayzone/agent-panels').then((m) => ({
    default: m.GlobalAgentSidePanel
  }))
)
export const AgentStatusSidePanel = lazyWithPreload(() =>
  import('@slayzone/agent-panels').then((m) => ({
    default: m.AgentStatusSidePanel
  }))
)
export const TerminalStatusDialog = lazyWithPreload(() =>
  import('@slayzone/terminal').then((m) => ({ default: m.TerminalStatusDialog }))
)
