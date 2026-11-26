import { createContext, use } from 'react'
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'
import type { Project } from '@slayzone/projects-contracts'
import type { Tag } from '@slayzone/tags/shared'
import type { GitTabId, PanelVisibility, Task, TaskArtifact } from '@slayzone/task-contracts'
import type { AgentId } from '@slayzone/terminal-contracts'
import type { useAgents, useLoopMode, useSlayNudge } from '@slayzone/terminal'
import type { TerminalContainerHandle } from '@slayzone/task-terminals'
import type { BrowserPanelHandle } from '@slayzone/task-browser'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import type { FileEditorViewHandle } from '@slayzone/file-editor/client'
import type { OpenFileOptions } from '@slayzone/file-editor/shared'
import type { LinkOpenTarget } from '@slayzone/editor'
import type { buildStatusOptions, EditorThemeColors, useAppearance } from '@slayzone/ui'
import type { mainTerminalProps } from '../../shared/main-terminal'
import type { usePanelOwnership } from '../usePanelOwnership'
import type { usePanelConfig } from '../usePanelConfig'
import type { UseSubTasksReturn } from '../useSubTasks'
import type { useHeldTaskPath } from '../useTaskPath'
import type { useTaskTerminalSession } from '../task-detail/useTaskTerminalSession'
import type { usePersistenceSaves } from '../task-detail/usePersistenceSaves'
import type { useTaskDoctor } from '../task-detail/useTaskDoctor'
import type { ArtifactsPanelHandle, TaskPanels, UnifiedGitPanelHandle } from './registry'

/**
 * What the task page's panels read from the page: the task, the panel strip's state
 * and each kind's handlers. The page owns all of it (its shortcuts, palette commands
 * and pane events drive the same state), builds this value once per render and
 * provides it around the panel strip; each kind in ./kinds reads its own section.
 */

type SetState<T> = Dispatch<SetStateAction<T>>
type Appearance = ReturnType<typeof useAppearance>
type TaskUpdater = (data: {
  id: string
  worktreePath?: string | null
  worktreeParentBranch?: string | null
  baseDir?: string | null
  browserUrl?: string | null
  status?: Task['status']
}) => Promise<Task>

/** The panel strip: visibility, ownership across windows, focus glow, sizes. */
export interface TaskPanelStripContext {
  panelVisibility: PanelVisibility
  handlePanelToggle: (panelId: string, active: boolean) => Promise<void>
  ownership: ReturnType<typeof usePanelOwnership>
  /** The panel holding focus (glow), by panel id. */
  focusedPanel: string | null
  multipleVisiblePanels: boolean
  containerWidth: number
  resolvedWidths: Record<string, number>
  panelOrderIdx: Record<string, number>
}

