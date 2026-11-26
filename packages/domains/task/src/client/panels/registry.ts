import type { ComponentType, RefAttributes } from 'react'
import {
  Cpu,
  FileCode,
  GitBranch,
  Globe,
  Paperclip,
  Settings2,
  Terminal as TerminalIcon,
  type LucideIcon
} from 'lucide-react'
import type { DetectedRepo } from '@slayzone/projects-contracts'
import type {
  ArtifactsSidebarState,
  GitTabId,
  Task,
  TaskArtifact,
  UpdateTaskInput
} from '@slayzone/task-contracts'

/**
 * The task page's panel kinds: what each kind of panel is (label, icon, shortcut,
 * keep-alive policy), plus the panels other features inject into the page.
 *
 * The kinds' components live in ./kinds (PANEL_KIND_COMPONENTS), keyed by the same
 * PanelKind, so this module stays light: the composing app imports it at boot to
 * call registerTaskPanels(), before any panel code is needed.
 */

// --- Kinds -----------------------------------------------------------------------

export type PanelKind =
  | 'agent'
  | 'browser'
  | 'web'
  | 'editor'
  | 'artifacts'
  | 'git'
  | 'settings'
  | 'processes'

/**
 * What a panel does while its task tab is not the one in view.
 * - `activity`: wrapped in React <Activity>, hidden (effects unmounted, state kept).
 * - `mounted`: stays mounted and rendered; the kind parks itself. Browser and web
 *   keep their WebContentsView painting off-screen (Activity's cleanup would destroy
 *   the view and reset playback); the agent's terminal takes `isActive` itself.
 */
export type PanelKeepAlive = 'activity' | 'mounted'

export interface PanelKindDef {
  kind: PanelKind
  /**
   * The panel id of the kind's first instance — what `panel_visibility`,
   * `panel_sizes`, ownership, `data-panel-id`, `focusedPanel` and the shortcuts use.
   * Null for `web`: each configured web panel has its own id (`web:*`).
   */
  primaryPanelId: string | null
  label: string
  icon: LucideIcon
  /** Shortcut that toggles the panel. Web panels carry theirs in panel_config. */
  shortcutId: string | null
  keepAlive: PanelKeepAlive
  /** Wrapped in Suspense with the panel skeleton (its content is code-split). */
  suspense: boolean
  /** May show in a secondary "Open in new window" frame. The agent never does. */
  secondaryWindow: boolean
}

export const PANEL_KINDS = {
  agent: {
    kind: 'agent',
    primaryPanelId: 'terminal',
    label: 'Agent',
    icon: TerminalIcon,
    shortcutId: 'panel-terminal',
    keepAlive: 'mounted',
    suspense: false,
    secondaryWindow: false
  },
  browser: {
    kind: 'browser',
    primaryPanelId: 'browser',
    label: 'Browser',
    icon: Globe,
    shortcutId: 'panel-browser',
    keepAlive: 'mounted',
    suspense: true,
    secondaryWindow: true
  },
  editor: {
    kind: 'editor',
    primaryPanelId: 'editor',
    label: 'Editor',
    icon: FileCode,
    shortcutId: 'panel-editor',
    keepAlive: 'activity',
    suspense: true,
    secondaryWindow: true
  },
  artifacts: {
    kind: 'artifacts',
    primaryPanelId: 'artifacts',
    label: 'Artifacts',
    icon: Paperclip,
    shortcutId: 'panel-artifacts',
    keepAlive: 'activity',
    suspense: true,
    secondaryWindow: true
  },
  web: {
    kind: 'web',
    primaryPanelId: null,
    label: 'Web',
    icon: Globe,
    shortcutId: null,
    keepAlive: 'mounted',
    suspense: false,
    secondaryWindow: true
  },
  git: {
    kind: 'git',
    primaryPanelId: 'diff',
    label: 'Git',
    icon: GitBranch,
    shortcutId: 'panel-git',
    keepAlive: 'activity',
    suspense: true,
    secondaryWindow: true
  },
  settings: {
    kind: 'settings',
    primaryPanelId: 'settings',
    label: 'Settings',
    icon: Settings2,
    shortcutId: 'panel-settings',
    keepAlive: 'activity',
    suspense: false,
    secondaryWindow: true
  },
  processes: {
    kind: 'processes',
    primaryPanelId: 'processes',
    label: 'Processes',
    icon: Cpu,
    shortcutId: 'panel-processes',
    keepAlive: 'activity',
    suspense: false,
    secondaryWindow: true
  }
} as const satisfies { [K in PanelKind]: PanelKindDef & { kind: K } }

// --- Injected panels ---------------------------------------------------------------

/**
 * Panels and data hooks the task page embeds from features built ON TOP of task
 * (artifacts, git, integrations). Task owns this contract; the composing app injects
 * the real implementations once via registerTaskPanels() — so task never imports
 * those features (they import task). Each feature ships its half of the binding
 * (`@slayzone/task-artifacts/task-panels`, `@slayzone/worktrees/task-panels`,
 * `@slayzone/integrations/task-panels`).
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
  initialSidebarState?: ArtifactsSidebarState | null
  onSidebarStateChange?: (state: Required<ArtifactsSidebarState>) => void
  /** Open a URL in the task's in-app browser (⌘-clicked links). */
  onOpenUrl?: (url: string) => void
  /** Share one file with people (T-100). Absent: no Share entry. */
  onShareArtifact?: (artifact: { id: string; title: string }) => void
  /** A View member's panel (T-100): files open and download, nothing changes them. */
  readOnly?: boolean
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

export interface ExternalSyncCardProps {
  taskId: string
  onUpdate: (task: Task) => void
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
  ) => {
    repos: readonly DetectedRepo[]
    /** The list answered (or failed), or there is no project to list. */
    settled: boolean
  }
  /**
   * Child repos of a project directory, discovered on the machine that owns it
   * (`projectId` routes the scan there). Empty while `projectPath` is null.
   */
  useDetectedRepos: (projectPath: string | null, projectId?: string) => DetectedRepo[]
  /** External sync links (Linear/GitHub/Jira) pinned above the settings cards. */
  ExternalSyncCard: ComponentType<ExternalSyncCardProps>
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
): ReturnType<TaskPanels['useProjectRepos']> {
  return getTaskPanels().useProjectRepos(projectPath, taskBoundPath, projectId)
}

/** The injected `useDetectedRepos` (fixed for the app's lifetime — see registerTaskPanels). */
export function useTaskDetectedRepos(
  projectPath: string | null,
  projectId?: string
): DetectedRepo[] {
  return getTaskPanels().useDetectedRepos(projectPath, projectId)
}
