import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react'
import {
  Loader2,
  Terminal as TerminalIcon,
  Globe,
  Settings2,
  GitBranch,
  FileCode,
  Info,
  CheckCircle2,
  XCircle,
  Stethoscope,
  Cpu,
  Circle,
  LayoutTemplate,
  Paperclip,
  PanelsTopLeft
} from 'lucide-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  electronBootstrap,
  hubAllows,
  useHubId,
  useHubRegistryStore,
  useSubscription
} from '@slayzone/transport/client'
import { terminalOnThisDevice } from './terminal-on-this-device'
import { useTRPC, useTRPCClient } from './trpc'
import { useArtifactUpload } from '@slayzone/editor/hooks'
import type {
  Task,
  PanelVisibility,
  PanelSizes,
  UpdateTaskInput,
  GitTabId
} from '@slayzone/task-contracts'
import type { TaskTemplate } from '@slayzone/task-contracts'
import type { TaskDetailData } from './taskDetailCache'
import {
  hasOwnFolder,
  mainTerminalCwdFrom,
  ownFolderMissing,
  mainTerminalProps,
  taskRepoName,
  taskRepoPath
} from '../shared/main-terminal'
import { useHeldTaskPath, useTaskPath, useTaskPathLocation } from './useTaskPath'
import {
  BUILTIN_PANEL_IDS,
  getProviderFlags,
  setProviderFlags,
  priorityOptions
} from '@slayzone/task-contracts'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Project } from '@slayzone/projects-contracts'
import {
  getDefaultStatus,
  getDoneStatus,
  isCompletedStatus,
  placementOn,
  resolveRepoPath,
  taskProjectRoot,
  workComputerId
} from '@slayzone/projects-contracts'
import type { AgentId } from '@slayzone/terminal-contracts'
import {
  Button,
  PanelToggle,
  DevServerToast,
  formatKeysForDisplay,
  webPanelShortcutKeys
} from '@slayzone/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@slayzone/ui'
import { toast } from '@slayzone/ui'
import { DeleteTaskDialog } from './DeleteTaskDialog'
import { MoveTaskDialog } from './MoveTaskDialog'
import { DuplicateTaskDialog } from './DuplicateTaskDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@slayzone/ui'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { safeRandomUUID, safeClipboardWriteText } from '@slayzone/ui'
import { TaskComputerChip } from './TaskComputerChip'
import { TaskStatusMenu } from './TaskStatusMenu'
import {
  normalizeDescription,
  stripMarkdown,
  getEffectiveRenderMode,
  RENDER_MODE_INFO
} from '@slayzone/task-contracts'
import { useTheme } from '@slayzone/ui'
import { useTabStore } from '@slayzone/tabs-state'
import { useDialogStore, type SearchFileContext } from '@slayzone/dialogs'
import {
  markSkipCache,
  usePty,
  useAgents,
  useLoopMode,
  stripAnsi,
  serializeTerminalHistory,
  LoopModeDialog,
  useSlayNudge,
  PtyStateDot
} from '@slayzone/terminal'
import type { LoopConfig } from '@slayzone/terminal-contracts'
import { type TerminalContainerHandle, resolveIdRef } from '@slayzone/task-terminals'
import {
  buildStatusOptions,
  cn,
  getColumnStatusStyle,
  PriorityIcon,
  useAppearance,
  matchesShortcut,
  useShortcutStore,
  useShortcutDisplay,
  useStableCallback,
  withModalGuard,
  getThemeEditorColors,
  MountWhenOpened,
  type EditorThemeColors
} from '@slayzone/ui'
import type { BrowserPanelHandle } from '@slayzone/task-browser'
import { getBrowserHost, planHubSuppliedUrl, queueUntrustedLoad } from '@slayzone/task-browser'
import type { LinkOpenTarget } from '@slayzone/editor'
import type { FileEditorViewHandle } from '@slayzone/file-editor/client'
import type { OpenFileOptions } from '@slayzone/file-editor/shared'
import { useTrack } from '@slayzone/telemetry/client'
import {
  usePanelSizes,
  resolvePanels,
  planPanelStrip,
  effectiveLayout,
  minWidthFor,
  applyBoundaryResize,
  unstretchPx
} from './usePanelSizes'
import { usePanelConfig } from './usePanelConfig'
import { useSubTasks } from './useSubTasks'
import { usePanelOwnership } from './usePanelOwnership'
import { SquareArrowOutUpRight } from 'lucide-react'
import { useTaskTagIds } from './useTaskTagIds'
import { useTaskPaletteCommands, type PalettePanel } from './useTaskPaletteCommands'
import { CustomSnoozeDialog } from './SnoozePicker'
import { useTaskScopedQueriesFreshOnReveal } from './taskScopedQueries'
import { markTaskPaneLive, takeTaskPaneEvents } from './taskPaneEvents'
import { ResizeHandle } from './ResizeHandle'
import {
  useCanEdit,
  useMyRole,
  useRunsAgentsHere,
  useSharingStatus
} from '@slayzone/projects/client'
import { useSharedCardHeights } from './useSharedCardHeights'
import { PANEL_KINDS } from './panels/registry'
import { PANEL_KIND_COMPONENTS } from './panels/kinds'
import { TaskPageProvider, type TaskPageContextValue } from './panels/TaskPageContext'
import {
  DescriptionDialog,
  useTaskTemplates,
  useTaskDoctor,
  useTaskTitleEditing,
  usePersistenceSaves,
  useDevServerDetection,
  useTaskTerminalSession,
  useWorkspacePathProbe,
  TaskCompletedScreen,
  gitViewPath,
  useTaskArtifacts,
  useTaskProjectRepos,
  useTaskDetectedRepos,
  type ArtifactsPanelHandle,
  type UnifiedGitPanelHandle
} from './task-detail'

const { agent: AgentKind, web: WebKind } = PANEL_KIND_COMPONENTS

export interface TaskDetailPageProps {
  taskId: string
  /** Live task object from global state (source of truth). */
  task: Task | null
  /** Live project object from global state (source of truth). */
  project: Project | null
  isActive?: boolean
  /** Owns keyboard shortcuts. Defaults to `isActive`. In explode mode, only the focused cell has this true. */
  hasShortcutFocus?: boolean
  compact?: boolean
  zenMode?: boolean
  onBack: () => void
  onTaskUpdated: (task: Task) => void
  onArchiveTask?: (taskId: string) => Promise<void>
  onDeleteTask?: (taskId: string) => Promise<void>
  onNavigateToTask?: (taskId: string) => void
  onConvertTask?: (task: Task) => Promise<Task | void>
  onCloseTab: (taskId: string) => void
  settingsRevision?: number
  terminalFocusRequestId?: number
  onTerminalFocusRequestHandled?: (taskId: string, requestId: number) => void
  isSidePanelResizing?: boolean
  /** Pre-fetched data from Suspense cache. Provided by TaskDetailDataLoader. */
  initialData: TaskDetailData | null
  /** True when this TaskDetailPage is mounted inside a secondary "Open in new window" frame. */
  isSecondaryWindow?: boolean
  /** When provided, called on every panelVisibility change. Lifts state to parent so it
   *  survives remounts triggered by Follow-current-tab swaps. */
  onPanelVisibilityChange?: (visibility: PanelVisibility) => void
}

/**
 * Merge a drag-reordered subset of task-view panel ids back into the global
 * panel_config.order: the reordered ids fill the slots of the panels they replace,
 * in their new order; every other panel keeps its slot.
 */
function mergeReorderedPanels(order: string[], reorderedTaskIds: string[]): string[] {
  const toOrderId = (taskId: string): string => (taskId === 'diff' ? 'git' : taskId)
  const reorderedOrderIds = reorderedTaskIds.map(toOrderId)
  const visibleSet = new Set(reorderedOrderIds)
  let vi = 0
  return order.map((id) => (visibleSet.has(id) ? (reorderedOrderIds[vi++] ?? id) : id))
}

