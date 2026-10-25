import { useEffect } from 'react'
import { preloadOnIdle } from '@slayzone/ui'
import { preloadTerminal } from '@slayzone/terminal/client/LazyTerminal'
import {
  ArtifactsPanel,
  BrowserPanel,
  DescriptionDialog,
  FileEditorView as TaskFileEditorView,
  UnifiedGitPanel as TaskGitPanel
} from '@slayzone/task/client/lazyPanels'
import {
  ChangelogDialog,
  CliInstallDialog,
  ContextManagerPage,
  CreateProjectDialog,
  CreateTaskDialog,
  DeleteProjectDialog,
  DeleteTaskDialog,
  EditTaskDialog,
  GroupSettingsDialog,
  OnboardingDialog,
  ProjectSettingsDialog,
  SearchDialog,
  TaskDetailDataLoader,
  TemplatesSettingsTab,
  TerminalStatusDialog,
  TutorialAnimationModal,
  UserSettingsDialog
} from './lazy'

// Warm lazy chunks while the renderer is idle, so the first open of a modal, page
// or panel doesn't pay the chunk-fetch cost (Suspense fallback is null → blank gap).
// One chunk per idle period, most latency-sensitive first. Every entry is the
// lazy component's own `.preload`, so it always warms the chunk that renders.
const PRELOADS: Array<() => Promise<unknown>> = [
  // Cmd+K command palette (+ its cmdk/fzf deps).
  SearchDialog.preload,
  // Task-detail page — shared by every task tab; the dominant first-task-open latency.
  TaskDetailDataLoader.preload,
  // xterm (~440KB) — first terminal panel mount lands warm.
  preloadTerminal,
  // Task dialogs (one shared @slayzone/task chunk) and settings (Cmd+,).
  CreateTaskDialog.preload,
  EditTaskDialog.preload,
  DeleteTaskDialog.preload,
  UserSettingsDialog.preload,
  TemplatesSettingsTab.preload,
  // material-file-icons (~500KB) — first FileIcon render lands warm.
  () => import('@slayzone/icons').then((m) => m.loadFileIcons()),
  // Optional task panels — revealing one the first time lands without a skeleton flash.
  BrowserPanel.preload,
  TaskFileEditorView.preload,
  TaskGitPanel.preload,
  ArtifactsPanel.preload,
  DescriptionDialog.preload,
  // Remaining modals.
  CreateProjectDialog.preload,
  ProjectSettingsDialog.preload,
  DeleteProjectDialog.preload,
  GroupSettingsDialog.preload,
  TerminalStatusDialog.preload,
  CliInstallDialog.preload,
  OnboardingDialog.preload,
  ChangelogDialog.preload,
  TutorialAnimationModal.preload,
  ContextManagerPage.preload
]

export function useIdlePreload(): void {
  useEffect(() => preloadOnIdle(PRELOADS), [])
}
