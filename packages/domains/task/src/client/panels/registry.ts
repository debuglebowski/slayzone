import type { ComponentType, RefAttributes } from 'react'
import {
  AlignLeft,
  Cpu,
  FileCode,
  FileText,
  GitBranch,
  Globe,
  ListChecks,
  ListTree,
  Paperclip,
  Settings2,
  SquareTerminal,
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
  | 'terminal'
  | 'browser'
  | 'web'
  | 'editor'
  | 'artifacts'
  | 'artifact'
  | 'git'
  | 'settings'
  | 'description'
  | 'subtasks'
  | 'details'
  | 'processes'

/**
 * What a panel does while its task tab is not the one in view.
 * - `activity`: wrapped in React <Activity>, hidden (effects unmounted, state kept).
 * - `mounted`: stays mounted and rendered; the kind parks itself. Browser and web
 *   keep their WebContentsView painting off-screen (Activity's cleanup would destroy
 *   the view and reset playback); the agent's terminal takes `isActive` itself.
 */
export type PanelKeepAlive = 'activity' | 'mounted'

/** What closing a panel tab may need to know about the instance being closed. */
export interface PanelCloseContext {
  panelId: string
  /** The kind's first instance (legacy id): closing only hides it. Any other is removed. */
  primary: boolean
  /** Whether the instance's agent session (its pty) is running right now. */
  isSessionLive: () => Promise<boolean>
}

/** A confirmation to show before a panel tab closes. */
export interface PanelCloseConfirm {
  title: string
  description: string
  confirmLabel: string
}

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
  /**
   * Theme-token text colour of the kind's icon where kinds are told apart at a
   * glance (the title row's group toggles, the New panel menu).
   */
  iconClassName: string
  /** Shortcut that toggles the panel. Web panels carry theirs in panel_config. */
  shortcutId: string | null
  keepAlive: PanelKeepAlive
  /** Wrapped in Suspense with the panel skeleton (its content is code-split). */
  suspense: boolean
  /** May show in a secondary "Open in new window" frame. The agent never does. */
  secondaryWindow: boolean
  /**
   * More than one instance may exist ("New <kind> panel"): each keeps its own state
   * (docs/plans/panel-model.md step 7). Settings and its cards (Description,
   * Subtasks, Details) stay single: one task, one form (ONE_PER_TASK_KINDS).
   */
  multiInstance: boolean
  /**
   * Asked before a tab of this kind closes (× , ⌘W, the tab menu's Close). A
   * confirmation it returns is shown first; null closes right away.
   */
  onCloseRequest?: (ctx: PanelCloseContext) => Promise<PanelCloseConfirm | null>
}

/**
 * Agents and terminals: confirm while a session runs (closing a tab must not feel
 * like losing it). The primary agent's tab only hides, keeping its session; any other
 * agent/terminal panel is removed and its sessions end with it.
 */
async function confirmLiveAgentClose(ctx: PanelCloseContext): Promise<PanelCloseConfirm | null> {
  if (!(await ctx.isSessionLive())) return null
  if (!ctx.primary)
    return {
      title: 'Close the panel?',
      description:
        'Its sessions are still running. Closing the panel ends them and closes its terminal tabs.',
      confirmLabel: 'Close and end sessions'
    }
  return {
    title: 'Close the agent?',
    description:
      'Its session is still running. Closing the tab keeps the session; you can show the agent again from the panel toggles.',
    confirmLabel: 'Close'
  }
}