export const TaskDetailPage = React.memo(function TaskDetailPage({
  taskId,
  task: taskProp,
  project: projectProp,
  isActive,
  hasShortcutFocus,
  compact,
  zenMode,
  onBack,
  onTaskUpdated,
  onArchiveTask,
  onDeleteTask,
  onNavigateToTask,
  onConvertTask,
  onCloseTab,
  settingsRevision = 0,
  terminalFocusRequestId = 0,
  onTerminalFocusRequestHandled,
  isSidePanelResizing,
  initialData,
  isSecondaryWindow = false,
  onPanelVisibilityChange
}: TaskDetailPageProps): React.JSX.Element {
  const { track, trackTask } = useTrack()
  // Prefer live global state; fall back to suspense-cached data for subtask race window
  const task = taskProp ?? initialData?.task ?? null
  const project = projectProp ?? initialData?.project ?? null
  // The title-row computer chip's menu; ⌘⇧M toggles it.
  const [computerMenuOpen, setComputerMenuOpen] = useState(false)

  // Owns keyboard shortcuts; falls back to isActive so non-explode callers need not set it.
  const shortcutActive = hasShortcutFocus ?? isActive

  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  // mutateAsync is stable; the mutation result object is not (new each render).
  const { mutateAsync: updateTaskAsync } = useMutation(trpc.task.update.mutationOptions())

  const { modes } = useAgents()

  const { editorThemeId, contentVariant } = useTheme()
  const {
    notesFontFamily,
    notesReadability,
    notesWidth,
    notesCheckedHighlight,
    notesShowToolbar,
    notesSpellcheck
  } = useAppearance()
  const taskHeaderPanelMode = useTabStore((s) => s.taskHeaderPanelMode)
  const taskHeaderPanelAlign = useTabStore((s) => s.taskHeaderPanelAlign)
  const taskHeaderTitleAlign = useTabStore((s) => s.taskHeaderTitleAlign)
  const notesThemeColors: EditorThemeColors = useMemo(
    () => getThemeEditorColors(editorThemeId, contentVariant),
    [editorThemeId, contentVariant]
  )
  // Main tab session ID format used by TerminalContainer/useTaskTerminals.
  const getMainSessionId = useCallback((id: string) => `${id}:${id}`, [])

  // Idle-close engagement: interacting with ANY in-DOM panel of this task
  // (editor, notes, the panel-toggle chrome — anything that isn't the terminal,
  // whose own listener already touches) must keep the main agent's idle clock
  // fresh, or using a sibling panel hibernates the agent out from under the user.
  // The browser panel is a separate WebContentsView handled main-side. Hidden
  // task tabs (display:none) emit no events, so this self-scopes to the one in view.
  //
  // Attached via a CALLBACK ref, not useEffect+useRef: the component early-returns
  // (loading guard) before `#task-detail` mounts, so a `useEffect([], [taskId])`
  // would fire once with a null ref and never re-run when the real tree appears.
  // Fire-and-forget through the stable vanilla trpcClient (never a useMutation
  // object — that would churn the ref every render and could loop the WS).
  const lastPanelTouchAtRef = useRef(0)
  const panelEngagementCleanupRef = useRef<(() => void) | null>(null)
  // This page's own root, for listeners that must hear only THIS page's DOM.
  const [taskRootEl, setTaskRootEl] = useState<HTMLDivElement | null>(null)
  const taskRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      setTaskRootEl(node)
      panelEngagementCleanupRef.current?.()
      panelEngagementCleanupRef.current = null
      if (!node || !taskId) return
      const sessionId = `${taskId}:${taskId}`
      const TOUCH_THROTTLE_MS = 4000
      const report = (): void => {
        const now = performance.now()
        if (now - lastPanelTouchAtRef.current < TOUCH_THROTTLE_MS) return
        lastPanelTouchAtRef.current = now
        void trpcClient.pty.touch.mutate({ sessionId })
      }
      node.addEventListener('keydown', report, true)
      node.addEventListener('mousedown', report, true)
      node.addEventListener('wheel', report, { capture: true, passive: true })
      node.addEventListener('paste', report, true)
      panelEngagementCleanupRef.current = () => {
        node.removeEventListener('keydown', report, true)
        node.removeEventListener('mousedown', report, true)
        node.removeEventListener('wheel', report, true)
        node.removeEventListener('paste', report, true)
      }
    },
    [taskId, trpcClient]
  )

  const [tags, setTags] = useState<Tag[]>(initialData?.tags ?? [])
  useEffect(() => {
    const handleTagUpdated = (e: Event) => {
      const tag = (e as CustomEvent).detail as Tag
      setTags((prev) => prev.map((t) => (t.id === tag.id ? tag : t)))
    }
    window.addEventListener('slayzone:tag-updated', handleTagUpdated)
    return () => window.removeEventListener('slayzone:tag-updated', handleTagUpdated)
  }, [])
  const { tagIds: taskTagIds, setTagIds: setTaskTagIds } = useTaskTagIds(
    task?.id,
    initialData?.taskTagIds,
    initialData?.taskTags
  )
  // Per-task queries (tags, sub-tasks, artifacts) of a hidden tab refresh on reveal.
  useTaskScopedQueriesFreshOnReveal(task?.id, isActive ?? true)
  const statusOptions = useMemo(
    () => buildStatusOptions(project?.columns_config),
    [project?.columns_config]
  )
  const completedStatus = useMemo(
    () => getDoneStatus(project?.columns_config),
    [project?.columns_config]
  )
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false)
  const [priorityPopoverOpen, setPriorityPopoverOpen] = useState(false)
  const [openCompletedAnyway, setOpenCompletedAnyway] = useState(false)
  const [completedVariant, setCompletedVariant] = useState(0)
  useEffect(() => {
    setOpenCompletedAnyway(false)
  }, [task?.id])

  // Sub-tasks
  const {
    subTasks,
    createSubTask,
    updateSubTask: handleUpdateSubTask,
    deleteSubTask: handleDeleteSubTask,
    handleDragEnd: handleSubTaskDragEnd
  } = useSubTasks(task?.id, initialData?.subTasks)

  // Artifacts
  const { artifacts } = useTaskArtifacts(task?.id)
  const { uploadFiles: uploadImageFiles } = useArtifactUpload(task?.id)
  const handleUploadImages = useCallback(
    async (files: File[]) => {
      const uploaded = await uploadImageFiles(files)
      return uploaded.map((a) => ({ id: a.id, title: a.title }))
    },
    [uploadImageFiles]
  )
  const [addingSubTask, setAddingSubTask] = useState(false)
  const [subTaskTitle, setSubTaskTitle] = useState('')
  const subTaskInputRef = useRef<HTMLInputElement>(null)
  const [parentTask] = useState<Task | null>(initialData?.parentTask ?? null)

  // Project path validation.
  //
  // Probed on the machine that owns the workspace (the task's computer), NOT on
  // whichever hub this client is talking to. The old probe was hub-local and
  // ungated — App.tsx had learned to suppress it for remote projects, this copy
  // never did — so a task whose files live on a computer reported
  // "No repository path configured" for a path that was perfectly fine.
  //
  // Three states, deliberately distinct: a path that is set and present, one
  // that is set but gone, and one we could not ask about because the computer is
  // offline. Collapsing the last two is what made a transient disconnect look
  // like a misconfiguration.
  const [projectPathMissing, setProjectPathMissing] = useState(
    initialData?.projectPathMissing ?? false
  )
  const [workspaceUnreachable, setWorkspaceUnreachable] = useState(false)
  const [baseDirPickerOpen, setBaseDirPickerOpen] = useState(false)
  const [projectFolderPickerOpen, setProjectFolderPickerOpen] = useState(false)

  // The project's folder on the computer this task's work runs on (a project has
  // one folder per computer; see @slayzone/projects-contracts placements.ts).
  const projectRoot = taskProjectRoot(task, project)
  // Its folder there in any state: a folder that is chosen but gone (missing) is
  // "not found", not "no folder" — the same message as before folders moved.
  const chosenFolder = placementOn(project, workComputerId(task, project))?.path ?? null

  // Multi-repo detection (drives the *task-bound* axis: terminal cwd, editor root, browser, worktree creation)
  const detectedRepos = useTaskDetectedRepos(projectRoot, project?.id)
  // Task-bound repo name: only what the user has explicitly bound to this task or to the project default.
  // Intentionally NO fallback to first-detected — wrapper folder stays wrapper folder for the bound axis,
  // so the terminal/editor don't silently jump into an arbitrary child repo.
  const effectiveRepoName = taskRepoName(task, project)
  const resolvedRepo = useMemo(
    () => resolveRepoPath(projectRoot, detectedRepos, effectiveRepoName),
    [projectRoot, detectedRepos, effectiveRepoName]
  )
  // Effective repo path (worktree > resolved child repo > project path) — drives terminal/editor/browser/worktree.
  // Shared with the hub's `task.startMainAgent` (../shared/main-terminal).
  // A worktree / custom folder lives on the task's computer (§9 Phase 7d): read there.
  // Until it answers (or while it is away) nothing falls back to the project folder.
  // Only the FIRST answer gates the terminal (useHeldTaskPath): a refetch, a path
  // re-read or a brief offline answer later never unmounts it (B2).
  const taskPath = useHeldTaskPath(task, useTaskPath(task))
  const taskPathLocation = useTaskPathLocation(taskPath)
  const taskPaths = taskPath.state === 'ok' ? taskPath : null
  const worktreePath = taskPaths?.worktreePath ?? null
  const baseDir = taskPaths?.baseDir ?? null
  const taskPathPending = hasOwnFolder(task) && taskPath.state !== 'ok'
  // Its computer holds no folder for it (S7): nowhere to run — shown as missing.
  const taskFolderMissing = ownFolderMissing(task, taskPaths)
  const taskFolderLabel = taskFolderMissing
    ? 'Folder not found on its computer'
    : 'No directory set'
  const effectiveRepoPath = taskRepoPath(task, resolvedRepo.path, taskPaths)
  // The main agent's cwd (terminal and chat): never the project folder for a task
  // with a folder of its own (S7). Null: nowhere to run (yet).
  const mainAgentCwd = mainTerminalCwdFrom(task, effectiveRepoPath, projectRoot)
  // A new task process is stored with the task's folder: it waits until that is known.
  const processesCwdUnavailable =
    !hasOwnFolder(task) || mainAgentCwd
      ? null
      : taskFolderMissing
        ? "This task's folder was not found on its computer"
        : taskPathLocation
          ? `This task's folder is ${taskPathLocation} — connect it to add a process here`
          : "Waiting for the task's folder…"

  // Git-panel viewing axis: ephemeral, repo selection here does NOT change the task-bound path.
  // Default = task-bound; if that resolves to a non-git wrapper folder, default to first discovered repo.
  // Worktree if present, else resolved child / project root (a worktree not read yet: none).
  const taskBoundRepoForView = task?.has_worktree ? worktreePath : resolvedRepo.path
  const { repos: viewableRepos, settled: viewableReposSettled } = useTaskProjectRepos(
    projectRoot,
    taskBoundRepoForView,
    project?.id
  )
  const [gitViewRepoPath, setGitViewRepoPath] = useState<string | null>(null)
  // Resolve the active git-panel target (see gitViewPath). Recomputed on each render so
  // disk changes self-heal.
  const resolvedGitViewPath = gitViewPath({
    picked: gitViewRepoPath,
    repos: viewableRepos,
    reposSettled: viewableReposSettled,
    taskBound: taskBoundRepoForView,
    hasWorktree: !!task?.has_worktree
  })
  const handleRepoChange = useCallback(
    (repoName: string) => {
      // Ephemeral: pick by name from discovered repos. Does NOT persist to task.repo_name.
      const match = viewableRepos.find((r) => r.name === repoName)
      if (match) setGitViewRepoPath(match.path)
    },
    [viewableRepos]
  )

  // PTY context for buffer management
  const { resetTaskState, subscribeSessionDetected, subscribeDevServer } = usePty()

  // Shortcut display strings (reactive to user customization)
  const panelTerminalShortcut = useShortcutDisplay('panel-terminal')
  const panelBrowserShortcut = useShortcutDisplay('panel-browser')
  const panelEditorShortcut = useShortcutDisplay('panel-editor')
  const panelGitShortcut = useShortcutDisplay('panel-git')
  const panelProcessesShortcut = useShortcutDisplay('panel-processes')
  const panelSettingsShortcut = useShortcutDisplay('panel-settings')
  const panelArtifactsShortcut = useShortcutDisplay('panel-artifacts')

  // Title editing state
  const {
    editingTitle,
    setEditingTitle,
    titleValue,
    setTitleValue,
    titleInputRef,
    handleTitleSave,
    handleTitleKeyDown
  } = useTaskTitleEditing(task, onTaskUpdated)

  // Delete/archive dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  /** The project picked in the palette's "Move to project…": the move dialog confirms it. */
  const [moveMode, setMoveMode] = useState<'move' | 'copy'>('move')
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null)
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false)
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  // Custom snooze date/time, opened from Cmd+K (Snooze → Pick date & time…).
  const [snoozeDialogOpen, setSnoozeDialogOpen] = useState(false)

  // Templates for temporary tasks
  const { templates } = useTaskTemplates(task)

  // Description fullscreen dialog
  const [descriptionFullscreen, setDescriptionFullscreen] = useState(false)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [descriptionOpen, setDescriptionOpen] = useState(true)
  const [subTasksOpen, setSubTasksOpen] = useState(true)
  const [artifactsOpen, setArtifactsOpen] = useState(true)
  const [detailsOpen, setDetailsOpen] = useState(true)

  // Settings cards-grid: open cards water-fill the available height (see
  // useSharedCardHeights). In full-height, Details joins the grid as a 4th card.
  const settingsCardsGridRef = useRef<HTMLDivElement>(null)

  // Doctor dialog state
  const { doctorDialogOpen, setDoctorDialogOpen, doctorResults, doctorLoading, handleDoctor } =
    useTaskDoctor(task)

  // In-progress prompt state

  // Description editing state
  const [descriptionValue, setDescriptionValue] = useState(() =>
    normalizeDescription(task?.description ?? null, task?.description_format ?? 'html')
  )
  const descriptionDirty = useRef(false)

  // Terminal restart key (changing this forces remount)
  const [terminalKey, setTerminalKey] = useState(0)

  // Track if the main terminal tab is active (for bottom bar visibility)
  const [isMainTabActive, setIsMainTabActive] = useState(true)
  const [flagsInputValue, setFlagsInputValue] = useState('')
  const [flagsPopoverOpen, setFlagsPopoverOpen] = useState(false)

  // Panel visibility state. Initial value sourced from initialData (secondary lifts via parent).
  const defaultPanelVisibility: PanelVisibility = isSecondaryWindow
    ? {
        terminal: false,
        browser: false,
        diff: false,
        settings: false,
        editor: false,
        artifacts: false,
        processes: false
      }
    : {
        terminal: true,
        browser: false,
        diff: false,
        settings: true,
        editor: false,
        artifacts: false,
        processes: false
      }
  const [panelVisibility, setPanelVisibility] = useState<PanelVisibility>(
    initialData?.panelVisibility ?? defaultPanelVisibility
  )

  // Notify parent on every visibility change (used by SecondaryTaskWindow to persist
  // panel layout across Follow-current-tab swaps that remount this component).
  useEffect(() => {
    onPanelVisibilityChange?.(panelVisibility)
  }, [panelVisibility, onPanelVisibilityChange])

  // Secondary: release all panel ownership for this task on unmount (Follow-current-tab
  // swaps unmount + remount with a new taskId; without this, primary keeps seeing
  // "active in other window" stubs for the previous task).
  useEffect(() => {
    if (!isSecondaryWindow || !task?.id) return
    const releasingTaskId = task.id
    return () => {
      void trpcClient.app.taskWindows.releaseAllForTask.mutate({ taskId: releasingTaskId })
    }
  }, [isSecondaryWindow, task?.id, trpcClient])

  // Panel ownership across windows (multi-window support)
  const ownership = usePanelOwnership(task?.id)

  // Track open secondary task windows so primary hides Detach when secondary exists
  const [openTaskWindowIds, setOpenTaskWindowIds] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    trpcClient.app.taskWindows.list.query().then((ids) => {
      if (alive) setOpenTaskWindowIds(ids)
    })
    return () => {
      alive = false
    }
  }, [trpcClient])
  useSubscription(
    trpc.app.taskWindows.onListChanged.subscriptionOptions(undefined, {
      onData: (ids) => setOpenTaskWindowIds(ids)
    })
  )
  const hasOpenSecondary = !!task && openTaskWindowIds.includes(task.id)

  // Sync description from global state when changed externally. `undefined`
  // only when there is no task (a loaded task has string | null).
  const taskDescription = task?.description
  const taskDescriptionFormat = task?.description_format
  useEffect(() => {
    if (taskDescription === undefined || taskDescriptionFormat === undefined) return
    setDescriptionValue(normalizeDescription(taskDescription, taskDescriptionFormat))
    descriptionDirty.current = false
  }, [taskDescription, taskDescriptionFormat])

  // Browser tabs state
  const defaultBrowserTabs: BrowserTabsState = {
    tabs: [{ id: 'default', url: 'about:blank', title: 'New Tab' }],
    activeTabId: 'default'
  }
  const [browserTabs, setBrowserTabs] = useState<BrowserTabsState>(
    initialData?.browserTabs ?? defaultBrowserTabs
  )

  // Global panel configuration (which panels are enabled, custom web panels)
  const {
    config: panelConfig,
    updateConfig: updatePanelConfig,
    enabledWebPanels,
    isBuiltinEnabled,
    getOrderedTaskIds
  } = usePanelConfig()
  const orderedTaskIds = useMemo(() => getOrderedTaskIds(), [getOrderedTaskIds])
  // Visible panels in config order (pre-cluster). Cluster order + handle neighbors
  // are derived from `resolved` (left-anchored then right-anchored) below.
  const visiblePanelOrder = useMemo(
    () => orderedTaskIds.filter((id) => panelVisibility[id]),
    [orderedTaskIds, panelVisibility]
  )

  // Drag-reorder of the PanelToggle button row. Receives the reordered subset of
  // task-view panel ids (only the buttons actually shown) and merges it back into
  // the global panel_config.order — the same setting the Settings modal writes,
  // so panels reflow to match. Hidden/filtered-out panels keep their slots.
  const handlePanelReorder = useCallback(
    (reorderedTaskIds: string[]) => {
      const next = mergeReorderedPanels(panelConfig.order ?? [], reorderedTaskIds)
      void updatePanelConfig({ ...panelConfig, order: next })
    },
    [panelConfig, updatePanelConfig]
  )

  // Auto-claim panels for this window when visible AND no current owner.
  // First-owner priority: subsequent windows opening same panel render a
  // stub w/ Take over buttons until user explicitly takes over.
  useEffect(() => {
    if (!task || ownership.windowId == null) return
    const claimableIds = [
      'terminal',
      'browser',
      'editor',
      'diff',
      'artifacts',
      'processes',
      'settings'
    ] as const
    for (const id of claimableIds) {
      if (panelVisibility[id] && ownership.ownerOf(id) == null) ownership.claim(id)
    }
    for (const wp of enabledWebPanels) {
      if (panelVisibility[wp.id] && ownership.ownerOf(wp.id) == null) ownership.claim(wp.id)
    }
  }, [task?.id, ownership.windowId, panelVisibility, enabledWebPanels, ownership]) // eslint-disable-line react-hooks/exhaustive-deps

  // When a secondary window closes, primary's renderer flips local visibility off for the
  // panels it owned — they must NOT auto-pop back open here. User clicks toggle to reopen.
  useEffect(() => {
    if (!ownership.releasedOnClose || ownership.releasedOnClose.length === 0) return
    const ids = ownership.releasedOnClose.map((r) => r.panelId)
    setPanelVisibility((prev) => {
      const next = { ...prev }
      let changed = false
      for (const id of ids) {
        if (next[id]) {
          next[id] = false
          changed = true
        }
      }
      return changed ? next : prev
    })
    ownership.consumeReleasedOnClose()
  }, [ownership.releasedOnClose, ownership])

  // "Take over and close" from another window: flip local visibility false (no DB write)
  useSubscription(
    trpc.app.taskWindows.onPanelCloseRequest.subscriptionOptions(undefined, {
      onData: (payload) => {
        if (!task || payload.taskId !== task.id) return
        setPanelVisibility((prev) =>
          prev[payload.panelId] ? { ...prev, [payload.panelId]: false } : prev
        )
      }
    })
  )

  // Panel sizes for resizable panels — per-task, persisted to the DB (mirrors
  // panel_visibility). Secondary windows keep sizes local (no DB write).
  const loadedTaskId = task?.id
  const persistPanelSizes = useCallback(
    (sizes: PanelSizes) => {
      if (!loadedTaskId || isSecondaryWindow) return
      void updateTaskAsync({ id: loadedTaskId, panelSizes: sizes }).then((updated) => {
        if (updated) onTaskUpdated(updated)
      })
    },
    [loadedTaskId, isSecondaryWindow, onTaskUpdated, updateTaskAsync]
  )
  const [panelSizes, updatePanelSizes, commitPanelSizes, resetPanelSize, resetAllPanels] =
    usePanelSizes(initialData?.panelSizes, persistPanelSizes)
  const [isLocalResizing, setIsResizing] = useState(false)
  const isResizing = isLocalResizing || !!isSidePanelResizing

  // Measure split-view container width for auto panel sizing
  const [containerWidth, setContainerWidth] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const lastWidthRef = useRef(0)
  const splitContainerRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect()
      roRef.current = null
    }
    if (el) {
      // Measure synchronously as the ref attaches (commit phase, before paint)
      // so `containerWidth > 0` on the first paint. Otherwise the terminal panel
      // renders `flex:1` (full row width) for one frame before its resolved px
      // width applies, and the terminal's synchronous init fit() bakes columns
      // for that transient-wide box → the terminal renders wider than its panel
      // until a later resize corrects it. The ResizeObserver below only reports
      // on a subsequent frame, which is too late for the mount fit.
      // Content width, like the observer's contentRect: the strip's own padding
      // (p-4) is not panel space. The border box here overflowed the strip by
      // 32px (and showed a scrollbar) whenever the observer never corrected it.
      const cs = getComputedStyle(el)
      const initialWidth = Math.floor(
        el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      )
      if (initialWidth > 0 && Math.abs(initialWidth - lastWidthRef.current) >= 2) {
        lastWidthRef.current = initialWidth
        setContainerWidth(initialWidth)
      }
      roRef.current = new ResizeObserver(([entry]) => {
        const w = Math.floor(entry.contentRect.width)
        if (Math.abs(w - lastWidthRef.current) < 2) return
        lastWidthRef.current = w
        setContainerWidth(w)
      })
      roRef.current.observe(el)
    }
  }, [])

  // Resolve the Figma-style layout: per-panel px widths, the anchor gap, and the
  // left/right cluster order. Reflows on size/config/container-width change.
  const resolved = useMemo(
    () => resolvePanels(visiblePanelOrder, panelConfig, panelSizes, containerWidth),
    [visiblePanelOrder, panelConfig, panelSizes, containerWidth]
  )
  const resolvedWidths = resolved.widths

  // Settings panel layout tier by its width (see the settings render): wide
  // panels split into columns instead of stretching one column edge to edge.
  const settingsWidth = resolvedWidths.settings ?? 0
  const settingsCols = settingsWidth >= 1440 ? 3 : settingsWidth >= 860 ? 2 : 1
  // Full-height Description is a 1-column mode; multi-column already gives it a column.
  const descFullHeight = settingsCols === 1 && descriptionExpanded
  useSharedCardHeights(settingsCardsGridRef, [
    descFullHeight,
    settingsCols,
    descriptionOpen,
    subTasksOpen,
    artifactsOpen,
    detailsOpen
  ])

  // Placement (flex order, gap spacer, handle neighbors) — shared with the home tab.
  const strip = useMemo(() => planPanelStrip(resolved), [resolved])
  const panelOrderIdx = strip.order
  const spacerOrder = strip.spacerOrder ?? 0
  const panelOrderStyle = (id: string): { order: number } => ({ order: panelOrderIdx[id] ?? 0 })
  const getLeftNeighborId = (id: string): string | null => strip.leftNeighbor[id] ?? null

  // Renders the divider before `panelId`. Boundary drag transfers width between
  // the panel and its same-cluster left neighbor, keeping each panel's unit (fr
  // stays fr, px/pct stay static). Persisted once on drag end.
  const renderResizeHandle = (panelId: string): React.ReactNode => {
    const leftId = getLeftNeighborId(panelId)
    if (!leftId) return null
    const leftL = effectiveLayout(leftId, panelConfig, panelSizes)
    const rightL = effectiveLayout(panelId, panelConfig, panelSizes)
    return (
      <ResizeHandle
        leftWidth={resolvedWidths[leftId] ?? 200}
        rightWidth={resolvedWidths[panelId] ?? 200}
        leftMinWidth={resolved.minPx[leftId] ?? minWidthFor(leftId)}
        rightMinWidth={resolved.minPx[panelId] ?? minWidthFor(panelId)}
        leftMaxWidth={resolved.maxPx[leftId]}
        rightMaxWidth={resolved.maxPx[panelId]}
        onResize={(lw, rw) =>
          updatePanelSizes(
            applyBoundaryResize(
              leftL,
              rightL,
              leftId,
              panelId,
              unstretchPx(resolved, leftId, lw),
              unstretchPx(resolved, panelId, rw),
              containerWidth
            )
          )
        }
        onDragStart={() => setIsResizing(true)}
        onDragEnd={() => {
          setIsResizing(false)
          commitPanelSizes()
        }}
        onReset={resetAllPanels}
        style={panelOrderStyle(panelId)}
      />
    )
  }

  // Terminal API (exposed via onReady callback)
  const terminalApiRef = useRef<{
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  } | null>(null)

  // Loop command (labs feature)
  // Live, so turning the lab flag on reaches already-open tasks (the Labs switch
  // refreshes this query when its save lands).
  const loopModeAvailable = useQuery(trpc.app.meta.isLoopModeEnabled.queryOptions()).data ?? false
  const [loopDialogOpen, setLoopDialogOpen] = useState(false)
  const loopConfigured =
    task?.loop_config != null &&
    !!(task.loop_config.prompt.trim() && task.loop_config.criteriaPattern.trim())
  const mainSessionId = task ? getMainSessionId(task.id) : ''
  const handleLoopConfigChange = useCallback(
    (cfg: LoopConfig | null) => {
      if (!loadedTaskId) return
      updateTaskAsync({ id: loadedTaskId, loopConfig: cfg }).then((updated) => {
        if (updated) onTaskUpdated(updated)
      })
    },
    [loadedTaskId, onTaskUpdated, updateTaskAsync]
  )
  const loop = useLoopMode({
    sessionId: mainSessionId,
    onConfigChange: handleLoopConfigChange
  })

  const slayNudge = useSlayNudge({
    computerId: workComputerId(task, project),
    taskId: task?.id ?? null,
    projectId: task?.project_id ?? null,
    projectPath: effectiveRepoPath ?? projectRoot
  })

  // Dev server URL detection
  const {
    detectedDevUrl,
    setDetectedDevUrl,
    browserOpenRef,
    devServerAutoOpenCallbackRef,
    devUrlToastDismissedRef
  } = useDevServerDetection({
    task,
    browserVisible: panelVisibility.browser,
    settingsRevision,
    subscribeDevServer,
    getMainSessionId
  })
  const gitPanelRef = useRef<UnifiedGitPanelHandle>(null)
  const [gitDefaultTab, setGitDefaultTab] = useState<GitTabId>(
    () => task?.git_active_tab ?? 'general'
  )
  const gitTabSyncedRef = useRef(!!task?.git_active_tab)
  useEffect(() => {
    if (gitTabSyncedRef.current) return
    if (task?.git_active_tab) {
      setGitDefaultTab(task.git_active_tab)
      gitTabSyncedRef.current = true
    }
  }, [task?.git_active_tab])
  const handleGitTabChange = (tab: GitTabId) => {
    setGitDefaultTab(tab)
    gitTabSyncedRef.current = true
    if (task?.id) void updateTaskAsync({ id: task.id, gitActiveTab: tab })
  }
  const fileEditorRef = useRef<FileEditorViewHandle>(null)
  const terminalContainerRef = useRef<TerminalContainerHandle>(null)
  const browserPanelRef = useRef<BrowserPanelHandle>(null)
  const artifactsPanelRef = useRef<ArtifactsPanelHandle>(null)
  // Sharing one file with people (T-100); only on a hub with login.
  const sharing = useSharingStatus()
  const runsAgentsHere = useRunsAgentsHere(task?.id)
  // Someone who may edit a task another person created runs their OWN agents on it,
  // on their own computer (T-100); one who may only view it runs none.
  const taskRole = useMyRole('task', task?.id)
  const canRunOwnAgents = taskRole === 'edit' || taskRole === 'manage'
  // A View member (T-100) sees the task as it is: nothing on the page offers an edit.
  const canEdit = useCanEdit('task', task?.id)
  const [sharingArtifact, setSharingArtifact] = useState<{ id: string; title: string } | null>(null)
  const pendingArtifactRef = useRef<string | null>(null)
  const artifactsPanelRefCallback = useCallback((handle: ArtifactsPanelHandle | null) => {
    artifactsPanelRef.current = handle
    if (handle && pendingArtifactRef.current) {
      handle.selectArtifact(pendingArtifactRef.current)
      pendingArtifactRef.current = null
    }
  }, [])
  const pendingEditorFileRef = useRef<string | null>(null)
  const pendingSearchToggleRef = useRef(false)
  const fileEditorRefCallback = useCallback((handle: FileEditorViewHandle | null) => {
    fileEditorRef.current = handle
    if (handle && pendingEditorFileRef.current) {
      handle.openFile(pendingEditorFileRef.current)
      pendingEditorFileRef.current = null
    }
    if (handle && pendingSearchToggleRef.current) {
      handle.toggleSearch()
      pendingSearchToggleRef.current = false
    }
  }, [])
  // One probe, shared by the focus listener and the project-change effect, so
  // the two can never disagree about how the question is asked.
  const probeTaskId = task?.id
  const probeWorkspacePath = useCallback(
    async (path: string): Promise<void> => {
      if (!probeTaskId) return
      if (!(await hubAllows(trpcClient, 'workspace.pathExists'))) return
      const res = await trpcClient.workspace.pathExists
        .query({ taskId: probeTaskId, path })
        .catch(() => null)
      if (!res) {
        // The request itself failed (hub down mid-flight). Same meaning as an
        // unreachable computer: we do not know, so do not claim the path is gone.
        setWorkspaceUnreachable(true)
        setProjectPathMissing(false)
        return
      }
      setWorkspaceUnreachable(!res.reachable)
      setProjectPathMissing(res.reachable && !res.exists)
    },
    [trpcClient, probeTaskId]
  )

  // Re-checked by the VISIBLE tab only — on mount, folder change, reveal and window
  // focus; a hidden tab asks when shown (FU5: N open tabs were N requests per focus).
  const clearWorkspacePathState = useCallback(() => {
    setProjectPathMissing(false)
    setWorkspaceUnreachable(false)
  }, [])
  useWorkspacePathProbe(projectRoot, isActive ?? true, probeWorkspacePath, clearWorkspacePathState)

  // Handle terminal ready - memoized to prevent effect cascade
  const handleTerminalReady = useCallback(
    (api: {
      sendInput: (text: string) => Promise<void>
      write: (data: string) => Promise<boolean>
      focus: () => void
      clearBuffer: () => Promise<void>
    }) => {
      terminalApiRef.current = api
    },
    []
  )

  const handleTerminalFocusRequestHandled = useCallback(
    (requestId: number): void => {
      onTerminalFocusRequestHandled?.(taskId, requestId)
    },
    [onTerminalFocusRequestHandled, taskId]
  )

  // Terminal session lifecycle: session-id discovery, restart/reset/stop, revive, ensure-alive
  const terminalSession = useTaskTerminalSession({
    task,
    // The main agent's cwd, exactly as the terminal container gets it (a chat
    // tab is identified by it).
    agentCwd: mainAgentCwd ?? '',
    onTaskUpdated,
    shortcutActive,
    getMainSessionId,
    resetTaskState,
    subscribeSessionDetected,
    setTerminalKey
  })
  const {
    getConversationIdForMode,
    handleRestartTerminal,
    handleStopAgent,
    handleResetTerminal,
    handleReattachTerminal
  } = terminalSession

  // Inject task title into the main agent's input (no execute)
  const handleInjectTitle = useCallback(async () => {
    if (!task || !terminalApiRef.current) return
    await terminalApiRef.current.sendInput(task.title)
  }, [task])

  // Screenshot: capture browser view and inject path into terminal
  const hubId = useHubId()
  const hubs = useHubRegistryStore((s) => s.hubs)
  const defaultHubId = useHubRegistryStore((s) => s.defaultHubId)
  const handleScreenshot = useCallback(
    async (viewId: string) => {
      // Captured on THIS device's browser host (the web view lives here, not on the hub)
      // into this device's temp dir, so its path only means something to a terminal
      // running here. Elsewhere, say so instead of typing a path that does not exist.
      const host = getBrowserHost()
      if (!host || !task) return
      const hubIsLocal = hubs.some((h) => h.id === (hubId ?? defaultHubId) && h.kind === 'local')
      const resolved = await trpcClient.computers.resolveTaskComputer.query({ taskId: task.id })
      const myComputerIdOnHub = hubIsLocal
        ? null
        : ((await electronBootstrap.getLocalComputerHubs())[hubId ?? defaultHubId]?.computerId ??
          null)
      if (!terminalOnThisDevice({ hubIsLocal, resolved, myComputerIdOnHub })) {
        toast.error('Screenshot not sent', {
          description:
            "This task's terminal runs on another computer, which can't open a file saved on this one. Ask the agent to run `slay browser screenshot` there instead."
        })
        return
      }
      const result = await host.call('view.captureToTempFile', viewId)
      if (!result.success || !result.path) return
      track('screenshot_captured')
      const escaped = result.path.includes(' ') ? `"${result.path}"` : result.path
      await terminalApiRef.current?.write(escaped)
    },
    [task, trpcClient, hubs, hubId, defaultHubId, track]
  )

  const handleInsertElementSnippet = useCallback(
    async (snippet: string) => {
      if (!task) return
      const text = snippet.trim()
      if (!text) return
      const mainSessionId = `${task.id}:${task.id}`
      await trpcClient.pty.write.mutate({ sessionId: mainSessionId, data: text })
    },
    [task, trpcClient]
  )

  // Inject task description into the main agent's input (no execute)
  const handleInjectDescription = useCallback(async () => {
    if (!terminalApiRef.current || !descriptionValue) return
    const plainText = stripMarkdown(descriptionValue)
    if (plainText) {
      await terminalApiRef.current.sendInput(plainText)
    }
  }, [descriptionValue])

  // Cmd+I (title), Cmd+Shift+I (description)
  // Note: Cmd+Shift+K (clear buffer) is handled per-terminal in Terminal.tsx via attachCustomKeyEventHandler
  useEffect(() => {
    // Hidden tabs register nothing: every open tab used to run this on every keystroke.
    if (!shortcutActive) return
    // An agent pane owns focus: a terminal (xterm) or a chat panel.
    const isTerminalFocused = (): boolean => {
      const active = document.activeElement as HTMLElement | null
      if (!active) return false
      if (active.classList.contains('xterm-helper-textarea')) return true
      return !!active.closest('.xterm, [data-chat-panel]')
    }

    const handleKeyDown = withModalGuard((e: KeyboardEvent): void => {
      if (useShortcutStore.getState().isRecording) return
      if (matchesShortcut(e, useShortcutStore.getState().getKeys('terminal-inject-desc'))) {
        if (!isTerminalFocused()) return
        e.preventDefault()
        handleInjectDescription()
      } else if (matchesShortcut(e, useShortcutStore.getState().getKeys('terminal-inject-title'))) {
        if (!isTerminalFocused()) return
        e.preventDefault()
        handleInjectTitle()
      } else if (matchesShortcut(e, useShortcutStore.getState().getKeys('terminal-restart'))) {
        e.preventDefault()
        handleRestartTerminal()
      }
    })
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [shortcutActive, handleInjectTitle, handleInjectDescription, handleRestartTerminal])

  // Screenshot trigger (terminal-screenshot shortcut) from main process
  const handleScreenshotTrigger = useStableCallback(() => {
    const viewId = browserPanelRef.current?.getActiveViewId()
    if (viewId) void handleScreenshot(viewId)
  })
  useSubscription(
    trpc.menu.onScreenshotTrigger.subscriptionOptions(undefined, {
      enabled: !!shortcutActive,
      onData: handleScreenshotTrigger
    })
  )

  // Keep a ref so the onCloseCurrent handler always sees current browserTabs without re-subscribing
  const browserTabsRef = useRef(browserTabs)
  useEffect(() => {
    browserTabsRef.current = browserTabs
  }, [browserTabs])

  // Track last-focused sub-panel via focusin (macOS native menu accelerators clear activeElement by callback time).
  // Listened on this page's root, not the window: every open tab mounts a page, and a
  // window listener let a focus move in ANY tab re-render all of them (and record
  // another tab's panel as this one's Cmd+W target).
  const lastFocusedPanelRef = useRef<'terminal' | 'editor' | 'browser' | null>(null)
  const [focusedPanel, setFocusedPanel] = useState<string | null>(null)
  useEffect(() => {
    if (!taskRootEl) return
    const handleFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement | null
      // Cmd+W tracking (sticky ref, specific selectors)
      if (target?.classList.contains('xterm-helper-textarea') || target?.closest('.xterm')) {
        lastFocusedPanelRef.current = 'terminal'
      } else if (target?.closest('[data-panel-id="editor"]')) {
        lastFocusedPanelRef.current = 'editor'
      } else if (target?.closest('[data-browser-panel]')) {
        lastFocusedPanelRef.current = 'browser'
      }
      // Glow tracking (data-panel-id on all panel wrappers)
      const panelId = target?.closest('[data-panel-id]')?.getAttribute('data-panel-id')
      if (panelId) setFocusedPanel(panelId)
    }
    const handleFocusOut = (e: FocusEvent): void => {
      const related = e.relatedTarget as HTMLElement | null
      if (!related?.closest('[data-panel-id]')) setFocusedPanel(null)
    }
    taskRootEl.addEventListener('focusin', handleFocusIn)
    taskRootEl.addEventListener('focusout', handleFocusOut)
    return () => {
      taskRootEl.removeEventListener('focusin', handleFocusIn)
      taskRootEl.removeEventListener('focusout', handleFocusOut)
    }
  }, [taskRootEl])

  // Cmd+R browser reload is handled globally in App.tsx

  // Handle agent change
  const handleModeChange = useCallback(
    async (mode: AgentId) => {
      if (!task) return
      const oldMode = task.agent_id
      // Main tab session ID format: ${taskId}:${taskId}
      const mainSessionId = `${task.id}:${task.id}`
      // Reset state FIRST to ignore any in-flight data
      resetTaskState(mainSessionId)
      // The hub stops the main agent and stores the mode with every conversation
      // id cleared (fresh start) — the same op mobile and `slay tasks update
      // --agent` call. Data the old agent still sends is ignored.
      const updated = await trpcClient.task.switchMode.mutate({ taskId: task.id, mode })
      // Small delay to let any remaining PTY data be processed and ignored
      await new Promise((r) => setTimeout(r, 100))
      onTaskUpdated(updated)
      // Remount terminal (mark skip to prevent cleanup from re-caching old content)
      markSkipCache(mainSessionId)
      setTerminalKey((k) => k + 1)
      track('terminal_mode_switched', { from: oldMode, to: mode })
    },
    [task, onTaskUpdated, resetTaskState, trpcClient, track]
  )

  const getMainHistory = useCallback(() => {
    if (!task) return ''
    const raw = serializeTerminalHistory(`${task.id}:${task.id}`)
    return stripAnsi(raw)
  }, [task])

  const handleCopyHistory = useCallback(() => {
    const history = getMainHistory()
    if (history) void safeClipboardWriteText(history)
  }, [getMainHistory])

  const handleCopyConversationId = useCallback(() => {
    if (!task) return
    const id = getConversationIdForMode(task)
    if (id) void safeClipboardWriteText(id)
  }, [task, getConversationIdForMode])

  const getProviderFlagsForMode = useCallback((currentTask: Task): string => {
    return getProviderFlags(currentTask.provider_config, currentTask.agent_id)
  }, [])

  const handleFlagsSave = useCallback(
    async (nextValue: string) => {
      if (!task) return
      const currentValue = getProviderFlagsForMode(task)
      if (currentValue === nextValue) return

      const update = {
        id: task.id,
        providerConfig: setProviderFlags(task.provider_config, task.agent_id, nextValue)
      }

      const updated = await updateTaskAsync(update)
      onTaskUpdated(updated)

      const mainSessionId = `${task.id}:${task.id}`
      resetTaskState(mainSessionId)
      await trpcClient.pty.kill.mutate({ sessionId: mainSessionId })
      await new Promise((r) => setTimeout(r, 100))
      markSkipCache(mainSessionId)
      setTerminalKey((k) => k + 1)
    },
    [task, getProviderFlagsForMode, onTaskUpdated, resetTaskState, trpcClient, updateTaskAsync]
  )

  const handleSetDefaultFlags = useCallback(async () => {
    if (!task || task.agent_id === 'terminal') return
    const modeInfo = modes.find((m) => m.id === task.agent_id)
    const defaultFlags = modeInfo?.defaultFlags ?? ''
    setFlagsInputValue(defaultFlags)
    await handleFlagsSave(defaultFlags)
  }, [task, modes, handleFlagsSave])

  useEffect(() => {
    if (!task) return
    setFlagsInputValue(getProviderFlagsForMode(task))
  }, [task, getProviderFlagsForMode])

  // Handle panel visibility toggle
  const handlePanelToggle = useCallback(
    async (panelId: string, active: boolean) => {
      if (!task) return
      track('panel_toggled', { panel: panelId, active, context: 'task' })
      // Reset panel size to default when opening
      if (active) resetPanelSize(panelId)
      const newVisibility = { ...panelVisibility, [panelId]: active }
      setPanelVisibility(newVisibility)
      // Multi-window: claim ownership only if no one owns yet (or already mine).
      // If another window owns, opening here renders a stub w/ Take over buttons —
      // first owner keeps priority until user explicitly takes over or releases.
      if (active) {
        const owner = ownership.ownerOf(panelId)
        if (owner == null || owner === ownership.windowId) ownership.claim(panelId)
      } else {
        if (ownership.isOwnedByMe(panelId)) ownership.release(panelId)
      }
      // Auto-focus panel content so scope tracker detects the right scope
      if (panelId === 'browser' && active) {
        requestAnimationFrame(() => {
          // Create a fresh tab when reopening with no tabs (honors browserDefaultUrl)
          if (browserTabsRef.current.tabs.length === 0) {
            browserPanelRef.current?.newTab()
          }
          browserPanelRef.current?.focus()
        })
      }
      // Persist to DB only for primary window — secondary's visibility is local-only
      if (isSecondaryWindow) return
      const updated = await updateTaskAsync({
        id: task.id,
        panelVisibility: newVisibility
      })
      onTaskUpdated(updated)
    },
    [
      task,
      panelVisibility,
      onTaskUpdated,
      resetPanelSize,
      ownership,
      isSecondaryWindow,
      updateTaskAsync,
      track
    ]
  )

  // Cmd+W: close focused sub-item (terminal group, browser tab, editor file),
  // or fall through to close the task tab if nothing to close
  const handleCloseCurrentFocus = useStableCallback(async () => {
    const panel = lastFocusedPanelRef.current
    if (panel === 'terminal') {
      const closed = (await terminalContainerRef.current?.closeActiveGroup()) ?? true
      if (closed) return
    } else if (panel === 'editor') {
      const closed = fileEditorRef.current?.closeActiveFile()
      if (closed) return
    } else if (panel === 'browser') {
      const bt = browserTabsRef.current
      if (bt.tabs.length > 1) {
        const idx = bt.tabs.findIndex((t) => t.id === bt.activeTabId)
        const newTabs = bt.tabs.filter((t) => t.id !== bt.activeTabId)
        const newActiveId = newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? null
        setBrowserTabs({ tabs: newTabs, activeTabId: newActiveId })
        return
      } else if (bt.tabs.length === 1) {
        setBrowserTabs({ tabs: [], activeTabId: null })
        handlePanelToggle('browser', false)
        return
      }
    }
    // Nothing was closed — close the task tab
    onCloseTab?.(taskId)
  })
  useSubscription(
    trpc.menu.onCloseCurrentFocus.subscriptionOptions(undefined, {
      enabled: !!shortcutActive,
      onData: handleCloseCurrentFocus
    })
  )

  const handleOpenArtifact = useStableCallback(
    ({ taskId: targetTaskId, artifactId }: { taskId: string; artifactId: string }) => {
      if (!task || targetTaskId !== task.id) return
      if (!panelVisibility.artifacts) handlePanelToggle('artifacts', true)
      if (artifactsPanelRef.current) artifactsPanelRef.current.selectArtifact(artifactId)
      else pendingArtifactRef.current = artifactId
    }
  )
  // Chat links name an artifact by full id or a short prefix (`artifact:416b87b4`).
  const handleChatOpenArtifact = useStableCallback((artifactRef: string) => {
    const artifactId =
      resolveIdRef(
        artifactRef,
        artifacts.map((a) => a.id)
      ) ?? artifactRef
    handleOpenArtifact({ taskId, artifactId })
  })
  const handleChatOpenTask = useStableCallback((taskRef: string) => {
    onNavigateToTask?.(taskRef)
  })
  useSubscription(
    trpc.menu.onOpenArtifact.subscriptionOptions(undefined, { onData: handleOpenArtifact })
  )

  const handleQuickOpenFile = useCallback(
    (filePath: string, options?: OpenFileOptions) => {
      if (fileEditorRef.current) {
        fileEditorRef.current.openFile(filePath, options)
      } else {
        pendingEditorFileRef.current = filePath
        handlePanelToggle('editor', true)
      }
    },
    [handlePanelToggle]
  )

  // Snapshot of the task's file-open context for the unified palette.
  // Captured into the dialog payload at the moment the shortcut fires; cleared on close.
  const buildTaskFileContext = useCallback((): SearchFileContext | undefined => {
    if (!effectiveRepoPath || !task) return undefined
    return {
      target: { taskId: task.id },
      projectPath: effectiveRepoPath,
      openFile: (filePath: string) => handleQuickOpenFile(filePath)
    }
  }, [effectiveRepoPath, task, handleQuickOpenFile])

  // Git panel shortcuts (Cmd+G general, Cmd+Shift+G changes): open on `tab`, switch
  // to it, or close when already showing it. Shared by the shortcuts and Cmd+K.
  const toggleGitTab = useStableCallback((tab: GitTabId) => {
    if (!panelVisibility.diff) {
      // The panel mounts on `tab`, so it is also the tab to save (and reopen on).
      handleGitTabChange(tab)
      handlePanelToggle('diff', true)
    } else if (gitPanelRef.current?.getActiveTab() === tab) {
      handlePanelToggle('diff', false)
    } else {
      gitPanelRef.current?.switchToTab(tab)
    }
  })

  // Cmd+T/B/G/S/E/P + web panel shortcuts for panel toggles
  useEffect(() => {
    // Hidden tabs register nothing: every open tab used to run this on every keystroke.
    if (!shortcutActive) return
    const handleKeyDown = withModalGuard((e: KeyboardEvent): void => {
      // Cmd+Shift+G: git diff tab toggle
      if (useShortcutStore.getState().isRecording) return
      const keys = (id: string) => useShortcutStore.getState().getKeys(id)

      if (matchesShortcut(e, keys('editor-search')) && isBuiltinEnabled('editor', 'task')) {
        e.preventDefault()
        if (fileEditorRef.current) {
          if (!panelVisibility.editor) handlePanelToggle('editor', true)
          fileEditorRef.current.toggleSearch()
        } else {
          pendingSearchToggleRef.current = true
          handlePanelToggle('editor', true)
        }
        return
      }
      if (
        matchesShortcut(e, keys('browser-element-picker')) &&
        isBuiltinEnabled('browser', 'task') &&
        panelVisibility.browser
      ) {
        e.preventDefault()
        browserPanelRef.current?.pickElement()
        return
      }
      if (
        matchesShortcut(e, keys('browser-focus-url')) &&
        isBuiltinEnabled('browser', 'task') &&
        panelVisibility.browser
      ) {
        e.preventDefault()
        browserPanelRef.current?.focusUrlBar()
        return
      }
      if (matchesShortcut(e, keys('panel-git-diff')) && isBuiltinEnabled('diff', 'task')) {
        e.preventDefault()
        toggleGitTab('changes')
        return
      }

      // Cmd+P: unified palette (files + tasks + projects) — task owns this when active
      if (matchesShortcut(e, keys('search'))) {
        e.preventDefault()
        useDialogStore.getState().openSearch({ fileContext: buildTaskFileContext() })
        return
      }

      // Cmd+E: toggle editor panel — works even inside CodeMirror
      if (matchesShortcut(e, keys('panel-editor')) && isBuiltinEnabled('editor', 'task')) {
        e.preventDefault()
        handlePanelToggle('editor', !panelVisibility.editor)
        return
      }

      // Safe panel toggles — work even inside CodeMirror / contenteditable
      if (matchesShortcut(e, keys('panel-git')) && isBuiltinEnabled('diff', 'task')) {
        e.preventDefault()
        toggleGitTab('general')
        return
      }
      // Cmd+T: new browser tab when browser panel is open
      if (
        matchesShortcut(e, keys('browser-new-tab')) &&
        panelVisibility.browser &&
        isBuiltinEnabled('browser', 'task')
      ) {
        e.preventDefault()
        browserPanelRef.current?.newTab()
        requestAnimationFrame(() => browserPanelRef.current?.focusUrlBar())
        return
      }
      if (matchesShortcut(e, keys('panel-terminal')) && isBuiltinEnabled('terminal', 'task')) {
        e.preventDefault()
        handlePanelToggle('terminal', !panelVisibility.terminal)
        return
      }
      if (matchesShortcut(e, keys('panel-processes')) && isBuiltinEnabled('processes', 'task')) {
        e.preventDefault()
        handlePanelToggle('processes', !panelVisibility.processes)
        return
      }
      if (matchesShortcut(e, keys('panel-tests')) && isBuiltinEnabled('tests', 'task')) {
        e.preventDefault()
        handlePanelToggle('tests', !panelVisibility.tests)
        return
      }
      if (matchesShortcut(e, keys('panel-artifacts')) && isBuiltinEnabled('artifacts', 'task')) {
        e.preventDefault()
        handlePanelToggle('artifacts', !panelVisibility.artifacts)
        return
      }
      // Skip shortcuts inside CodeMirror / contenteditable so editor bindings (e.g. Mod+B) win
      const target = e.target as HTMLElement
      const inEditor = target?.closest?.('[contenteditable="true"]')
      const inCodeMirror = target?.closest?.('.cm-editor')
      if (inCodeMirror) return

      if (
        matchesShortcut(e, keys('panel-browser')) &&
        !inEditor &&
        isBuiltinEnabled('browser', 'task')
      ) {
        e.preventDefault()
        handlePanelToggle('browser', !panelVisibility.browser)
      } else if (
        matchesShortcut(e, keys('panel-settings')) &&
        isBuiltinEnabled('settings', 'task')
      ) {
        e.preventDefault()
        handlePanelToggle('settings', !panelVisibility.settings)
      } else if (matchesShortcut(e, keys('task-computer'))) {
        e.preventDefault()
        setComputerMenuOpen((open) => !open)
      } else {
        // Web panel shortcuts (not in registry — dynamic per-project config):
        // primary modifier + the panel's letter, exactly as its tab label shows it.
        for (const wp of enabledWebPanels) {
          if (matchesShortcut(e, webPanelShortcutKeys(wp.shortcut))) {
            e.preventDefault()
            handlePanelToggle(wp.id, !panelVisibility[wp.id])
            return
          }
        }
      }
    })
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    shortcutActive,
    panelVisibility,
    handlePanelToggle,
    isBuiltinEnabled,
    enabledWebPanels,
    buildTaskFileContext,
    toggleGitTab
  ])

  const handleDescriptionSave = async (): Promise<void> => {
    if (!task || !descriptionDirty.current) return
    descriptionDirty.current = false

    const updated = await updateTaskAsync({
      id: task.id,
      description: descriptionValue || undefined
    })
    onTaskUpdated(updated)
  }

  const handleCreateSubTask = async (): Promise<void> => {
    if (!task || !subTaskTitle.trim()) return
    await createSubTask({
      projectId: task.project_id,
      title: subTaskTitle.trim(),
      status: getDefaultStatus(project?.columns_config)
    })
    setSubTaskTitle('')
    setAddingSubTask(false)
  }

  // Debounced persistence of web-panel URLs, editor open-files, and active artifact id
  const {
    webPanelUrlsRef,
    handleActiveArtifactIdChange,
    handleArtifactsSidebarChange,
    handleWebPanelUrlChange,
    handleEditorStateChange,
    handleWebPanelFaviconChange
  } = usePersistenceSaves(task)

  // Stable: `applyTemplate` and the git panel's `onTaskUpdated` hold it.
  const handleTaskUpdate = useStableCallback((updated: Task): void => {
    setTitleValue(updated.title)
    setDescriptionValue(updated.description ?? '')
    onTaskUpdated(updated)
  })

  const applyTemplate = useCallback(
    async (template: TaskTemplate) => {
      if (!task) return
      const updates: UpdateTaskInput = { id: task.id }
      if (template.agent_id) updates.agentId = template.agent_id
      if (template.provider_config) updates.providerConfig = template.provider_config
      if (template.panel_visibility) updates.panelVisibility = template.panel_visibility
      if (template.browser_tabs) updates.browserTabs = template.browser_tabs
      if (template.web_panel_urls) updates.webPanelUrls = template.web_panel_urls

      const modeChanged = template.agent_id && template.agent_id !== task.agent_id
      if (modeChanged) {
        const mainSessionId = getMainSessionId(task.id)
        resetTaskState(mainSessionId)
        await trpcClient.pty.kill.mutate({ sessionId: mainSessionId })
        markSkipCache(mainSessionId)
      }

      const updated = await updateTaskAsync(updates)
      handleTaskUpdate(updated)

      if (template.panel_visibility) setPanelVisibility(template.panel_visibility)
      if (template.browser_tabs) setBrowserTabs(template.browser_tabs)
      if (template.web_panel_urls) webPanelUrlsRef.current = { ...template.web_panel_urls }

      if (modeChanged) {
        setTerminalKey((k) => k + 1)
      }
    },
    [
      task,
      getMainSessionId,
      resetTaskState,
      trpcClient,
      updateTaskAsync,
      handleTaskUpdate,
      webPanelUrlsRef
    ]
  )

  // Wrapper for GitPanel that calls API and notifies parent
  const updateTaskAndNotify = async (data: {
    id: string
    worktreePath?: string | null
    worktreeParentBranch?: string | null
    baseDir?: string | null
    browserUrl?: string | null
    status?: Task['status']
  }): Promise<Task> => {
    // Only reset PTY when the effective working directory actually changes
    const oldEffective = worktreePath ?? baseDir ?? resolvedRepo.path
    const newWorktree = data.worktreePath !== undefined ? data.worktreePath : worktreePath
    const newBaseDir = data.baseDir !== undefined ? data.baseDir : baseDir
    const newEffective = newWorktree ?? newBaseDir ?? resolvedRepo.path
    const cwdChanged = oldEffective !== newEffective

    // The update goes first: the task's computer judges a new folder before anything
    // is written (B3), so a refused folder throws here and the running terminal keeps
    // running in the old one. Only an accepted change stops it.
    const updated = await updateTaskAsync(data)

    if (cwdChanged) {
      const mainSessionId = `${data.id}:${data.id}`
      resetTaskState(mainSessionId)
      await trpcClient.pty.kill.mutate({ sessionId: mainSessionId })
      markSkipCache(mainSessionId)
    }

    handleTaskUpdate(updated)

    // Force terminal remount if effective cwd changed
    if (cwdChanged) {
      setTerminalKey((k) => k + 1)
    }

    return updated
  }

  // Handler for browser tabs changes
  const handleBrowserTabsChange = useCallback(
    async (tabs: BrowserTabsState) => {
      setBrowserTabs(tabs)
      if (!task) return
      // Persist to DB (debounced via the tab state itself)
      await updateTaskAsync({
        id: task.id,
        browserTabs: tabs
      })
    },
    [task, updateTaskAsync]
  )

  // Open a dev server URL in the browser panel (used by both auto-open and toast)
  const openDevServerInBrowser = useCallback(
    (url: string, tabId?: string, isolated?: boolean) => {
      handlePanelToggle('browser', true)
      const id = tabId ?? `tab-${safeRandomUUID().slice(0, 8)}`
      const newTab = {
        id,
        url,
        title: url === 'about:blank' ? 'New Tab' : url,
        ...(isolated ? { isolated: true } : {})
      }
      if (browserOpenRef.current) {
        handleBrowserTabsChange({ tabs: [...browserTabs.tabs, newTab], activeTabId: newTab.id })
      } else {
        handleBrowserTabsChange({ tabs: [newTab], activeTabId: newTab.id })
      }
    },
    [handlePanelToggle, handleBrowserTabsChange, browserTabs, browserOpenRef]
  )

  useEffect(() => {
    devServerAutoOpenCallbackRef.current = openDevServerInBrowser
  }, [openDevServerInBrowser, devServerAutoOpenCallbackRef])

  // ⌘-clicked markdown links in the description: in-app browser / external.
  const handleDescriptionOpenLink = useStableCallback((href: string, target: LinkOpenTarget) => {
    if (target === 'in-app-browser') openDevServerInBrowser(href)
    else void trpcClient.app.shell.openExternal.mutate({ url: href })
  })

  // A URL the HUB sends (slay browser new / --panel visible / auto-open) is loaded on
  // THIS device, by the same rule as a relayed navigation: web pages only — no local
  // file, no address on this computer or its private network — except for an agent on
  // this very machine through this device's own local hub (main's behaviour). Anyone
  // else gets an ISOLATED tab (its own empty browser, never the user's): it opens blank,
  // then the URL loads as an untrusted host load, name resolved first
  // (`planHubSuppliedUrl`).
  const callerIsTrustedLocal = (origin: 'hub-machine' | 'elsewhere' | undefined): boolean =>
    origin === 'hub-machine' &&
    hubs.some((h) => h.id === (hubId ?? defaultHubId) && h.kind === 'local')
  const planHubUrl = (
    url: string | null | undefined,
    origin: 'hub-machine' | 'elsewhere' | undefined
  ): { url: string; untrusted: boolean } | null =>
    planHubSuppliedUrl(url, {
      hubIsLocal: hubs.some((h) => h.id === (hubId ?? defaultHubId) && h.kind === 'local'),
      origin
    })

  // CLI: open browser panel when requested by main process (slay tasks browser --panel=visible)
  const handleBrowserEnsurePanelOpen = useStableCallback(
    ({
      taskId,
      url: rawUrl,
      tabId,
      origin,
      isolated
    }: {
      taskId: string
      url?: string | null
      tabId?: string | null
      origin?: 'hub-machine' | 'elsewhere'
      isolated?: boolean
    }) => {
      if (!task || taskId !== task.id) return
      const load = planHubUrl(rawUrl, origin)
      if (tabId) {
        // CLI targeted an existing tab — open panel and switch to that tab.
        // The navigate route will load `url` into the targeted tab's webContents.
        // Anyone but the user's own local agent may only bring up an isolated tab.
        handlePanelToggle('browser', true)
        const tabs = browserTabsRef.current
        const target = tabs.tabs.find((t) => t.id === tabId)
        if (
          target &&
          (target.isolated || callerIsTrustedLocal(origin)) &&
          tabs.activeTabId !== tabId
        ) {
          handleBrowserTabsChange({ ...tabs, activeTabId: tabId })
        }
      } else if (load?.untrusted || isolated) {
        // Anyone but the user's own local agent works in a NEW isolated tab (the hub
        // asks for one when such a caller has none; an untrusted URL always gets one).
        const newTabId = `tab-${safeRandomUUID().slice(0, 8)}`
        if (load?.untrusted) queueUntrustedLoad(task.id, newTabId, load.url)
        openDevServerInBrowser('about:blank', newTabId, true)
      } else if (load) {
        openDevServerInBrowser(load.url)
      } else {
        handlePanelToggle('browser', true)
      }
    }
  )
  useSubscription(
    trpc.menu.onBrowserEnsurePanelOpen.subscriptionOptions(undefined, {
      enabled: !!task,
      onData: handleBrowserEnsurePanelOpen
    })
  )

  // CLI: create a new browser tab with a server-supplied tabId (slay tasks browser new)
  const handleBrowserCreateTab = useStableCallback(
    ({
      taskId,
      tabId,
      url,
      background,
      origin,
      isolated
    }: {
      taskId: string
      tabId: string
      url?: string | null
      background?: boolean
      origin?: 'hub-machine' | 'elsewhere'
      isolated?: boolean
    }) => {
      if (!task || taskId !== task.id) return
      handlePanelToggle('browser', true)
      const load = planHubUrl(url, origin)
      const tabUrl = load && !load.untrusted ? load.url : 'about:blank'
      // Anyone but the user's own local agent gets an isolated tab, whatever the hub says.
      const newTab = {
        id: tabId,
        url: tabUrl,
        title: tabUrl === 'about:blank' ? 'New Tab' : tabUrl,
        ...(isolated || !callerIsTrustedLocal(origin) ? { isolated: true } : {})
      }
      const current = browserTabsRef.current
      if (current.tabs.some((t) => t.id === tabId)) return
      if (load?.untrusted) queueUntrustedLoad(task.id, tabId, load.url)
      const nextActive = background && current.tabs.length > 0 ? current.activeTabId : tabId
      handleBrowserTabsChange({ tabs: [...current.tabs, newTab], activeTabId: nextActive })
    }
  )
  useSubscription(
    trpc.menu.onBrowserCreateTab.subscriptionOptions(undefined, {
      enabled: !!task,
      onData: handleBrowserCreateTab
    })
  )

  // Events for this task that arrived before this page mounted (a hidden tab
  // still waiting for its idle hydration, or a tab opened a beat ago) were held
  // for it by TaskPaneEventCatcher: run them through the same handlers now, then
  // mark the page live so the catcher stops holding on its behalf.
  const liveTaskId = task?.id
  useEffect(() => {
    if (!liveTaskId) return
    for (const ev of takeTaskPaneEvents(liveTaskId, [
      'browser-ensure-panel-open',
      'browser-create-tab',
      'open-artifact'
    ])) {
      if (ev.kind === 'browser-ensure-panel-open') handleBrowserEnsurePanelOpen(ev.payload)
      else if (ev.kind === 'browser-create-tab') handleBrowserCreateTab(ev.payload)
      else if (ev.kind === 'open-artifact') handleOpenArtifact(ev.payload)
    }
    return markTaskPaneLive(liveTaskId)
  }, [liveTaskId, handleBrowserEnsurePanelOpen, handleBrowserCreateTab, handleOpenArtifact])

  const handleTagsChange = (newTagIds: string[]): void => {
    setTaskTagIds(newTagIds)
  }

  const isArchived = !!task?.archived_at

  const handleUnarchive = async (): Promise<void> => {
    if (!task) return
    const restored = await trpcClient.task.unarchive.mutate({ id: task.id })
    handleTaskUpdate(restored)
  }

  const handleArchive = async (): Promise<void> => {
    if (!task) return
    if (onArchiveTask) {
      await onArchiveTask(task.id)
    } else {
      await trpcClient.task.archive.mutate({ id: task.id })
    }
    handleTaskUpdate({ ...task, archived_at: new Date().toISOString() })
    setArchiveDialogOpen(false)
  }

  const handleDeleteConfirm = (): void => {
    setDeleteDialogOpen(false)
  }

  // Cmd+K "Current task" section — the same handlers the page's own controls run.
  const palettePanels: PalettePanel[] = []
  const addPalettePanel = (id: string, label: string, shortcutId?: string, open?: boolean) => {
    palettePanels.push({ id, label, shortcutId, open: open ?? !!panelVisibility[id] })
  }
  if (isBuiltinEnabled('terminal', 'task'))
    addPalettePanel('terminal', 'Terminal', 'panel-terminal')
  if (isBuiltinEnabled('browser', 'task')) addPalettePanel('browser', 'Browser', 'panel-browser')
  if (isBuiltinEnabled('editor', 'task')) addPalettePanel('editor', 'Editor', 'panel-editor')
  if (isBuiltinEnabled('diff', 'task')) {
    addPalettePanel('git', 'Git', 'panel-git', !!panelVisibility.diff)
    addPalettePanel('git-diff', 'Git diff', 'panel-git-diff', !!panelVisibility.diff)
  }
  if (isBuiltinEnabled('processes', 'task'))
    addPalettePanel('processes', 'Processes', 'panel-processes')
  if (isBuiltinEnabled('tests', 'task')) addPalettePanel('tests', 'Tests', 'panel-tests')
  if (isBuiltinEnabled('artifacts', 'task'))
    addPalettePanel('artifacts', 'Artifacts', 'panel-artifacts')
  if (isBuiltinEnabled('settings', 'task'))
    addPalettePanel('settings', 'Settings', 'panel-settings')
  for (const wp of enabledWebPanels) addPalettePanel(wp.id, wp.name)

  useTaskPaletteCommands({
    enabled: !!shortcutActive,
    task,
    columnsConfig: project?.columns_config,
    statusOptions,
    tags,
    taskTagIds,
    panels: palettePanels,
    modes,
    hasConversationId: !!task && !!getConversationIdForMode(task),
    hasDescription: !!descriptionValue,
    canRenameInline: !compact && !zenMode && canEdit,
    onTaskUpdated: handleTaskUpdate,
    onTagsChange: handleTagsChange,
    onMoveToProject: (id, mode = 'move') => {
      setMoveMode(mode)
      setMoveTargetId(id)
    },
    onDuplicate: () => setDuplicateDialogOpen(true),
    onRenameInline: () => {
      setEditingTitle(true)
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    },
    onRename: async (title) => {
      if (!task || title === task.title) return
      handleTaskUpdate(await updateTaskAsync({ id: task.id, title }))
    },
    onArchive: () => setArchiveDialogOpen(true),
    onUnarchive: handleUnarchive,
    onDelete: () => setDeleteDialogOpen(true),
    onCreateSubTask: async (title) => {
      if (!task) return
      await createSubTask({
        projectId: task.project_id,
        title,
        status: getDefaultStatus(project?.columns_config)
      })
    },
    onModeChange: (mode) => handleModeChange(mode as AgentId),
    onRestartAgent: handleRestartTerminal,
    onInjectTitle: handleInjectTitle,
    onInjectDescription: handleInjectDescription,
    onCopyConversationId: handleCopyConversationId,
    onCustomSnooze: () => setSnoozeDialogOpen(true),
    parentTask,
    templates,
    windowAction: isSecondaryWindow ? 'reattach' : hasOpenSecondary ? null : 'detach',
    browserOpen: !!panelVisibility.browser && isBuiltinEnabled('browser', 'task'),
    onConvertToTask: async () => {
      if (!task) return
      const converted = await onConvertTask?.(task)
      if (converted) {
        handleTaskUpdate(converted)
        setEditingTitle(true)
      }
    },
    onApplyTemplate: applyTemplate,
    onNavigateToTask: (id) => onNavigateToTask?.(id),
    onCloseTask: () => onCloseTab(taskId),
    onToggleWindow: () => {
      if (isSecondaryWindow) void trpcClient.app.window.close.mutate()
      else void trpcClient.app.taskWindows.open.mutate({ taskId })
    },
    onStopAgent: handleStopAgent,
    onResetTerminal: handleResetTerminal,
    onReattachTerminal: handleReattachTerminal,
    onCopyHistory: handleCopyHistory,
    onEditFlags: () => {
      // The flags dialog lives in the terminal panel's header.
      if (!panelVisibility.terminal) handlePanelToggle('terminal', true)
      setFlagsPopoverOpen(true)
    },
    onResetFlags: handleSetDefaultFlags,
    onDoctor: handleDoctor,
    onEditDescription: () => setDescriptionFullscreen(true),
    onNewArtifact: () => {
      if (!panelVisibility.artifacts) handlePanelToggle('artifacts', true)
      artifactsPanelRef.current?.createArtifact()
    },
    onOpenExternal: (url) => void trpcClient.app.shell.openExternal.mutate({ url }),
    onNewBrowserTab: () => {
      browserPanelRef.current?.newTab()
      requestAnimationFrame(() => browserPanelRef.current?.focusUrlBar())
    },
    onBrowserScreenshot: handleScreenshotTrigger,
    onTogglePanel: (panelId) => {
      if (panelId === 'git') toggleGitTab('general')
      else if (panelId === 'git-diff') toggleGitTab('changes')
      else handlePanelToggle(panelId, !panelVisibility[panelId])
    }
  })

  if (!task) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">Task not found</p>
          <Button variant="link" onClick={onBack}>
            Go back
          </Button>
        </div>
      </div>
    )
  }

  const visiblePanelCount = [...BUILTIN_PANEL_IDS, ...enabledWebPanels.map((wp) => wp.id)].filter(
    (panelId) => !!panelVisibility[panelId]
  ).length
  const hasVisiblePanels = visiblePanelCount > 0
  const multipleVisiblePanels = visiblePanelCount > 1
  const isTaskCompleted = isCompletedStatus(task.status, project?.columns_config)

  const mainTerminal = mainTerminalProps(task, project, modes)

  // What the panels read from this page (see panels/TaskPageContext). Each section
  // is its own object, so the compiler keeps a section stable while its inputs are:
  // a tab switch changes `isActive`, not what the settings panel shows.
  const taskPage: TaskPageContextValue = {
    task,
    project,
    isActive,
    shortcutActive,
    compact,
    isResizing,
    canEdit,
    effectiveRepoPath,
    mainAgentCwd,
    openDevServerInBrowser,
    handleTaskUpdate,
    updateTaskAndNotify,
    getMainSessionId,
    panels: {
      panelVisibility,
      handlePanelToggle,
      ownership,
      focusedPanel,
      multipleVisiblePanels,
      containerWidth,
      resolvedWidths,
      panelOrderIdx
    },
    agent: {
      runsAgentsHere,
      canRunOwnAgents,
      projectRoot,
      chosenFolder,
      projectPathMissing,
      workspaceUnreachable,
      taskPathPending,
      taskPathLocation,
      taskFolderMissing,
      worktreePath,
      baseDir,
      terminalContainerRef,
      terminalKey,
      mainTerminal,
      modes,
      terminalFocusRequestId,
      handleTerminalReady,
      handleTerminalFocusRequestHandled,
      isMainTabActive,
      setIsMainTabActive,
      handleQuickOpenFile,
      handleChatOpenArtifact,
      handleChatOpenTask,
      session: terminalSession,
      loop,
      loopConfigured,
      loopModeAvailable,
      setLoopDialogOpen,
      handleLoopConfigChange,
      slayNudge,
      handleModeChange,
      flagsPopoverOpen,
      setFlagsPopoverOpen,
      flagsInputValue,
      setFlagsInputValue,
      handleFlagsSave,
      getProviderFlagsForMode,
      handleSetDefaultFlags,
      handleInjectTitle,
      handleInjectDescription,
      handleCopyHistory,
      handleCopyConversationId,
      handleDoctor,
      projectFolderPickerOpen,
      setProjectFolderPickerOpen
    },
    browser: {
      browserPanelRef,
      browserTabs,
      handleBrowserTabsChange,
      handleInsertElementSnippet,
      handleScreenshot
    },
    editor: { fileEditorRefCallback, handleEditorStateChange },
    artifacts: {
      artifactsPanelRef,
      artifactsPanelRefCallback,
      handleActiveArtifactIdChange,
      handleArtifactsSidebarChange,
      sharingEnabled: sharing.enabled,
      sharingArtifact,
      setSharingArtifact
    },
    web: { enabledWebPanels, handleWebPanelUrlChange, handleWebPanelFaviconChange },
    git: {
      gitPanelRef,
      resolvedGitViewPath,
      completedStatus,
      gitDefaultTab,
      handleGitTabChange,
      viewableRepos,
      handleRepoChange
    },
    settings: {
      tags,
      setTags,
      taskTagIds,
      handleTagsChange,
      taskPath,
      taskPathLocation,
      taskFolderLabel,
      baseDir,
      baseDirPickerOpen,
      setBaseDirPickerOpen,
      isArchived,
      handleUnarchive,
      setArchiveDialogOpen,
      setDeleteDialogOpen,
      settingsCardsGridRef,
      settingsCols,
      descFullHeight,
      descriptionOpen,
      setDescriptionOpen,
      descriptionExpanded,
      setDescriptionExpanded,
      subTasksOpen,
      setSubTasksOpen,
      artifactsOpen,
      setArtifactsOpen,
      detailsOpen,
      setDetailsOpen,
      setDescriptionFullscreen,
      descriptionValue,
      setDescriptionValue,
      descriptionDirty,
      handleDescriptionSave,
      handleUploadImages,
      handleDescriptionOpenLink,
      notes: {
        fontFamily: notesFontFamily,
        checkedHighlight: notesCheckedHighlight,
        showToolbar: notesShowToolbar,
        spellcheck: notesSpellcheck,
        themeColors: notesThemeColors
      },
      statusOptions,
      subTasks,
      handleSubTaskDragEnd,
      handleUpdateSubTask,
      handleDeleteSubTask,
      addingSubTask,
      setAddingSubTask,
      subTaskTitle,
      setSubTaskTitle,
      subTaskInputRef,
      handleCreateSubTask,
      onNavigateToTask,
      artifacts,
      artifactsPanelRef
    },
    processes: { processesCwdUnavailable }
  }

  // A built-in panel other than the agent: its resize handle, then the panel.
  const renderPanel = (
    kind: 'browser' | 'editor' | 'artifacts' | 'git' | 'settings' | 'processes'
  ): React.ReactNode => {
    const panelId = PANEL_KINDS[kind].primaryPanelId
    if (compact || !panelVisibility[panelId]) return null
    const Kind = PANEL_KIND_COMPONENTS[kind]
    return (
      <>
        {renderResizeHandle(panelId)}
        <Kind panelId={panelId} />
      </>
    )
  }

  return (
    <div
      id="task-detail"
      ref={taskRootRef}
      className={cn('h-full flex flex-col', compact && 'p-0')}
    >
      {compact && (
        <div className="shrink-0 flex items-center gap-1.5 px-2 h-10 bg-surface-1 border-b border-border min-w-0">
          {!task.is_temporary &&
            (() => {
              const statusStyle = getColumnStatusStyle(task.status, project?.columns_config)
              if (!statusStyle) return null
              const StatusIcon = statusStyle.icon
              return (
                <Popover open={statusPopoverOpen} onOpenChange={setStatusPopoverOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer transition-opacity hover:opacity-70"
                    >
                      <StatusIcon className={cn('size-4', statusStyle.iconClass)} strokeWidth={3} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-44 p-1" align="start">
                    {statusOptions.map((opt) => {
                      const optStyle = getColumnStatusStyle(opt.value, project?.columns_config)
                      const OptIcon = optStyle?.icon ?? Circle
                      const isCurrent = opt.value === task.status
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          className={cn(
                            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm cursor-pointer hover:bg-accent',
                            isCurrent && 'bg-accent font-medium'
                          )}
                          onClick={async () => {
                            const updated = await updateTaskAsync({
                              id: task.id,
                              status: opt.value
                            })
                            handleTaskUpdate(updated)
                            setStatusPopoverOpen(false)
                          }}
                        >
                          <OptIcon className={cn('size-4', optStyle?.iconClass)} />
                          {opt.label}
                        </button>
                      )
                    })}
                  </PopoverContent>
                </Popover>
              )
            })()}
          {/* Double-click to rename, mirroring the tab bar. Explode mode sets
              `hideTabs`, so this compact header is the ONLY place the title is
              shown — without this a task cannot be renamed there. Double-click
              rather than the full header's single-click: this strip is small and
              clicking it is how you focus the cell. */}
          {editingTitle && !task.is_temporary ? (
            <input
              ref={titleInputRef}
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={handleTitleKeyDown}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              className="text-xs font-medium flex-1 min-w-0 bg-transparent border-none outline-none ring-1 ring-ring rounded px-1"
              aria-label="Task title"
              data-testid="compact-title-input"
            />
          ) : (
            <span
              className={cn(
                'text-xs font-medium truncate flex-1',
                !task.is_temporary && 'cursor-text'
              )}
              onDoubleClick={
                task.is_temporary || !canEdit
                  ? undefined
                  : (e) => {
                      e.stopPropagation()
                      setEditingTitle(true)
                    }
              }
              title={task.is_temporary || !canEdit ? undefined : 'Double-click to rename'}
              data-testid="compact-title"
            >
              {task.title}
            </span>
          )}
          {!task.is_temporary && (
            <Popover open={priorityPopoverOpen} onOpenChange={setPriorityPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="shrink-0 inline-flex items-center rounded-full bg-muted/50 px-1.5 py-0.5 cursor-pointer transition-colors hover:bg-muted"
                >
                  <PriorityIcon priority={task.priority} className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[140px] p-1" align="end">
                {priorityOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1 text-xs cursor-pointer hover:bg-accent',
                      opt.value === task.priority && 'bg-accent font-medium'
                    )}
                    onClick={async () => {
                      const updated = await updateTaskAsync({
                        id: task.id,
                        priority: opt.value
                      })
                      handleTaskUpdate(updated)
                      setPriorityPopoverOpen(false)
                    }}
                  >
                    <PriorityIcon priority={opt.value} className="size-3.5" />
                    {opt.label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
          <span className="shrink-0 inline-flex items-center rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            {task.agent_id}
          </span>
          <PtyStateDot sessionId={getMainSessionId(task.id)} />
        </div>
      )}
      {/* Header */}
      {!compact && !zenMode && (
        <header className={cn('shrink-0 relative', !compact && 'mx-4 mt-4')}>
          <div>
            <div
              className={cn(
                'flex items-center gap-4 window-no-drag',
                taskHeaderTitleAlign === 'left' &&
                  taskHeaderPanelAlign === 'right' &&
                  'justify-between',
                taskHeaderTitleAlign === 'right' &&
                  taskHeaderPanelAlign === 'left' &&
                  'justify-between flex-row-reverse',
                taskHeaderTitleAlign === 'left' &&
                  taskHeaderPanelAlign === 'left' &&
                  'justify-start',
                taskHeaderTitleAlign === 'right' &&
                  taskHeaderPanelAlign === 'right' &&
                  'justify-end'
              )}
            >
              {task.is_temporary ? (
                <div className="flex shrink-0">
                  <div className="relative min-w-0 w-full">
                    <div className="flex items-center gap-3">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="size-5 text-muted-foreground/55 shrink-0" />
                        </TooltipTrigger>
                        <TooltipContent>
                          Saved in Temporary tasks until you delete it
                        </TooltipContent>
                      </Tooltip>
                      <span className="text-2xl italic text-muted-foreground">{task.title}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 shrink-0"
                        onClick={async () => {
                          const converted = await onConvertTask?.(task)
                          if (converted) {
                            handleTaskUpdate(converted)
                            setEditingTitle(true)
                          }
                        }}
                      >
                        Save as task
                      </Button>
                      {templates.length > 0 && (
                        <DropdownMenu>
                          <Tooltip>
                            <DropdownMenuTrigger asChild>
                              <TooltipTrigger asChild>
                                <Button variant="outline" size="icon" className="size-7 shrink-0">
                                  <LayoutTemplate className="size-4" />
                                </Button>
                              </TooltipTrigger>
                            </DropdownMenuTrigger>
                            <TooltipContent>Apply template</TooltipContent>
                          </Tooltip>
                          <DropdownMenuContent align="start" className="min-w-0">
                            {templates.map((t, i) => (
                              <DropdownMenuItem
                                key={t.id}
                                className="items-baseline gap-2.5"
                                onClick={() => applyTemplate(t)}
                              >
                                <span className="text-[11px] text-muted-foreground tabular-nums">
                                  {i + 1}
                                </span>
                                {t.name}
                                {t.is_default ? ' ♦' : ''}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 shrink-0">
                  <fieldset disabled={!canEdit} className="contents">
                    <TaskStatusMenu
                      task={task}
                      project={project}
                      statusOptions={statusOptions}
                      onTaskUpdate={handleTaskUpdate}
                    />
                  </fieldset>
                  <div className="inline-grid items-center min-w-[2ch]">
                    <span className="invisible col-start-1 row-start-1 text-2xl font-bold whitespace-pre">
                      {titleValue || ' '}
                    </span>
                    <input
                      ref={titleInputRef}
                      value={titleValue}
                      onChange={(e) => setTitleValue(e.target.value)}
                      onBlur={handleTitleSave}
                      onKeyDown={handleTitleKeyDown}
                      onClick={() => canEdit && setEditingTitle(true)}
                      readOnly={!editingTitle || !canEdit}
                      className={cn(
                        'col-start-1 row-start-1 text-2xl font-bold bg-transparent border-none outline-none w-full',
                        !editingTitle && canEdit && 'cursor-pointer'
                      )}
                    />
                  </div>
                  {!canEdit && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
                          data-testid="task-view-only"
                        >
                          View only
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>You can see this task but not change it.</TooltipContent>
                    </Tooltip>
                  )}
                  {canEdit && (
                    <TaskComputerChip
                      taskId={task.id}
                      projectId={task.project_id}
                      taskComputerId={(task as { computer_id?: string | null }).computer_id ?? null}
                      projectDefaultComputerId={
                        (project as { default_computer_id?: string | null } | null)
                          ?.default_computer_id ?? null
                      }
                      open={computerMenuOpen}
                      onOpenChange={setComputerMenuOpen}
                    />
                  )}
                </div>
              )}

              {task.linear_url && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault()
                        void trpcClient.app.shell.openExternal.mutate({ url: task.linear_url! })
                      }}
                      className="shrink-0 rounded bg-indigo-500/10 px-1.5 py-0.5 text-xs font-semibold text-indigo-600 hover:bg-indigo-500/20 dark:text-indigo-400"
                    >
                      Linear
                    </a>
                  </TooltipTrigger>
                  <TooltipContent>Open in Linear</TooltipContent>
                </Tooltip>
              )}

              <div
                className={cn(
                  'flex items-center gap-1 min-w-0',
                  taskHeaderPanelAlign === 'left' && 'flex-row-reverse'
                )}
              >
                {task &&
                  (isSecondaryWindow || !hasOpenSecondary) &&
                  (taskHeaderPanelMode === 'menu' ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={
                            isSecondaryWindow ? 'Reattach task' : 'Detach task to new window'
                          }
                          onClick={() => {
                            if (isSecondaryWindow) void trpcClient.app.window.close.mutate()
                            else void trpcClient.app.taskWindows.open.mutate({ taskId: task.id })
                          }}
                          className="shrink-0 inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        >
                          <SquareArrowOutUpRight className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {isSecondaryWindow ? 'Reattach' : 'Detach'}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <button
                      type="button"
                      aria-label={isSecondaryWindow ? 'Reattach task' : 'Detach task to new window'}
                      onClick={() => {
                        if (isSecondaryWindow) void trpcClient.app.window.close.mutate()
                        else void trpcClient.app.taskWindows.open.mutate({ taskId: task.id })
                      }}
                      className="shrink-0 flex items-center gap-1.5 rounded-full bg-muted/50 hover:bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <SquareArrowOutUpRight className="size-3.5" />
                      {isSecondaryWindow ? 'Reattach' : 'Detach'}
                    </button>
                  ))}
                {(() => {
                  const entries: Record<
                    string,
                    { id: string; icon: typeof Globe; label: string; shortcut?: string | null }
                  > = {
                    terminal: {
                      id: 'terminal',
                      icon: TerminalIcon,
                      label: 'Agent',
                      shortcut: panelTerminalShortcut
                    },
                    browser: {
                      id: 'browser',
                      icon: Globe,
                      label: 'Browser',
                      shortcut: panelBrowserShortcut
                    },
                    editor: {
                      id: 'editor',
                      icon: FileCode,
                      label: 'Editor',
                      shortcut: panelEditorShortcut
                    },
                    artifacts: {
                      id: 'artifacts',
                      icon: Paperclip,
                      label: 'Artifacts',
                      shortcut: panelArtifactsShortcut
                    },
                    diff: { id: 'diff', icon: GitBranch, label: 'Git', shortcut: panelGitShortcut },
                    processes: {
                      id: 'processes',
                      icon: Cpu,
                      label: 'Processes',
                      shortcut: panelProcessesShortcut
                    },
                    settings: {
                      id: 'settings',
                      icon: Settings2,
                      label: 'Settings',
                      shortcut: panelSettingsShortcut
                    }
                  }
                  for (const wp of enabledWebPanels) {
                    entries[wp.id] = {
                      id: wp.id,
                      icon: Globe,
                      label: wp.name,
                      shortcut: formatKeysForDisplay(webPanelShortcutKeys(wp.shortcut)) ?? undefined
                    }
                  }
                  const ordered = orderedTaskIds
                    .map((id) => entries[id])
                    .filter((e): e is NonNullable<typeof e> => !!e)
                    .filter((p) => {
                      // PERMANENT: Agent (terminal) toggle MUST NEVER appear in secondary window. User explicit.
                      if (isSecondaryWindow && p.id === 'terminal') return false
                      const isBuiltin = [
                        'terminal',
                        'browser',
                        'editor',
                        'artifacts',
                        'diff',
                        'processes',
                        'settings'
                      ].includes(p.id)
                      if (isBuiltin)
                        return (
                          isBuiltinEnabled(p.id, 'task') &&
                          !(task.is_temporary && p.id === 'settings')
                        )
                      return true // web panels already filtered by enabledWebPanels
                    })
                    .map((p) => ({ ...p, active: !!panelVisibility[p.id] }))

                  if (taskHeaderPanelMode === 'menu') {
                    const activeCount = ordered.filter((p) => p.active).length
                    return (
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label="Panels"
                                className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 hover:bg-surface-3 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                              >
                                <PanelsTopLeft className="size-4" />
                                {activeCount > 0 && (
                                  <span className="tabular-nums text-[10px] text-muted-foreground/80">
                                    {activeCount}
                                  </span>
                                )}
                              </button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Panels</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent
                          align={taskHeaderPanelAlign === 'left' ? 'start' : 'end'}
                          className="min-w-[180px]"
                        >
                          {ordered.map((p) => {
                            const Icon = p.icon
                            return (
                              <DropdownMenuItem
                                key={p.id}
                                onSelect={(e) => {
                                  e.preventDefault()
                                  handlePanelToggle(p.id, !p.active)
                                }}
                                className={cn('cursor-pointer gap-2', p.active && 'bg-accent/50')}
                              >
                                <Icon className="size-4" />
                                <span className="flex-1">{p.label}</span>
                                {p.shortcut && (
                                  <span className="text-[10px] text-muted-foreground tabular-nums">
                                    {p.shortcut}
                                  </span>
                                )}
                              </DropdownMenuItem>
                            )
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  }

                  return (
                    <PanelToggle
                      panels={ordered}
                      onChange={handlePanelToggle}
                      onReorder={handlePanelReorder}
                    />
                  )
                })()}
              </div>
            </div>
            {parentTask && (
              <button
                type="button"
                onClick={() => onNavigateToTask?.(parentTask.id)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer -mt-1"
              >
                Sub-task of
                <span className="font-medium truncate max-w-[300px]">{parentTask.title}</span>
              </button>
            )}
          </div>
        </header>
      )}

      {/* Dev server detected toast */}
      {!compact && (
        <DevServerToast
          url={detectedDevUrl}
          onOpen={() => {
            if (!detectedDevUrl) return
            openDevServerInBrowser(detectedDevUrl)
            setDetectedDevUrl(null)
          }}
          onDismiss={() => {
            setDetectedDevUrl(null)
            if (task?.id) {
              devUrlToastDismissedRef.current = true
              void updateTaskAsync({ id: task.id, devUrlToastDismissed: true }).then((updated) => {
                if (updated) onTaskUpdated(updated)
              })
            }
          }}
        />
      )}

      {/* Split view: terminal | browser | settings | git diff.
          p-4 (non-compact) = the panel area owns its 16px frame on all sides. Overflow
          clips at the padding-box edge, so the focused panel's outer glow renders into
          this padding instead of being cropped by the scroll box. One consistent rule:
          #main-area has NO padding in normal mode; the header (mt-4 mx-4), home-detail
          (p-4) and this strip (p-4) each own their own 16px frame — no gap/negative-
          margin cancellation. task-detail has no `gap-4`, so this strip's `pt-4` IS the
          header↔panel gap (and doubles as top glow room; zen mode has no header, so the
          same `pt-4` keeps the top symmetric with the sides). The dev-server toast is
          position:fixed, so it's unaffected. containerWidth comes from contentRect
          (excludes padding) → panel sizing unchanged. */}
      <TaskPageProvider value={taskPage}>
        <div
          id="task-panels"
          ref={splitContainerRef}
          className={cn('flex-1 flex min-h-0 overflow-x-auto', !compact && 'p-4')}
        >
          {isTaskCompleted && !openCompletedAnyway ? (
            <TaskCompletedScreen
              task={task}
              project={project}
              completedVariant={completedVariant}
              setCompletedVariant={setCompletedVariant}
              onCloseTab={onCloseTab}
              onShowDetails={() => setOpenCompletedAnyway(true)}
              onTaskUpdate={handleTaskUpdate}
            />
          ) : (
            <>
              {!compact && !hasVisiblePanels && (
                <div className="flex-1 flex items-center justify-center">
                  <div className="w-full max-w-xl min-h-52 rounded-lg border border-border bg-surface-3 px-5 py-7 text-center flex flex-col items-center justify-center">
                    <p className="text-2xl font-semibold">No panel tab is shown</p>
                    <p className="mt-3 text-base text-muted-foreground">
                      Use the panel tabs in the header to open one.
                    </p>
                  </div>
                </div>
              )}

              {/* Anchor gap: leftover space pushing right-aligned panels to the right edge */}
              {!compact && resolved.rightKeys.length > 0 && (
                <div
                  aria-hidden
                  data-testid="panel-gap"
                  className="shrink-0"
                  style={{ width: resolved.gapPx, order: spacerOrder }}
                />
              )}

              {/* Agent (terminal): in compact mode the whole cell */}
              {!compact && panelVisibility.terminal && renderResizeHandle('terminal')}
              {(compact || panelVisibility.terminal) && <AgentKind panelId="terminal" />}

              {/* Non-terminal panels are hidden in compact mode */}
              {renderPanel('browser')}
              {renderPanel('editor')}
              {renderPanel('artifacts')}

              {/* Web Panels (custom + predefined) */}
              {!compact &&
                enabledWebPanels.map((wp) => {
                  if (!panelVisibility[wp.id]) return null
                  return (
                    <div key={wp.id} className="contents">
                      {renderResizeHandle(wp.id)}
                      <WebKind panelId={wp.id} />
                    </div>
                  )
                })}

              {renderPanel('git')}
              {renderPanel('settings')}
              {renderPanel('processes')}
            </>
          )}
        </div>
      </TaskPageProvider>

      <LoopModeDialog
        open={loopDialogOpen}
        onOpenChange={(open) => {
          setLoopDialogOpen(open)
        }}
        config={
          task.loop_config ?? {
            prompt: '',
            criteriaType: 'contains',
            criteriaPattern: '',
            maxIterations: 50
          }
        }
        onSave={(cfg) => {
          handleLoopConfigChange(cfg)
          setLoopDialogOpen(false)
        }}
      />

      {task && duplicateDialogOpen && (
        <DuplicateTaskDialog open onOpenChange={setDuplicateDialogOpen} task={task} />
      )}

      {task && moveTargetId !== null && (
        <MoveTaskDialog
          initialMode={moveMode}
          open
          onOpenChange={(open) => {
            if (!open) setMoveTargetId(null)
          }}
          taskIds={[task.id]}
          initialProjectId={moveTargetId}
          onMoved={() => {
            trpcClient.task.get
              .query({ id: task.id })
              .then((moved) => {
                if (moved) handleTaskUpdate(moved)
              })
              .catch(() => {
                /* the board's tasks-changed refresh brings it anyway */
              })
          }}
        />
      )}

      <DeleteTaskDialog
        task={task}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onDeleted={handleDeleteConfirm}
        onDeleteTask={onDeleteTask}
      />

      <MountWhenOpened open={snoozeDialogOpen}>
        <CustomSnoozeDialog
          open={snoozeDialogOpen}
          onOpenChange={setSnoozeDialogOpen}
          onSnooze={async (until) => {
            trackTask(task.id, 'task_snoozed')
            handleTaskUpdate(await updateTaskAsync({ id: task.id, snoozedUntil: until }))
          }}
        />
      </MountWhenOpened>
      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isArchived ? 'Unarchive' : 'Archive'} Task</AlertDialogTitle>
            <AlertDialogDescription>
              {isArchived
                ? `Restore "${task?.title}" from the archive?`
                : `Archive "${task?.title}"? You can restore it later from the archive.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchive}>
              {isArchived ? 'Unarchive' : 'Archive'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={doctorDialogOpen} onOpenChange={setDoctorDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Stethoscope className="size-4 text-muted-foreground" />
              Environment check
              {task &&
                (() => {
                  const modeLabel = modes.find((m) => m.id === task.agent_id)?.label
                  return modeLabel ? (
                    <span className="text-muted-foreground font-normal text-sm">— {modeLabel}</span>
                  ) : null
                })()}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            {doctorLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="size-4 animate-spin" />
                Running checks…
              </div>
            )}
            {doctorResults?.map((r) => (
              <div
                key={r.check}
                className={cn(
                  'rounded-lg border p-3 space-y-2',
                  r.ok
                    ? 'border-green-500/20 bg-green-50/40 dark:bg-green-950/20'
                    : 'border-red-500/20 bg-red-50/40 dark:bg-red-950/20'
                )}
              >
                <div className="flex items-start gap-2">
                  {r.ok ? (
                    <CheckCircle2 className="size-4 text-green-600 dark:text-green-400 shrink-0 mt-px" />
                  ) : (
                    <XCircle className="size-4 text-red-500 dark:text-red-400 shrink-0 mt-px" />
                  )}
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium leading-none">{r.check}</p>
                    <p className="text-xs text-muted-foreground">{r.detail}</p>
                  </div>
                </div>
                {!r.ok && r.fix && (
                  <div className="ml-6">
                    <code className="text-xs bg-surface-2 dark:bg-surface-2 text-foreground dark:text-foreground rounded px-2 py-1.5 font-mono block">
                      {r.fix}
                    </code>
                  </div>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Suspense fallback={null}>
        <DescriptionDialog
          open={descriptionFullscreen}
          onOpenChange={setDescriptionFullscreen}
          value={descriptionValue}
          onChange={setDescriptionValue}
          onSave={handleDescriptionSave}
          readOnly={!canEdit}
          fontFamily={notesFontFamily}
          readability={notesReadability}
          width={notesWidth}
          checkedHighlight={notesCheckedHighlight}
          showToolbar={notesShowToolbar}
          spellcheck={notesSpellcheck}
          themeColors={notesThemeColors}
          artifacts={artifacts.map((a) => ({
            id: a.id,
            title: a.title,
            type: RENDER_MODE_INFO[getEffectiveRenderMode(a.title, a.render_mode)].label
          }))}
          onArtifactClick={(artifactId) => {
            if (!panelVisibility.artifacts) handlePanelToggle('artifacts', true)
            artifactsPanelRef.current?.selectArtifact(artifactId)
          }}
          onUploadImages={handleUploadImages}
          onOpenLink={handleDescriptionOpenLink}
        />
      </Suspense>
    </div>
  )
})