export interface AgentPanelContext {
  runsAgentsHere: boolean
  canRunOwnAgents: boolean
  projectRoot: string | null
  chosenFolder: string | null
  projectPathMissing: boolean
  workspaceUnreachable: boolean
  taskPathPending: boolean
  taskPathLocation: string | null
  taskFolderMissing: boolean
  worktreePath: string | null
  baseDir: string | null
  terminalContainerRef: RefObject<TerminalContainerHandle | null>
  terminalKey: number
  mainTerminal: ReturnType<typeof mainTerminalProps>
  modes: ReturnType<typeof useAgents>['modes']
  terminalFocusRequestId: number
  handleTerminalReady: (api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => void
  handleTerminalFocusRequestHandled: (requestId: number) => void
  isMainTabActive: boolean
  setIsMainTabActive: SetState<boolean>
  handleQuickOpenFile: (filePath: string, options?: OpenFileOptions) => void
  handleChatOpenArtifact: (artifactRef: string) => void
  handleChatOpenTask: (taskRef: string) => void
  session: ReturnType<typeof useTaskTerminalSession>
  loop: ReturnType<typeof useLoopMode>
  loopConfigured: boolean
  loopModeAvailable: boolean
  setLoopDialogOpen: SetState<boolean>
  handleLoopConfigChange: (cfg: Task['loop_config'] | null) => void
  slayNudge: ReturnType<typeof useSlayNudge>
  handleModeChange: (mode: AgentId) => Promise<void>
  flagsPopoverOpen: boolean
  setFlagsPopoverOpen: SetState<boolean>
  flagsInputValue: string
  setFlagsInputValue: SetState<string>
  handleFlagsSave: (nextValue: string) => Promise<void>
  getProviderFlagsForMode: (task: Task) => string
  handleSetDefaultFlags: () => Promise<void>
  handleInjectTitle: () => Promise<void>
  handleInjectDescription: () => Promise<void>
  handleCopyHistory: () => void
  handleCopyConversationId: () => void
  handleDoctor: ReturnType<typeof useTaskDoctor>['handleDoctor']
  projectFolderPickerOpen: boolean
  setProjectFolderPickerOpen: SetState<boolean>
}

export interface BrowserPanelContext {
  browserPanelRef: RefObject<BrowserPanelHandle | null>
  browserTabs: BrowserTabsState
  handleBrowserTabsChange: (tabs: BrowserTabsState) => Promise<void>
  handleInsertElementSnippet: (snippet: string) => Promise<void>
  handleScreenshot: (viewId: string) => Promise<void>
}

type PersistenceSaves = ReturnType<typeof usePersistenceSaves>

export interface EditorPanelContext {
  fileEditorRefCallback: (handle: FileEditorViewHandle | null) => void
  handleEditorStateChange: PersistenceSaves['handleEditorStateChange']
}

export interface ArtifactsPanelContext {
  artifactsPanelRef: RefObject<ArtifactsPanelHandle | null>
  artifactsPanelRefCallback: (handle: ArtifactsPanelHandle | null) => void
  handleActiveArtifactIdChange: PersistenceSaves['handleActiveArtifactIdChange']
  handleArtifactsSidebarChange: PersistenceSaves['handleArtifactsSidebarChange']
  /** Sharing one file with people (T-100): only on a hub with login. */
  sharingEnabled: boolean
  sharingArtifact: { id: string; title: string } | null
  setSharingArtifact: SetState<{ id: string; title: string } | null>
}

export interface WebPanelsContext {
  enabledWebPanels: ReturnType<typeof usePanelConfig>['enabledWebPanels']
  handleWebPanelUrlChange: PersistenceSaves['handleWebPanelUrlChange']
  handleWebPanelFaviconChange: PersistenceSaves['handleWebPanelFaviconChange']
}

export interface GitPanelContext {
  gitPanelRef: RefObject<UnifiedGitPanelHandle | null>
  resolvedGitViewPath: string | null
  completedStatus: string
  gitDefaultTab: GitTabId
  handleGitTabChange: (tab: GitTabId) => void
  viewableRepos: ReturnType<TaskPanels['useProjectRepos']>['repos']
  handleRepoChange: (repoName: string) => void
}

export interface SettingsPanelContext {
  tags: Tag[]
  setTags: SetState<Tag[]>
  taskTagIds: string[]
  handleTagsChange: (newTagIds: string[]) => void
  taskPath: ReturnType<typeof useHeldTaskPath>
  taskPathLocation: string | null
  taskFolderLabel: string
  baseDir: string | null
  baseDirPickerOpen: boolean
  setBaseDirPickerOpen: SetState<boolean>
  isArchived: boolean
  handleUnarchive: () => Promise<void>
  setArchiveDialogOpen: SetState<boolean>
  setDeleteDialogOpen: SetState<boolean>
  // Cards
  settingsCardsGridRef: RefObject<HTMLDivElement | null>
  settingsCols: number
  descFullHeight: boolean
  descriptionOpen: boolean
  setDescriptionOpen: SetState<boolean>
  descriptionExpanded: boolean
  setDescriptionExpanded: SetState<boolean>
  subTasksOpen: boolean
  setSubTasksOpen: SetState<boolean>
  artifactsOpen: boolean
  setArtifactsOpen: SetState<boolean>
  detailsOpen: boolean
  setDetailsOpen: SetState<boolean>
  // Description
  setDescriptionFullscreen: SetState<boolean>
  descriptionValue: string
  setDescriptionValue: SetState<string>
  descriptionDirty: RefObject<boolean>
  handleDescriptionSave: () => Promise<void>
  handleUploadImages: (files: File[]) => Promise<{ id: string; title: string }[]>
  handleDescriptionOpenLink: (href: string, target: LinkOpenTarget) => void
  notes: {
    fontFamily: Appearance['notesFontFamily']
    checkedHighlight: Appearance['notesCheckedHighlight']
    showToolbar: Appearance['notesShowToolbar']
    spellcheck: Appearance['notesSpellcheck']
    themeColors: EditorThemeColors
  }
  // Sub-tasks
  statusOptions: ReturnType<typeof buildStatusOptions>
  subTasks: UseSubTasksReturn['subTasks']
  handleSubTaskDragEnd: UseSubTasksReturn['handleDragEnd']
  handleUpdateSubTask: UseSubTasksReturn['updateSubTask']
  handleDeleteSubTask: UseSubTasksReturn['deleteSubTask']
  addingSubTask: boolean
  setAddingSubTask: SetState<boolean>
  subTaskTitle: string
  setSubTaskTitle: SetState<string>
  subTaskInputRef: RefObject<HTMLInputElement | null>
  handleCreateSubTask: () => Promise<void>
  onNavigateToTask?: (taskId: string) => void
  // Artifacts card
  artifacts: TaskArtifact[]
  artifactsPanelRef: RefObject<ArtifactsPanelHandle | null>
}

export interface ProcessesPanelContext {
  processesCwdUnavailable: string | null
}

export interface TaskPageContextValue {
  task: Task
  project: Project | null
  isActive: boolean | undefined
  /** Owns keyboard shortcuts (explode mode: only the focused cell). */
  shortcutActive: boolean | undefined
  compact: boolean | undefined
  /** A panel boundary or the side panel is being dragged. */
  isResizing: boolean
  /** False for a View member (T-100): nothing on the page offers an edit. */
  canEdit: boolean
  /** The task-bound repo path: worktree > resolved child repo > project path. */
  effectiveRepoPath: string | null
  /** The main agent's cwd. Null: nowhere to run (yet). */
  mainAgentCwd: string | null
  /** Open a URL in the task's browser panel (opening the panel). */
  openDevServerInBrowser: (url: string, tabId?: string, isolated?: boolean) => void
  handleTaskUpdate: (updated: Task) => void
  updateTaskAndNotify: TaskUpdater
  getMainSessionId: (taskId: string) => string
  panels: TaskPanelStripContext
  agent: AgentPanelContext
  browser: BrowserPanelContext
  editor: EditorPanelContext
  artifacts: ArtifactsPanelContext
  web: WebPanelsContext
  git: GitPanelContext
  settings: SettingsPanelContext
  processes: ProcessesPanelContext
}

const TaskPageContext = createContext<TaskPageContextValue | null>(null)

export function TaskPageProvider({
  value,
  children
}: {
  value: TaskPageContextValue
  children: ReactNode
}): React.JSX.Element {
  return <TaskPageContext value={value}>{children}</TaskPageContext>
}

/** The enclosing task page. Panels render only inside one. */
export function useTaskPageContext(): TaskPageContextValue {
  const value = use(TaskPageContext)
  if (!value) throw new Error('useTaskPageContext: no TaskPageProvider above this panel')
  return value
}
