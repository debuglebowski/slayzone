import type { ComponentType, RefAttributes } from 'react'
import type { DetectedRepo } from '@slayzone/projects/shared'
import type { GitTabId, Task, TaskArtifact, UpdateTaskInput } from '@slayzone/task/shared'

/**
 * Panels and data hooks the task page embeds from features built ON TOP of task
 * (artifacts, git). Task owns this contract; the composing app injects the real
 * implementations once via registerTaskPanels() — so task never imports those
 * features (they import task). Each feature ships its half of the binding
 * (`@slayzone/task-artifacts/task-panels`, `@slayzone/worktrees/task-panels`).
 *
 * Types are the minimal, structurally compatible surface the page uses.
 */

export interface ArtifactsPanelHandle {
  selectArtifact: (id: string) => void
  createArtifact: () => void
  toggleSearch: () => void
}

export interface ArtifactsPanelProps {
  taskId: string
  isResizing?: boolean
  initialActiveArtifactId?: string | null
  onActiveArtifactIdChange?: (id: string | null) => void
  /** Open a URL in the task's in-app browser (⌘-clicked links). */
  onOpenUrl?: (url: string) => void
}

export interface UnifiedGitPanelHandle {
  switchToTab: (tab: GitTabId) => void
  getActiveTab: () => GitTabId
}

export interface UnifiedGitPanelProps {
  task?: Task | null
  projectId: string
  projectPath: string | null
  completedStatus?: string
  visible: boolean
  pollIntervalMs?: number
  defaultTab?: GitTabId
  onTabChange?: (tab: GitTabId) => void
  onUpdateTask?: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated?: (task: Task) => void
  detectedRepos?: DetectedRepo[]
  selectedRepoName?: string | null
  isRepoStale?: boolean
  onRepoChange?: (repoName: string) => void
}

export interface TaskPanels {
  /** Lazy component — keep it code-split on the app side. */
  ArtifactsPanel: ComponentType<ArtifactsPanelProps & RefAttributes<ArtifactsPanelHandle>>
  /** Lazy component — keep it code-split on the app side. */
  UnifiedGitPanel: ComponentType<UnifiedGitPanelProps & RefAttributes<UnifiedGitPanelHandle>>
  useArtifacts: (taskId: string | null | undefined) => { artifacts: TaskArtifact[] }
  useProjectRepos: (
    projectPath: string | null,
    taskBoundPath: string | null,
    projectId?: string
  ) => { repos: readonly DetectedRepo[] }
}

let registered: TaskPanels | null = null

/**
 * Called ONCE by the composing app at module scope, before its first render. The
 * page calls the injected hooks, so they must be the same functions on every
 * render for the app's lifetime — a module-level registration (not a context,
 * whose value may change) is what makes that hold. Re-registering the same
 * object is a no-op; a different one throws.
 */
export function registerTaskPanels(panels: TaskPanels): void {
  if (registered && registered !== panels) {
    throw new Error('registerTaskPanels: task panels are already registered')
  }
  registered = panels
}

/** The app-registered panels. Throws if the app never called registerTaskPanels. */
export function getTaskPanels(): TaskPanels {
  if (!registered) throw new Error('getTaskPanels: the app must call registerTaskPanels first')
  return registered
}

/** The injected `useArtifacts` (fixed for the app's lifetime — see registerTaskPanels). */
export function useTaskArtifacts(taskId: string | null | undefined): { artifacts: TaskArtifact[] } {
  return getTaskPanels().useArtifacts(taskId)
}

/** The injected `useProjectRepos` (fixed for the app's lifetime — see registerTaskPanels). */
export function useTaskProjectRepos(
  projectPath: string | null,
  taskBoundPath: string | null,
  projectId?: string
): { repos: readonly DetectedRepo[] } {
  return getTaskPanels().useProjectRepos(projectPath, taskBoundPath, projectId)
}