export const PANEL_KINDS = {
  agent: {
    kind: 'agent',
    primaryPanelId: 'terminal',
    label: 'Agent',
    icon: TerminalIcon,
    iconClassName: 'text-agent',
    shortcutId: 'panel-terminal',
    keepAlive: 'mounted',
    suspense: false,
    secondaryWindow: false,
    multiInstance: true,
    onCloseRequest: confirmLiveAgentClose
  },
  terminal: {
    kind: 'terminal',
    primaryPanelId: null,
    label: 'Terminal',
    icon: SquareTerminal,
    iconClassName: 'text-success',
    shortcutId: null,
    keepAlive: 'mounted',
    suspense: false,
    secondaryWindow: false,
    multiInstance: true,
    onCloseRequest: confirmLiveAgentClose
  },
  browser: {
    kind: 'browser',
    primaryPanelId: 'browser',
    label: 'Browser',
    icon: Globe,
    iconClassName: 'text-info',
    shortcutId: 'panel-browser',
    keepAlive: 'mounted',
    suspense: true,
    secondaryWindow: true,
    multiInstance: true
  },
  editor: {
    kind: 'editor',
    primaryPanelId: 'editor',
    label: 'Editor',
    icon: FileCode,
    iconClassName: 'text-chart-4',
    shortcutId: 'panel-editor',
    keepAlive: 'activity',
    suspense: true,
    secondaryWindow: true,
    multiInstance: true
  },
  artifacts: {
    kind: 'artifacts',
    primaryPanelId: 'artifacts',
    label: 'Artifacts',
    icon: Paperclip,
    iconClassName: 'text-chart-5',
    shortcutId: 'panel-artifacts',
    keepAlive: 'activity',
    suspense: true,
    secondaryWindow: true,
    multiInstance: true
  },
  artifact: {
    kind: 'artifact',
    primaryPanelId: null,
    label: 'Artifact',
    icon: FileText,
    iconClassName: 'text-chart-5',
    shortcutId: null,
    keepAlive: 'activity',
    suspense: true,
    secondaryWindow: true,
    multiInstance: true
  },
  web: {
    kind: 'web',
    primaryPanelId: null,
    label: 'Web',
    icon: Globe,
    iconClassName: 'text-info',
    shortcutId: null,
    keepAlive: 'mounted',
    suspense: false,
    secondaryWindow: true,
    multiInstance: true
  },
  git: {
    kind: 'git',
    primaryPanelId: 'diff',
    label: 'Git',
    icon: GitBranch,
    iconClassName: 'text-warning',
    shortcutId: 'panel-git',
    keepAlive: 'activity',
    suspense: true,
    secondaryWindow: true,
    multiInstance: true
  },
  settings: {
    kind: 'settings',
    primaryPanelId: 'settings',
    label: 'Settings',
    icon: Settings2,
    iconClassName: 'text-muted-foreground',
    shortcutId: 'panel-settings',
    keepAlive: 'activity',
    suspense: false,
    secondaryWindow: true,
    multiInstance: false
  },
  description: {
    kind: 'description',
    primaryPanelId: null,
    label: 'Description',
    icon: AlignLeft,
    iconClassName: 'text-muted-foreground',
    shortcutId: null,
    keepAlive: 'activity',
    suspense: false,
    secondaryWindow: true,
    multiInstance: false
  },
  subtasks: {
    kind: 'subtasks',
    primaryPanelId: null,
    label: 'Subtasks',
    icon: ListChecks,
    iconClassName: 'text-muted-foreground',
    shortcutId: null,
    keepAlive: 'activity',
    suspense: false,
    secondaryWindow: true,
    multiInstance: false
  },
  details: {
    kind: 'details',
    primaryPanelId: null,
    label: 'Details',
    icon: ListTree,
    iconClassName: 'text-muted-foreground',
    shortcutId: null,
    keepAlive: 'activity',
    suspense: false,
    secondaryWindow: true,
    multiInstance: false
  },
  processes: {
    kind: 'processes',
    primaryPanelId: 'processes',
    label: 'Processes',
    icon: Cpu,
    iconClassName: 'text-chart-3',
    shortcutId: 'panel-processes',
    keepAlive: 'activity',
    suspense: false,
    secondaryWindow: true,
    multiInstance: true
  }
} as const satisfies { [K in PanelKind]: PanelKindDef & { kind: K } } as {
  readonly [K in PanelKind]: PanelKindDef & { kind: K }
}

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
  /**
   * Show this one artifact only (an Artifact panel): no sidebar, no selection —
   * the panel is about this file. Read at mount; a different id remounts.
   */
  pinnedArtifactId?: string
  /** "Open in its own panel" on a file (an Artifact panel for it). Absent: no entry. */
  onOpenInOwnPanel?: (artifact: { id: string; title: string }) => void
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
