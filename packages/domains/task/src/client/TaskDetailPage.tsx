import React, { Activity, useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react'
import {
  MoreHorizontal,
  Archive,
  Trash2,
  AlertTriangle,
  Loader2,
  Terminal as TerminalIcon,
  Globe,
  Settings2,
  GitBranch,
  FileCode,
  ChevronDown,
  ChevronRight,
  Flag,
  Plus,
  X,
  Info,
  CheckCircle2,
  XCircle,
  Stethoscope,
  Cpu,
  Circle,
  Repeat,
  LayoutTemplate,
  Paperclip,
  Power,
  PanelsTopLeft
} from 'lucide-react'
import { IconArrowsVertical, IconArrowsMaximize } from '@tabler/icons-react'
import type { ArtifactsPanelHandle } from '@slayzone/task-artifacts/client'
import { useArtifacts } from '@slayzone/task-artifacts/client'
import { useArtifactUpload } from '@slayzone/editor/hooks'
import { DndContext, PointerSensor, useSensors, useSensor, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Task, PanelVisibility, PanelSizes, UpdateTaskInput } from '@slayzone/task/shared'
import type { TaskTemplate } from '@slayzone/task/shared'
import type { TaskDetailData } from './taskDetailCache'
import {
  BUILTIN_PANEL_IDS,
  getProviderFlags,
  setProviderFlags,
  clearAllConversationIds,
  priorityOptions
} from '@slayzone/task/shared'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Project } from '@slayzone/projects/shared'
import {
  getDefaultStatus,
  getDoneStatus,
  isCompletedStatus,
  isTerminalStatus,
  resolveRepoPath
} from '@slayzone/projects/shared'
import { useDetectedRepos } from '@slayzone/projects'
import type { TerminalMode } from '@slayzone/terminal/shared'
import {
  Button,
  IconButton,
  PanelToggle,
  DevServerToast,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent
} from '@slayzone/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuRadioGroup,
  ContextMenuRadioItem
} from '@slayzone/ui'
import { DeleteTaskDialog } from './DeleteTaskDialog'
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
import { TaskMetadataSidebar, ExternalSyncCard } from './TaskMetadataSidebar'
import { TaskStatusMenu } from './TaskStatusMenu'
import {
  normalizeDescription,
  stripMarkdown,
  getExtensionFromTitle,
  getEffectiveRenderMode,
  RENDER_MODE_INFO
} from '@slayzone/task/shared'
import {
  useTheme,
  useDialogStore,
  useTabStore,
  type SearchFileContext
} from '@slayzone/settings/client'
import {
  markSkipCache,
  usePty,
  useTerminalModes,
  getVisibleModes,
  getModeLabel,
  groupTerminalModes,
  useLoopMode,
  isLoopActive,
  stripAnsi,
  serializeTerminalHistory,
  LoopModeBanner,
  LoopModeDialog,
  SlayNudgeBanner,
  useSlayNudge,
  PtyStateDot
} from '@slayzone/terminal'
import type { LoopConfig } from '@slayzone/terminal/shared'
import {
  TerminalContainer,
  type TerminalContainerHandle,
  MODE_ICONS
} from '@slayzone/task-terminals'
import { useProjectRepos } from '@slayzone/worktrees/hooks'
import type { UnifiedGitPanelHandle, GitTabId } from '@slayzone/worktrees'
import {
  buildStatusOptions,
  cn,
  getColumnStatusStyle,
  PriorityIcon,
  useAppearance,
  matchesShortcut,
  useShortcutStore,
  useShortcutDisplay,
  withModalGuard,
  getThemeEditorColors,
  type EditorThemeColors
} from '@slayzone/ui'
import type { BrowserPanelHandle } from '@slayzone/task-browser'
import type { FileEditorViewHandle } from '@slayzone/file-editor/client'
import type { OpenFileOptions } from '@slayzone/file-editor/shared'
import { track } from '@slayzone/telemetry/client'
import {
  usePanelSizes,
  resolvePanels,
  planPanelStrip,
  effectiveLayout,
  minWidthFor,
  applyBoundaryResize
} from './usePanelSizes'
import { usePanelConfig } from './usePanelConfig'
import { useSubTasks } from './useSubTasks'
import { usePanelOwnership } from './usePanelOwnership'
import { PanelOwnerStub } from './PanelOwnerStub'
import { SquareArrowOutUpRight } from 'lucide-react'
import { useTaskTagIds } from './useTaskTagIds'
import { WebPanelView } from './WebPanelView'
import { ResizeHandle } from './ResizeHandle'
import { ProcessesPanel } from './ProcessesPanel'
import { TaskSettingsPanel } from './TaskSettingsPanel'
import { PanelLoadingSkeleton } from './PanelLoadingSkeleton'
import { useSharedCardHeights } from './useSharedCardHeights'
import {
  SortableSubTask,
  ArtifactsPanel,
  DescriptionDialog,
  RichTextEditor,
  UnifiedGitPanel,
  BrowserPanel,
  FileEditorView,
  useTaskTemplates,
  useTaskDoctor,
  useTaskTitleEditing,
  usePersistenceSaves,
  useDevServerDetection,
  useTaskTerminalSession,
  TaskCompletedScreen
} from './task-detail'

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
  // Prefer live global state; fall back to suspense-cached data for subtask race window
  const task = taskProp ?? initialData?.task ?? null
  const project = projectProp ?? initialData?.project ?? null

  // Owns keyboard shortcuts; falls back to isActive so non-explode callers need not set it.
  const shortcutActive = hasShortcutFocus ?? isActive

  const { modes } = useTerminalModes()

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
    initialData?.taskTagIds
  )
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
  const { artifacts } = useArtifacts(task?.id)
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

  // Project path validation
  const [projectPathMissing, setProjectPathMissing] = useState(
    initialData?.projectPathMissing ?? false
  )

  // Multi-repo detection (drives the *task-bound* axis: terminal cwd, editor root, browser, worktree creation)
  const detectedRepos = useDetectedRepos(project?.path ?? null)
  // Task-bound repo name: only what the user has explicitly bound to this task or to the project default.
  // Intentionally NO fallback to first-detected — wrapper folder stays wrapper folder for the bound axis,
  // so the terminal/editor don't silently jump into an arbitrary child repo.
  const effectiveRepoName = task?.repo_name ?? project?.selected_repo ?? null
  const resolvedRepo = useMemo(
    () => resolveRepoPath(project?.path ?? null, detectedRepos, effectiveRepoName),
    [project?.path, detectedRepos, effectiveRepoName]
  )
  // Effective repo path (worktree > resolved child repo > project path) — drives terminal/editor/browser/worktree.
  const effectiveRepoPath = task?.worktree_path ?? task?.base_dir ?? resolvedRepo.path

  // Git-panel viewing axis: ephemeral, repo selection here does NOT change the task-bound path.
  // Default = task-bound; if that resolves to a non-git wrapper folder, default to first discovered repo.
  const taskBoundRepoForView = task?.worktree_path ?? resolvedRepo.path // worktree if present, else resolved child / project root
  const { repos: viewableRepos } = useProjectRepos(project?.path ?? null, taskBoundRepoForView)
  const [gitViewRepoPath, setGitViewRepoPath] = useState<string | null>(null)
  // Resolve the active git-panel target. Prefer explicit user pick; fall back to task-bound if it's a real git repo;
  // else first viewable repo (covers wrapper-folder projects). Recomputed on each render so disk changes self-heal.
  const resolvedGitViewPath = useMemo(() => {
    if (gitViewRepoPath && viewableRepos.some((r) => r.path === gitViewRepoPath))
      return gitViewRepoPath
    if (taskBoundRepoForView && viewableRepos.some((r) => r.path === taskBoundRepoForView))
      return taskBoundRepoForView
    return viewableRepos[0]?.path ?? taskBoundRepoForView
  }, [gitViewRepoPath, viewableRepos, taskBoundRepoForView])
  const handleRepoChange = useCallback(
    (repoName: string) => {
      // Ephemeral: pick by name from discovered repos. Does NOT persist to task.repo_name.
      const match = viewableRepos.find((r) => r.name === repoName)
      if (match) setGitViewRepoPath(match.path)
    },
    [viewableRepos]
  )

  // PTY context for buffer management
  const {
    resetTaskState,
    subscribeSessionDetected,
    subscribeDevServer,
    getQuickRunPrompt,
    clearQuickRunPrompt
  } = usePty()

  // Shortcut display strings (reactive to user customization)
  const panelTerminalShortcut = useShortcutDisplay('panel-terminal')
  const panelBrowserShortcut = useShortcutDisplay('panel-browser')
  const panelEditorShortcut = useShortcutDisplay('panel-editor')
  const panelGitShortcut = useShortcutDisplay('panel-git')
  const panelProcessesShortcut = useShortcutDisplay('panel-processes')
  const panelSettingsShortcut = useShortcutDisplay('panel-settings')
  const panelArtifactsShortcut = useShortcutDisplay('panel-artifacts')

  const terminalInjectTitleShortcut = useShortcutDisplay('terminal-inject-title')
  const terminalInjectDescShortcut = useShortcutDisplay('terminal-inject-desc')
  const terminalRestartShortcut = useShortcutDisplay('terminal-restart')
  const syncSessionIdShortcut = useShortcutDisplay('sync-session-id')

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
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)

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
  useSharedCardHeights(settingsCardsGridRef, [
    descriptionExpanded,
    descriptionOpen,
    subTasksOpen,
    artifactsOpen,
    detailsOpen
  ])

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
      void window.api.panels.releaseAllForTask(releasingTaskId)
    }
  }, [isSecondaryWindow, task?.id])

  // Panel ownership across windows (multi-window support)
  const ownership = usePanelOwnership(task?.id)

  // Track open secondary task windows so primary hides Detach when secondary exists
  const [openTaskWindowIds, setOpenTaskWindowIds] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    window.api.taskWindow.list().then((ids) => {
      if (alive) setOpenTaskWindowIds(ids)
    })
    const unsub = window.api.taskWindow.onListChanged((ids) => setOpenTaskWindowIds(ids))
    return () => {
      alive = false
      unsub()
    }
  }, [])
  const hasOpenSecondary = !!task && openTaskWindowIds.includes(task.id)

  // Sync description from global state when changed externally
  useEffect(() => {
    if (task) {
      setDescriptionValue(normalizeDescription(task.description, task.description_format))
      descriptionDirty.current = false
    }
  }, [task?.description, task?.description_format])

  // Browser tabs state
  const defaultBrowserTabs: BrowserTabsState = {
    tabs: [{ id: 'default', url: 'about:blank', title: 'New Tab' }],
    activeTabId: 'default'
  }
  const [browserTabs, setBrowserTabs] = useState<BrowserTabsState>(
    initialData?.browserTabs ?? defaultBrowserTabs
  )

  // Global panel configuration (which panels are enabled, custom web panels)
  const { config: panelConfig, updateConfig: updatePanelConfig, enabledWebPanels, isBuiltinEnabled, getOrderedTaskIds } =
    usePanelConfig()
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
      const order = panelConfig.order ?? []
      const toOrderId = (taskId: string): string => (taskId === 'diff' ? 'git' : taskId)
      const reorderedOrderIds = reorderedTaskIds.map(toOrderId)
      const visibleSet = new Set(reorderedOrderIds)
      let vi = 0
      const next = order.map((id) =>
        visibleSet.has(id) ? (reorderedOrderIds[vi++] ?? id) : id
      )
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
  useEffect(() => {
    return window.api.panels.onCloseRequest((payload) => {
      if (!task || payload.taskId !== task.id) return
      setPanelVisibility((prev) =>
        prev[payload.panelId] ? { ...prev, [payload.panelId]: false } : prev
      )
    })
  }, [task?.id])

  // Panel sizes for resizable panels — per-task, persisted to the DB (mirrors
  // panel_visibility). Secondary windows keep sizes local (no DB write).
  const persistPanelSizes = useCallback(
    (sizes: PanelSizes) => {
      if (!task || isSecondaryWindow) return
      void window.api.db.updateTask({ id: task.id, panelSizes: sizes }).then((updated) => {
        if (updated) onTaskUpdated(updated)
      })
    },
    [task?.id, isSecondaryWindow, onTaskUpdated] // eslint-disable-line react-hooks/exhaustive-deps
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
            applyBoundaryResize(leftL, rightL, leftId, panelId, lw, rw, containerWidth)
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
  const [loopModeAvailable, setLoopModeAvailable] = useState(false)
  const [loopDialogOpen, setLoopDialogOpen] = useState(false)
  const loopConfigured =
    task?.loop_config != null &&
    !!(task.loop_config.prompt.trim() && task.loop_config.criteriaPattern.trim())
  useEffect(() => {
    window.api.app.isLoopModeEnabled().then(setLoopModeAvailable)
  }, [])
  const mainSessionId = task ? getMainSessionId(task.id) : ''
  const handleLoopConfigChange = useCallback(
    (cfg: LoopConfig | null) => {
      if (!task) return
      window.api.db.updateTask({ id: task.id, loopConfig: cfg }).then((updated) => {
        if (updated) onTaskUpdated(updated)
      })
    },
    [task?.id, onTaskUpdated]
  )
  const {
    status: loopStatus,
    iteration: loopIteration,
    startLoop,
    pauseLoop,
    resumeLoop,
    stopLoop
  } = useLoopMode({
    sessionId: mainSessionId,
    onConfigChange: handleLoopConfigChange
  })

  const {
    showBanner: showSlayNudge,
    dismiss: dismissSlayNudge,
    recheck: recheckSlayNudge
  } = useSlayNudge({
    projectId: task?.project_id ?? null,
    projectPath: effectiveRepoPath ?? project?.path ?? null
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
    if (task?.id) void window.api.db.updateTask({ id: task.id, gitActiveTab: tab })
  }
  const fileEditorRef = useRef<FileEditorViewHandle>(null)
  const terminalContainerRef = useRef<TerminalContainerHandle>(null)
  const browserPanelRef = useRef<BrowserPanelHandle>(null)
  const artifactsPanelRef = useRef<ArtifactsPanelHandle>(null)
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
  // Re-check project path on window focus
  useEffect(() => {
    if (!project?.path) return

    const checkProjectPathExists = async (path: string): Promise<boolean> => {
      const pathExists = window.api.files?.pathExists
      if (typeof pathExists === 'function') return pathExists(path)
      console.warn('window.api.files.pathExists is unavailable; skipping path validation')
      return true
    }

    const handleFocus = (): void => {
      checkProjectPathExists(project.path!).then((exists) => setProjectPathMissing(!exists))
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [project?.path])

  // Check project path exists when project changes
  useEffect(() => {
    if (!project?.path) {
      setProjectPathMissing(false)
      return
    }
    const pathExists = window.api.files?.pathExists
    if (typeof pathExists !== 'function') return
    let cancelled = false
    pathExists(project.path).then((exists) => {
      if (!cancelled) setProjectPathMissing(!exists)
    })
    return () => {
      cancelled = true
    }
  }, [project?.path])

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
  const {
    sessionIdCommand,
    showSessionBanner,
    showUnavailableBanner,
    detectedSessionId,
    setSessionUnavailableDismissed,
    handleDetectSessionId,
    getConversationIdForMode,
    handleUpdateSessionId,
    handleRestartTerminal,
    handleStopAgent,
    handleResetTerminal,
    handleReattachTerminal
  } = useTaskTerminalSession({
    task,
    onTaskUpdated,
    shortcutActive,
    getMainSessionId,
    resetTaskState,
    subscribeSessionDetected,
    setTerminalKey
  })

  // Inject task title into terminal (no execute)
  const handleInjectTitle = useCallback(async () => {
    if (!task || !terminalApiRef.current) return
    await terminalApiRef.current.sendInput(task.title)
  }, [task])

  // Screenshot: capture browser view and inject path into terminal
  const handleScreenshot = useCallback(async (viewId: string) => {
    const result = await window.api.screenshot.captureView(viewId)
    if (!result.success || !result.path) return
    track('screenshot_captured')
    const escaped = result.path.includes(' ') ? `"${result.path}"` : result.path
    await terminalApiRef.current?.write(escaped)
  }, [])

  const handleInsertElementSnippet = useCallback(
    async (snippet: string) => {
      if (!task) return
      const text = snippet.trim()
      if (!text) return
      const mainSessionId = `${task.id}:${task.id}`
      await window.api.pty.write(mainSessionId, text)
    },
    [task]
  )

  // Inject task description into terminal (no execute)
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
    const isTerminalFocused = (): boolean => {
      const active = document.activeElement as HTMLElement | null
      if (!active) return false
      if (active.classList.contains('xterm-helper-textarea')) return true
      return !!active.closest('.xterm')
    }

    const handleKeyDown = withModalGuard((e: KeyboardEvent): void => {
      if (!shortcutActive) return
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

  // Cmd+Shift+S screenshot trigger from main process
  useEffect(() => {
    if (!shortcutActive) return
    return window.api.app.onScreenshotTrigger(() => {
      const viewId = browserPanelRef.current?.getActiveViewId()
      if (viewId) void handleScreenshot(viewId)
    })
  }, [shortcutActive, handleScreenshot])

  // Keep a ref so the onCloseCurrent handler always sees current browserTabs without re-subscribing
  const browserTabsRef = useRef(browserTabs)
  useEffect(() => {
    browserTabsRef.current = browserTabs
  }, [browserTabs])

  // Track last-focused sub-panel via focusin (macOS native menu accelerators clear activeElement by callback time)
  const lastFocusedPanelRef = useRef<'terminal' | 'editor' | 'browser' | null>(null)
  const [focusedPanel, setFocusedPanel] = useState<string | null>(null)
  const onCloseTabRef = useRef(onCloseTab)
  onCloseTabRef.current = onCloseTab
  const handlePanelToggleRef = useRef<typeof handlePanelToggle>(null!)
  useEffect(() => {
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
    window.addEventListener('focusin', handleFocusIn)
    window.addEventListener('focusout', handleFocusOut)
    return () => {
      window.removeEventListener('focusin', handleFocusIn)
      window.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  // Cmd+W: close focused sub-item (terminal group, browser tab, editor file),
  // or fall through to close the task tab if nothing to close
  useEffect(() => {
    if (!shortcutActive) return
    return window.api.app.onCloseCurrent(async () => {
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
          handlePanelToggleRef.current('browser', false)
          return
        }
      }
      // Nothing was closed — close the task tab
      onCloseTabRef.current?.(taskId)
    })
  }, [shortcutActive, setBrowserTabs])

  // Cmd+R browser reload is handled globally in App.tsx

  // Clear quick run prompt after it's been passed to Terminal
  useEffect(() => {
    if (!task) return
    // Small delay to ensure Terminal has read the prompt
    const timer = setTimeout(() => {
      clearQuickRunPrompt(task.id)
    }, 500)
    return () => clearTimeout(timer)
  }, [task?.id, clearQuickRunPrompt])

  // Handle terminal mode change
  const handleModeChange = useCallback(
    async (mode: TerminalMode) => {
      if (!task) return
      const oldMode = task.terminal_mode
      // Main tab session ID format: ${taskId}:${taskId}
      const mainSessionId = `${task.id}:${task.id}`
      // Reset state FIRST to ignore any in-flight data
      resetTaskState(mainSessionId)
      // Now kill the PTY (any data it sends will be ignored)
      await window.api.pty.kill(mainSessionId)
      // Small delay to let any remaining PTY data be processed and ignored
      await new Promise((r) => setTimeout(r, 100))
      // Update mode and clear all conversation IDs (fresh start)
      const updated = await window.api.db.updateTask({
        id: task.id,
        terminalMode: mode,
        providerConfig: clearAllConversationIds(task.provider_config)
      })
      if (!updated) return
      onTaskUpdated(updated)
      // Remount terminal (mark skip to prevent cleanup from re-caching old content)
      markSkipCache(mainSessionId)
      setTerminalKey((k) => k + 1)
      track('terminal_mode_switched', { from: oldMode, to: mode })
    },
    [task, onTaskUpdated, resetTaskState]
  )

  const getMainHistory = useCallback(() => {
    if (!task) return ''
    const raw = serializeTerminalHistory(`${task.id}:${task.id}`)
    return stripAnsi(raw)
  }, [task])

  const handleCopyHistory = useCallback(() => {
    const history = getMainHistory()
    if (history) void navigator.clipboard.writeText(history)
  }, [getMainHistory])

  const handleCopyConversationId = useCallback(() => {
    if (!task) return
    const id = getConversationIdForMode(task)
    if (id) void navigator.clipboard.writeText(id)
  }, [task, getConversationIdForMode])

  const getProviderFlagsForMode = useCallback((currentTask: Task): string => {
    return getProviderFlags(currentTask.provider_config, currentTask.terminal_mode)
  }, [])

  const handleFlagsSave = useCallback(
    async (nextValue: string) => {
      if (!task) return
      const currentValue = getProviderFlagsForMode(task)
      if (currentValue === nextValue) return

      const update = {
        id: task.id,
        providerConfig: setProviderFlags(task.provider_config, task.terminal_mode, nextValue)
      }

      const updated = await window.api.db.updateTask(update)
      onTaskUpdated(updated)

      const mainSessionId = `${task.id}:${task.id}`
      resetTaskState(mainSessionId)
      await window.api.pty.kill(mainSessionId)
      await new Promise((r) => setTimeout(r, 100))
      markSkipCache(mainSessionId)
      setTerminalKey((k) => k + 1)
    },
    [task, getProviderFlagsForMode, onTaskUpdated, resetTaskState]
  )

  const handleSetDefaultFlags = useCallback(async () => {
    if (!task || task.terminal_mode === 'terminal') return
    const modeInfo = modes.find((m) => m.id === task.terminal_mode)
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
      const updated = await window.api.db.updateTask({
        id: task.id,
        panelVisibility: newVisibility
      })
      onTaskUpdated(updated)
    },
    [task, panelVisibility, onTaskUpdated, resetPanelSize, ownership, isSecondaryWindow]
  )
  handlePanelToggleRef.current = handlePanelToggle

  const openArtifactRef = useRef<(taskId: string, artifactId: string) => void>(() => {})
  openArtifactRef.current = (targetTaskId, artifactId) => {
    if (!task || targetTaskId !== task.id) return
    if (!panelVisibility.artifacts) handlePanelToggle('artifacts', true)
    artifactsPanelRef.current?.selectArtifact(artifactId)
  }
  useEffect(
    () => window.api.app.onOpenArtifact((tid, aid) => openArtifactRef.current(tid, aid)),
    []
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
    if (!effectiveRepoPath) return undefined
    return {
      projectPath: effectiveRepoPath,
      openFile: (filePath: string) => handleQuickOpenFile(filePath)
    }
  }, [effectiveRepoPath, handleQuickOpenFile])

  // Cmd+T/B/G/S/E/P + web panel shortcuts for panel toggles
  useEffect(() => {
    const handleKeyDown = withModalGuard((e: KeyboardEvent): void => {
      if (!shortcutActive) return
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
        if (!panelVisibility.diff) {
          setGitDefaultTab('changes')
          handlePanelToggle('diff', true)
        } else if (gitPanelRef.current?.getActiveTab() === 'changes') {
          handlePanelToggle('diff', false)
        } else {
          gitPanelRef.current?.switchToTab('changes')
        }
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
        if (!panelVisibility.diff) {
          setGitDefaultTab('general')
          handlePanelToggle('diff', true)
        } else if (gitPanelRef.current?.getActiveTab() === 'general') {
          handlePanelToggle('diff', false)
        } else {
          gitPanelRef.current?.switchToTab('general')
        }
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
      } else {
        // Web panel shortcuts (not in registry — dynamic per-project config)
        for (const wp of enabledWebPanels) {
          if (wp.shortcut && e.key === wp.shortcut) {
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
    buildTaskFileContext
  ])

  const handleDescriptionSave = async (): Promise<void> => {
    if (!task || !descriptionDirty.current) return
    descriptionDirty.current = false

    const updated = await window.api.db.updateTask({
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

  const subTaskSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  const handleTaskUpdate = (updated: Task): void => {
    setTitleValue(updated.title)
    setDescriptionValue(updated.description ?? '')
    onTaskUpdated(updated)
  }

  const applyTemplate = useCallback(
    async (template: TaskTemplate) => {
      if (!task) return
      const updates: UpdateTaskInput = { id: task.id }
      if (template.terminal_mode) updates.terminalMode = template.terminal_mode
      if (template.provider_config) updates.providerConfig = template.provider_config
      if (template.panel_visibility) updates.panelVisibility = template.panel_visibility
      if (template.browser_tabs) updates.browserTabs = template.browser_tabs
      if (template.web_panel_urls) updates.webPanelUrls = template.web_panel_urls

      const modeChanged = template.terminal_mode && template.terminal_mode !== task.terminal_mode
      if (modeChanged) {
        const mainSessionId = getMainSessionId(task.id)
        resetTaskState(mainSessionId)
        await window.api.pty.kill(mainSessionId)
        markSkipCache(mainSessionId)
      }

      const updated = await window.api.db.updateTask(updates)
      handleTaskUpdate(updated)

      if (template.panel_visibility) setPanelVisibility(template.panel_visibility)
      if (template.browser_tabs) setBrowserTabs(template.browser_tabs)
      if (template.web_panel_urls) webPanelUrlsRef.current = { ...template.web_panel_urls }

      if (modeChanged) {
        setTerminalKey((k) => k + 1)
      }
    },
    [task, getMainSessionId, resetTaskState]
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
    const oldEffective = task?.worktree_path ?? task?.base_dir ?? resolvedRepo.path
    const newWorktree = data.worktreePath !== undefined ? data.worktreePath : task?.worktree_path
    const newBaseDir = data.baseDir !== undefined ? data.baseDir : task?.base_dir
    const newEffective = newWorktree ?? newBaseDir ?? resolvedRepo.path
    const cwdChanged = oldEffective !== newEffective

    if (cwdChanged) {
      const mainSessionId = `${data.id}:${data.id}`
      resetTaskState(mainSessionId)
      await window.api.pty.kill(mainSessionId)
      markSkipCache(mainSessionId)
    }

    const updated = await window.api.db.updateTask(data)
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
      await window.api.db.updateTask({
        id: task.id,
        browserTabs: tabs
      })
    },
    [task]
  )

  // Debounced persistence of web-panel URLs, editor open-files, and active artifact id
  const {
    webPanelUrlsRef,
    handleActiveArtifactIdChange,
    handleWebPanelUrlChange,
    handleEditorStateChange,
    handleWebPanelFaviconChange
  } = usePersistenceSaves(task)

  // Open a dev server URL in the browser panel (used by both auto-open and toast)
  const openDevServerInBrowser = useCallback(
    (url: string) => {
      handlePanelToggle('browser', true)
      const newTab = { id: `tab-${crypto.randomUUID().slice(0, 8)}`, url, title: url }
      if (browserOpenRef.current) {
        handleBrowserTabsChange({ tabs: [...browserTabs.tabs, newTab], activeTabId: newTab.id })
      } else {
        handleBrowserTabsChange({ tabs: [newTab], activeTabId: newTab.id })
      }
    },
    [handlePanelToggle, handleBrowserTabsChange, browserTabs]
  )

  useEffect(() => {
    devServerAutoOpenCallbackRef.current = openDevServerInBrowser
  }, [openDevServerInBrowser])

  // CLI: open browser panel when requested by main process (slay tasks browser --panel=visible)
  useEffect(() => {
    if (!task) return
    return window.api.app.onBrowserEnsurePanelOpen((taskId, url, tabId) => {
      if (taskId !== task.id) return
      if (tabId) {
        // CLI targeted an existing tab — open panel and switch to that tab.
        // The navigate route will load `url` into the targeted tab's webContents.
        handlePanelToggle('browser', true)
        const tabs = browserTabsRef.current
        if (tabs.tabs.some((t) => t.id === tabId) && tabs.activeTabId !== tabId) {
          handleBrowserTabsChange({ ...tabs, activeTabId: tabId })
        }
      } else if (url) {
        openDevServerInBrowser(url)
      } else {
        handlePanelToggle('browser', true)
      }
    })
  }, [task?.id, openDevServerInBrowser, handlePanelToggle, handleBrowserTabsChange])

  // CLI: create a new browser tab with a server-supplied tabId (slay tasks browser new)
  useEffect(() => {
    if (!task) return
    return window.api.app.onBrowserCreateTab(({ taskId, tabId, url, background }) => {
      if (taskId !== task.id) return
      handlePanelToggle('browser', true)
      const tabUrl = url ?? 'about:blank'
      const newTab = {
        id: tabId,
        url: tabUrl,
        title: tabUrl === 'about:blank' ? 'New Tab' : tabUrl
      }
      const current = browserTabsRef.current
      if (current.tabs.some((t) => t.id === tabId)) return
      const nextActive = background && current.tabs.length > 0 ? current.activeTabId : tabId
      handleBrowserTabsChange({ tabs: [...current.tabs, newTab], activeTabId: nextActive })
    })
  }, [task?.id, handlePanelToggle, handleBrowserTabsChange])

  const handleTagsChange = (newTagIds: string[]): void => {
    setTaskTagIds(newTagIds)
  }

  const isArchived = !!task?.archived_at

  const handleUnarchive = async (): Promise<void> => {
    if (!task) return
    const restored = await window.api.db.unarchiveTask(task.id)
    handleTaskUpdate(restored)
  }

  const handleArchive = async (): Promise<void> => {
    if (!task) return
    if (onArchiveTask) {
      await onArchiveTask(task.id)
    } else {
      await window.api.db.archiveTask(task.id)
    }
    handleTaskUpdate({ ...task, archived_at: new Date().toISOString() })
    setArchiveDialogOpen(false)
  }

  const handleDeleteConfirm = (): void => {
    setDeleteDialogOpen(false)
  }

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

  return (
    <div id="task-detail" className={cn('h-full flex flex-col', compact && 'p-0')}>
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
                            const updated = await window.api.db.updateTask({
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
          <span className="text-xs font-medium truncate flex-1">
            {task.is_temporary ? 'Temporary task' : task.title}
          </span>
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
                      const updated = await window.api.db.updateTask({
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
            {task.terminal_mode}
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
                        <TooltipContent>Auto-deletes on terminal exit or tab close</TooltipContent>
                      </Tooltip>
                      <span className="text-2xl italic text-muted-foreground">Temporary task</span>
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
                        Turn into task
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
                  <TaskStatusMenu
                    task={task}
                    project={project}
                    statusOptions={statusOptions}
                    onTaskUpdate={handleTaskUpdate}
                  />
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
                      onClick={() => setEditingTitle(true)}
                      readOnly={!editingTitle}
                      className={cn(
                        'col-start-1 row-start-1 text-2xl font-bold bg-transparent border-none outline-none w-full',
                        !editingTitle && 'cursor-pointer'
                      )}
                    />
                  </div>
                </div>
              )}

              {task.linear_url && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault()
                        window.api.shell.openExternal(task.linear_url!)
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
                            if (isSecondaryWindow) window.api.window.close()
                            else window.api.taskWindow.open(task.id)
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
                        if (isSecondaryWindow) window.api.window.close()
                        else window.api.taskWindow.open(task.id)
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
                      shortcut: wp.shortcut ? `⌘${wp.shortcut.toUpperCase()}` : undefined
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
              void window.api.db.updateTask({ id: task.id, devUrlToastDismissed: true })
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

            {/* Resize handle before Terminal */}
            {!compact && panelVisibility.terminal && renderResizeHandle('terminal')}

            {/* Terminal Panel */}
            {(compact || panelVisibility.terminal) && (
              <div
                data-panel-id="terminal"
                className={cn(
                  'min-w-0 shrink-0 overflow-hidden flex flex-col transition-shadow duration-200',
                  !compact && 'rounded-md bg-surface-1 border border-border',
                  !compact &&
                    multipleVisiblePanels &&
                    focusedPanel === 'terminal' &&
                    'shadow-[0_0_18px_rgba(255,255,255,0.25)]'
                )}
                style={
                  compact
                    ? { flex: 1 }
                    : containerWidth > 0
                      ? { width: resolvedWidths.terminal, order: panelOrderIdx.terminal ?? 0 }
                      : { flex: 1, order: panelOrderIdx.terminal ?? 0 }
                }
              >
                {ownership.hasOtherOwner('terminal') ? (
                  <PanelOwnerStub
                    panelLabel="Agent"
                    icon={TerminalIcon}
                    activeElsewhere
                    onActivate={() => ownership.claim('terminal')}
                    onActivateAndClose={() => ownership.claimAndCloseOther('terminal')}
                  />
                ) : (
                  <>
                    {projectPathMissing && project?.path && (
                      <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                        <span className="text-sm text-amber-500">
                          Project path not found:{' '}
                          <code className="bg-amber-500/10 px-1 rounded">{project.path}</code>
                        </span>
                      </div>
                    )}
                    {(() => {
                      const currentConversationId = getConversationIdForMode(task)
                      return (
                        detectedSessionId &&
                        currentConversationId &&
                        detectedSessionId !== currentConversationId
                      )
                    })() && (
                      <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                        <span className="text-sm text-amber-500">
                          Session mismatch: terminal using {detectedSessionId}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto h-6 text-xs"
                          onClick={handleUpdateSessionId}
                        >
                          Update DB
                          <kbd className="ml-2 opacity-70" style={{ fontFamily: 'system-ui' }}>
                            {syncSessionIdShortcut}
                          </kbd>
                        </Button>
                      </div>
                    )}
                    {showSessionBanner && (
                      <div className="shrink-0 bg-blue-500/10 border-b border-blue-500/20 px-4 py-1.5 flex items-center gap-2">
                        <TerminalIcon className="h-3.5 w-3.5 text-blue-500" />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-xs text-blue-500 cursor-default">
                              Session not saved — resume won't work until detected
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-72">
                            The AI provider's session ID hasn't been captured yet. Without it,
                            closing and reopening this task will start a fresh conversation instead
                            of resuming. Click "Run {sessionIdCommand}" to detect it automatically.
                          </TooltipContent>
                        </Tooltip>
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto h-6 text-xs"
                          onClick={handleDetectSessionId}
                        >
                          Run {sessionIdCommand}
                        </Button>
                      </div>
                    )}
                    {showUnavailableBanner && (
                      <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-1.5 flex items-center gap-2">
                        <Info className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        <span className="text-xs text-amber-500">
                          Session ID detection not available for this provider — don't close the tab
                          or resume won't work. Providers with resume: Claude Code, Codex, Gemini,
                          Qwen, Copilot
                        </span>
                        <button
                          className="ml-auto text-amber-500 hover:text-amber-400 shrink-0"
                          onClick={() => setSessionUnavailableDismissed(task?.id ?? null)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                    {showSlayNudge && (
                      <SlayNudgeBanner
                        projectPath={effectiveRepoPath ?? project?.path ?? ''}
                        projectId={task?.project_id ?? project?.id}
                        onDismiss={dismissSlayNudge}
                        onSetupComplete={recheckSlayNudge}
                      />
                    )}
                    {/* Terminal + mode bar wrapper */}
                    <div className="relative flex-1 min-h-0 overflow-hidden">
                      {(effectiveRepoPath || project?.path) && !projectPathMissing ? (
                        <TerminalContainer
                          ref={terminalContainerRef}
                          paused={isResizing}
                          key={`${terminalKey}-${task.project_id}-${effectiveRepoPath || ''}-${task.worktree_path || ''}-${task.base_dir || ''}`}
                          taskId={task.id}
                          isTemporary={task.is_temporary}
                          isActive={isActive}
                          hasShortcutFocus={shortcutActive}
                          cwd={effectiveRepoPath || project?.path || ''}
                          defaultMode={task.terminal_mode}
                          conversationId={getConversationIdForMode(task) || undefined}
                          existingConversationId={getConversationIdForMode(task) || undefined}
                          supportsSessionId={
                            modes
                              .find((m) => m.id === task.terminal_mode)
                              ?.initialCommand?.includes('{id}') ?? false
                          }
                          initialPrompt={getQuickRunPrompt(task.id)}
                          providerFlags={getProviderFlagsForMode(task)}
                          executionContext={project?.execution_context}
                          focusRequestId={terminalFocusRequestId}
                          onStartFresh={handleResetTerminal}
                          onReady={handleTerminalReady}
                          onRetry={handleRestartTerminal}
                          onFocusRequestHandled={handleTerminalFocusRequestHandled}
                          onMainTabActiveChange={setIsMainTabActive}
                          onOpenUrl={openDevServerInBrowser}
                          onOpenFile={handleQuickOpenFile}
                          onMainReset={handleResetTerminal}
                          overlay={
                            isActive && loopConfigured ? (
                              <LoopModeBanner
                                config={task.loop_config!}
                                status={loopStatus}
                                iteration={loopIteration}
                                onStart={startLoop}
                                onPause={pauseLoop}
                                onResume={resumeLoop}
                                onStop={stopLoop}
                                onEditConfig={() => setLoopDialogOpen(true)}
                              />
                            ) : undefined
                          }
                          mainTabContextMenu={
                            <>
                              <ContextMenuRadioGroup
                                value={task.terminal_mode}
                                onValueChange={(value) => {
                                  if (modes.some((m) => m.id === value))
                                    handleModeChange(value as TerminalMode)
                                }}
                              >
                                {(() => {
                                  const visibleModes = getVisibleModes(modes, task.terminal_mode)
                                  const { builtin, custom } = groupTerminalModes(visibleModes)
                                  const renderItem = (mode: (typeof visibleModes)[number]) => {
                                    const ModeIcon =
                                      MODE_ICONS[mode.id as TerminalMode] ?? TerminalIcon
                                    return (
                                      <ContextMenuRadioItem key={mode.id} value={mode.id}>
                                        <span className="flex items-center gap-2">
                                          <ModeIcon className="size-3.5" />
                                          {getModeLabel(mode)}
                                        </span>
                                      </ContextMenuRadioItem>
                                    )
                                  }
                                  return (
                                    <>
                                      {builtin.map(renderItem)}
                                      {custom.map(renderItem)}
                                    </>
                                  )
                                })()}
                              </ContextMenuRadioGroup>
                              <ContextMenuSeparator />
                              <ContextMenuItem onSelect={() => setFlagsPopoverOpen(true)}>
                                <span className="flex items-center gap-2">
                                  <Flag className="size-3.5" />
                                  Edit flags
                                </span>
                              </ContextMenuItem>
                            </>
                          }
                          mainTabAccessories={
                            <div
                              data-testid="terminal-mode-trigger"
                              className="flex items-center gap-1"
                              onDoubleClick={(e) => e.stopPropagation()}
                            >
                              <span className="truncate text-sm">
                                {getModeLabel(
                                  modes.find((m) => m.id === task.terminal_mode) ?? {
                                    id: task.terminal_mode,
                                    label: task.terminal_mode
                                  }
                                )}
                              </span>
                              <ChevronDown
                                data-testid="terminal-mode-dropdown"
                                aria-label="Open provider menu"
                                role="button"
                                className="size-3 cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  const tab = (e.currentTarget as unknown as HTMLElement).closest(
                                    '[data-tab-main="true"]'
                                  )
                                  if (!tab) return
                                  const rect = (
                                    e.currentTarget as unknown as HTMLElement
                                  ).getBoundingClientRect()
                                  tab.dispatchEvent(
                                    new MouseEvent('contextmenu', {
                                      bubbles: true,
                                      cancelable: true,
                                      view: window,
                                      clientX: rect.left,
                                      clientY: rect.bottom
                                    })
                                  )
                                }}
                              />
                            </div>
                          }
                          rightContent={
                            <Tooltip
                              open={!isMainTabActive && !task.is_temporary ? undefined : false}
                            >
                              <TooltipTrigger asChild>
                                <div
                                  className={cn(
                                    'flex items-center gap-2 transition-opacity',
                                    !isMainTabActive &&
                                      !task.is_temporary &&
                                      'opacity-40 pointer-events-none'
                                  )}
                                >
                                  {loopModeAvailable && task.terminal_mode !== 'terminal' && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <IconButton
                                          variant={loopConfigured ? 'default' : 'ghost'}
                                          className="size-7"
                                          aria-label="Loop command"
                                          onClick={() => {
                                            if (isLoopActive(loopStatus)) stopLoop()
                                            if (loopConfigured) {
                                              handleLoopConfigChange(null)
                                            } else {
                                              setLoopDialogOpen(true)
                                            }
                                          }}
                                        >
                                          <Repeat className="size-3.5" />
                                        </IconButton>
                                      </TooltipTrigger>
                                      <TooltipContent side="bottom">Loop command</TooltipContent>
                                    </Tooltip>
                                  )}

                                  {task.terminal_mode !== 'terminal' && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <IconButton
                                          data-testid="agent-power-off"
                                          variant="ghost"
                                          className="size-7"
                                          aria-label="Shut down agent"
                                          onClick={() => void handleStopAgent()}
                                        >
                                          <Power className="size-3.5" />
                                        </IconButton>
                                      </TooltipTrigger>
                                      <TooltipContent side="bottom">Shut down agent</TooltipContent>
                                    </Tooltip>
                                  )}

                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <IconButton
                                        data-testid="terminal-menu-trigger"
                                        variant="ghost"
                                        aria-label="Terminal menu"
                                        className="size-7"
                                      >
                                        <MoreHorizontal className="size-3.5" />
                                      </IconButton>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-60">
                                      <DropdownMenuItem onClick={handleInjectTitle}>
                                        Inject title
                                        <span className="ml-auto text-xs text-muted-foreground">
                                          {terminalInjectTitleShortcut}
                                        </span>
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() => void handleInjectDescription()}
                                      >
                                        Inject description
                                        <span className="ml-auto text-xs text-muted-foreground">
                                          {terminalInjectDescShortcut}
                                        </span>
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem onClick={handleCopyHistory}>
                                        Copy history
                                      </DropdownMenuItem>
                                      {task.terminal_mode !== 'terminal' && (
                                        <DropdownMenuItem
                                          disabled={!getConversationIdForMode(task)}
                                          onClick={handleCopyConversationId}
                                        >
                                          Copy conversation ID
                                        </DropdownMenuItem>
                                      )}
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem onClick={handleReattachTerminal}>
                                        Re-attach terminal
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={handleRestartTerminal}>
                                        Restart terminal
                                        <span className="ml-auto pl-4 text-xs text-muted-foreground">
                                          {terminalRestartShortcut}
                                        </span>
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={handleResetTerminal}>
                                        Reset terminal
                                      </DropdownMenuItem>
                                      {task.terminal_mode !== 'terminal' && (
                                        <>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem onClick={() => void handleDoctor()}>
                                            Doctor
                                          </DropdownMenuItem>
                                        </>
                                      )}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                  <Dialog
                                    open={flagsPopoverOpen}
                                    onOpenChange={setFlagsPopoverOpen}
                                  >
                                    <DialogContent className="max-w-md">
                                      <DialogHeader>
                                        <DialogTitle>
                                          {`CLI flags for ${task.terminal_mode}`}
                                        </DialogTitle>
                                      </DialogHeader>
                                      {(
                                        <div className="space-y-3">
                                          <div className="text-xs text-muted-foreground">
                                            Passed to the provider on startup (e.g. --no-cache).
                                            Overrides defaults in settings.
                                          </div>
                                          <Input
                                            autoFocus
                                            value={flagsInputValue}
                                            onChange={(e) => setFlagsInputValue(e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault()
                                                void handleFlagsSave(flagsInputValue)
                                                setFlagsPopoverOpen(false)
                                              } else if (e.key === 'Escape') {
                                                e.preventDefault()
                                                setFlagsInputValue(getProviderFlagsForMode(task))
                                                setFlagsPopoverOpen(false)
                                              }
                                            }}
                                            placeholder="Flags"
                                          />
                                          <div className="flex gap-2 justify-end">
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              onClick={() => {
                                                void handleSetDefaultFlags()
                                              }}
                                              disabled={task.terminal_mode === 'terminal'}
                                            >
                                              Reset to default
                                            </Button>
                                            <Button
                                              size="sm"
                                              onClick={() => {
                                                void handleFlagsSave(flagsInputValue)
                                                setFlagsPopoverOpen(false)
                                              }}
                                            >
                                              Save
                                            </Button>
                                          </div>
                                        </div>
                                      )}
                                    </DialogContent>
                                  </Dialog>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                Switch to Main tab to use these controls
                              </TooltipContent>
                            </Tooltip>
                          }
                        />
                      ) : (
                        <div className="h-full flex items-center justify-center text-muted-foreground">
                          <div className="text-center p-8">
                            <p className="mb-2">No repository path configured</p>
                            <p className="text-sm">
                              Set a repository path in project settings to use the terminal
                            </p>
                          </div>
                        </div>
                      )}
                      {/* Black cover during a panel resize. The terminal stays
                          mounted underneath — preserving active group + focused
                          pane — while the `paused` prop skips xterm fit churn. */}
                      {isResizing && <div className="absolute inset-0 z-10 bg-black" />}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Non-terminal panels hidden in compact mode */}
            {!compact && panelVisibility.browser && renderResizeHandle('browser')}

            {/* Browser Panel */}
            {!compact && panelVisibility.browser && (
              <div
                data-panel-id="browser"
                className={cn(
                  'shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden transition-shadow duration-200',
                  multipleVisiblePanels &&
                    focusedPanel === 'browser' &&
                    'shadow-[0_0_18px_rgba(255,255,255,0.25)]'
                )}
                style={{ width: resolvedWidths.browser, ...panelOrderStyle('browser') }}
              >
                {ownership.hasOtherOwner('browser') ? (
                  <PanelOwnerStub
                    panelLabel="Browser"
                    icon={Globe}
                    activeElsewhere
                    onActivate={() => ownership.claim('browser')}
                    onActivateAndClose={() => ownership.claimAndCloseOther('browser')}
                  />
                ) : (
                  <Suspense fallback={<PanelLoadingSkeleton />}>
                    {/* NOT wrapped in Activity: useBrowserViewLifecycle's cleanup
                        would destroy the WebContentsView on hide and recreate it
                        on show, resetting video playback. BrowserPanel keeps the
                        active WCV painting at off-screen bounds when the parent
                        task tab is hidden (see useBrowserViewBounds offScreen). */}
                    <BrowserPanel
                      ref={browserPanelRef}
                      className="h-full"
                      tabs={browserTabs}
                      onTabsChange={handleBrowserTabsChange}
                      onRequestHide={() => handlePanelToggle('browser', false)}
                      taskId={task.id}
                      projectId={task.project_id}
                      isResizing={isResizing}
                      isActive={isActive}
                      onElementSnippet={handleInsertElementSnippet}
                      onScreenshot={handleScreenshot}
                      canUseDomPicker={panelVisibility.terminal}
                    />
                  </Suspense>
                )}
              </div>
            )}

            {/* Resize handle before Editor */}
            {!compact && panelVisibility.editor && renderResizeHandle('editor')}

            {/* File Editor Panel */}
            {!compact && panelVisibility.editor && (
              <div
                data-panel-id="editor"
                className={cn(
                  'shrink-0 overflow-hidden rounded-md bg-surface-1 border border-border transition-shadow duration-200',
                  multipleVisiblePanels &&
                    focusedPanel === 'editor' &&
                    'shadow-[0_0_18px_rgba(255,255,255,0.25)]'
                )}
                style={{ width: resolvedWidths.editor, ...panelOrderStyle('editor') }}
              >
                {ownership.hasOtherOwner('editor') ? (
                  <PanelOwnerStub
                    panelLabel="Editor"
                    icon={FileCode}
                    activeElsewhere
                    onActivate={() => ownership.claim('editor')}
                    onActivateAndClose={() => ownership.claimAndCloseOther('editor')}
                  />
                ) : effectiveRepoPath ? (
                  <Suspense fallback={<PanelLoadingSkeleton />}>
                    <Activity mode={isActive ? 'visible' : 'hidden'}>
                      <FileEditorView
                        ref={fileEditorRefCallback}
                        projectPath={effectiveRepoPath}
                        initialEditorState={task.editor_open_files}
                        onEditorStateChange={handleEditorStateChange}
                      />
                    </Activity>
                  </Suspense>
                ) : null}
              </div>
            )}

            {/* Resize handle before Artifacts */}
            {!compact && panelVisibility.artifacts && renderResizeHandle('artifacts')}

            {/* Artifacts Panel */}
            {!compact && panelVisibility.artifacts && (
              <div
                data-panel-id="artifacts"
                className={cn(
                  'shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden flex flex-col transition-shadow duration-200',
                  multipleVisiblePanels &&
                    focusedPanel === 'artifacts' &&
                    'shadow-[0_0_18px_rgba(255,255,255,0.25)]'
                )}
                style={{ width: resolvedWidths.artifacts, ...panelOrderStyle('artifacts') }}
              >
                {ownership.hasOtherOwner('artifacts') ? (
                  <PanelOwnerStub
                    panelLabel="Artifacts"
                    icon={Paperclip}
                    activeElsewhere
                    onActivate={() => ownership.claim('artifacts')}
                    onActivateAndClose={() => ownership.claimAndCloseOther('artifacts')}
                  />
                ) : (
                  <Suspense fallback={<PanelLoadingSkeleton />}>
                    <Activity mode={isActive ? 'visible' : 'hidden'}>
                      <ArtifactsPanel
                        ref={artifactsPanelRef}
                        taskId={task.id}
                        isResizing={isResizing}
                        initialActiveArtifactId={task.active_artifact_id}
                        onActiveArtifactIdChange={handleActiveArtifactIdChange}
                      />
                    </Activity>
                  </Suspense>
                )}
              </div>
            )}

            {/* Web Panels (custom + predefined) */}
            {!compact &&
              enabledWebPanels.map((wp) => {
                if (!panelVisibility[wp.id]) return null
                return (
                  <div key={wp.id} className="contents">
                    {renderResizeHandle(wp.id)}
                    <div
                      data-panel-id={wp.id}
                      className={cn(
                        'shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden transition-shadow duration-200',
                        multipleVisiblePanels &&
                          focusedPanel === wp.id &&
                          'shadow-[0_0_18px_rgba(255,255,255,0.25)]'
                      )}
                      style={{ width: resolvedWidths[wp.id], ...panelOrderStyle(wp.id) }}
                    >
                      {ownership.hasOtherOwner(wp.id) ? (
                        <PanelOwnerStub
                          panelLabel={wp.name}
                          icon={Globe}
                          activeElsewhere
                          onActivate={() => ownership.claim(wp.id)}
                          onActivateAndClose={() => ownership.claimAndCloseOther(wp.id)}
                        />
                      ) : (
                        // NOT wrapped in Activity: same reason as BrowserPanel —
                        // useBrowserViewLifecycle would destroy the WCV on hide.
                        // Off-screen park (offScreen prop on useBrowserView) keeps
                        // it painting while parent task tab is hidden.
                        <WebPanelView
                          taskId={task.id}
                          panelId={wp.id}
                          url={task.web_panel_urls?.[wp.id] || wp.baseUrl}
                          baseUrl={wp.baseUrl}
                          name={wp.name}
                          blockDesktopHandoff={wp.blockDesktopHandoff === true}
                          handoffProtocol={wp.handoffProtocol}
                          handoffHostScope={wp.handoffHostScope}
                          onUrlChange={handleWebPanelUrlChange}
                          onFaviconChange={handleWebPanelFaviconChange}
                          isResizing={isResizing}
                          isActive={isActive}
                        />
                      )}
                    </div>
                  </div>
                )
              })}

            {/* Resize handle before Diff */}
            {!compact && panelVisibility.diff && renderResizeHandle('diff')}

            {/* Git Panel */}
            {!compact && panelVisibility.diff && (
              <div
                data-panel-id="diff"
                data-testid="task-git-panel"
                className={cn(
                  'shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden flex flex-col transition-shadow duration-200',
                  multipleVisiblePanels &&
                    focusedPanel === 'diff' &&
                    'shadow-[0_0_18px_rgba(255,255,255,0.25)]'
                )}
                style={{ width: resolvedWidths.diff, ...panelOrderStyle('diff') }}
              >
                {ownership.hasOtherOwner('diff') ? (
                  <PanelOwnerStub
                    panelLabel="Git"
                    icon={GitBranch}
                    activeElsewhere
                    onActivate={() => ownership.claim('diff')}
                    onActivateAndClose={() => ownership.claimAndCloseOther('diff')}
                  />
                ) : (
                  <Suspense fallback={<PanelLoadingSkeleton />}>
                    <Activity mode={isActive ? 'visible' : 'hidden'}>
                      <UnifiedGitPanel
                        ref={gitPanelRef}
                        task={task}
                        projectId={task.project_id}
                        projectPath={resolvedGitViewPath}
                        completedStatus={completedStatus}
                        visible={panelVisibility.diff}
                        defaultTab={gitDefaultTab}
                        onTabChange={handleGitTabChange}
                        pollIntervalMs={5000}
                        onUpdateTask={updateTaskAndNotify}
                        onTaskUpdated={handleTaskUpdate}
                        detectedRepos={viewableRepos.map((r) => ({
                          name: r.name,
                          path: r.path,
                          kind: r.kind
                        }))}
                        selectedRepoName={
                          viewableRepos.find((r) => r.path === resolvedGitViewPath)?.name ?? null
                        }
                        isRepoStale={false}
                        onRepoChange={handleRepoChange}
                      />
                    </Activity>
                  </Suspense>
                )}
              </div>
            )}

            {/* Resize handle before Settings */}
            {!compact && panelVisibility.settings && renderResizeHandle('settings')}

            {/* Settings Panel */}
            {!compact && panelVisibility.settings && (
              <div
                data-panel-id="settings"
                data-testid="task-settings-panel"
                className={cn(
                  'shrink-0 rounded-md bg-surface-1 border border-border p-3 flex flex-col gap-4 overflow-y-auto transition-shadow duration-200',
                  multipleVisiblePanels &&
                    focusedPanel === 'settings' &&
                    'shadow-[0_0_18px_rgba(255,255,255,0.25)]'
                )}
                style={{ width: resolvedWidths.settings, ...panelOrderStyle('settings') }}
              >
                {ownership.hasOtherOwner('settings') ? (
                  <PanelOwnerStub
                    panelLabel="Settings"
                    icon={Settings2}
                    activeElsewhere
                    onActivate={() => ownership.claim('settings')}
                    onActivateAndClose={() => ownership.claimAndCloseOther('settings')}
                  />
                ) : (
                  <Activity mode={isActive ? 'visible' : 'hidden'}>
                  <TaskSettingsPanel
                    taskId={task.id}
                    renderDefaultContent={() => {
                      // The grid holds Description / Sub-tasks / Artifacts (and, in
                      // full-height, Details). Open cards SHARE the available height via
                      // useSharedCardHeights: each hugs its content, tall cards cap at a
                      // shared water-level and scroll internally, short neighbours' unused
                      // space flows to the tall ones, and nothing is squeezed below 9rem
                      // by sharing alone (the grid scrolls instead). `grid-template-rows`
                      // is set imperatively by the hook — keep none here.
                      //
                      // Details (task metadata + working dir + danger zone) renders in two
                      // places depending on mode: pinned at the bottom of the panel in
                      // normal mode (always shown, unshrinkable), or as a 4th card INSIDE
                      // the grid in full-height mode (collapsible, shares space via the
                      // water-fill). Body is shared via this const.
                      const detailsBody = (
                        <>
                          <TaskMetadataSidebar
                            task={task}
                            tags={tags}
                            taskTagIds={taskTagIds}
                            onUpdate={handleTaskUpdate}
                            onTagsChange={handleTagsChange}
                            onTagCreated={(tag) => setTags((prev) => [...prev, tag])}
                          />

                          <div className="flex flex-col gap-3 mt-5">
                            {/* Working directory */}
                            <div className="flex flex-col gap-2">
                              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                                Working directory
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="size-3 text-muted-foreground/60 cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-72 text-xs">
                                    <p>Override the project directory for this task.</p>
                                    <p className="mt-1.5">Priority (highest first):</p>
                                    <ol className="mt-0.5 list-decimal list-inside">
                                      <li>Worktree</li>
                                      <li>Custom directory</li>
                                      <li>Project path</li>
                                    </ol>
                                  </TooltipContent>
                                </Tooltip>
                              </span>
                              <div className="flex items-center gap-1">
                                <div
                                  className="flex-1 min-w-0 text-xs text-muted-foreground truncate px-2 py-1.5 rounded border border-border bg-muted/30"
                                  title={effectiveRepoPath ?? 'No directory set'}
                                >
                                  {effectiveRepoPath ?? 'No directory set'}
                                  {task.worktree_path && (
                                    <span className="ml-1 text-[10px] opacity-60">(worktree)</span>
                                  )}
                                  {!task.worktree_path && task.base_dir && (
                                    <span className="ml-1 text-[10px] opacity-60">(custom)</span>
                                  )}
                                </div>
                                <button
                                  className="shrink-0 h-7 w-7 flex items-center justify-center rounded hover:bg-muted"
                                  title="Change working directory"
                                  onClick={async () => {
                                    const result = await window.api.dialog.showOpenDialog({
                                      title: 'Select Working Directory',
                                      defaultPath: task.base_dir ?? effectiveRepoPath ?? undefined,
                                      properties: ['openDirectory']
                                    })
                                    if (result.canceled || !result.filePaths[0]) return
                                    await updateTaskAndNotify({
                                      id: task.id,
                                      baseDir: result.filePaths[0]
                                    })
                                  }}
                                >
                                  <FileCode className="size-3.5 text-muted-foreground" />
                                </button>
                                {task.base_dir && (
                                  <button
                                    className="shrink-0 h-7 w-7 flex items-center justify-center rounded hover:bg-muted"
                                    title="Clear custom directory"
                                    onClick={() => {
                                      void updateTaskAndNotify({ id: task.id, baseDir: null })
                                    }}
                                  >
                                    <X className="size-3.5 text-muted-foreground" />
                                  </button>
                                )}
                              </div>
                              {task.worktree_path && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs w-full justify-start"
                                  onClick={() => {
                                    void updateTaskAndNotify({
                                      id: task.id,
                                      worktreePath: null,
                                      worktreeParentBranch: null
                                    })
                                  }}
                                >
                                  <GitBranch className="mr-1.5 size-3" />
                                  Detach worktree
                                </Button>
                              )}
                              {task.worktree_path && task.base_dir && (
                                <span className="text-[10px] text-amber-400/80">
                                  Worktree active — custom dir overridden
                                </span>
                              )}
                            </div>

                            {/* Danger zone */}
                            <div className="flex flex-col gap-2">
                              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                                Danger zone
                              </span>
                              <div className="flex items-center gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="flex-1 text-xs"
                                  onClick={
                                    isArchived ? handleUnarchive : () => setArchiveDialogOpen(true)
                                  }
                                >
                                  <Archive className="mr-1.5 size-3" />
                                  {isArchived ? 'Unarchive' : 'Archive'}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="flex-1 text-xs text-destructive hover:text-destructive"
                                  onClick={() => setDeleteDialogOpen(true)}
                                >
                                  <Trash2 className="mr-1.5 size-3" />
                                  Delete
                                </Button>
                              </div>
                            </div>
                          </div>
                        </>
                      )
                      return (
                        <>
                          {/* External sync links — pinned above the shared grid */}
                          <ExternalSyncCard taskId={task.id} onUpdate={handleTaskUpdate} />

                          {/* Cards grid: flex-1 min-h-0 → height is the spare space
                              between ExternalSync and the pinned Details (definite, so
                              the water-level caps resolve). useSharedCardHeights also sets
                              a min-height = floored content, so a short window scrolls the
                              PANEL (keeping cards usable) instead of crushing them; the
                              grid itself never overflows. content-start → short cards leave
                              the leftover as empty space above the pinned meta. */}
                          <div
                            ref={settingsCardsGridRef}
                            data-testid="settings-cards-grid"
                            className="flex-1 min-h-0 overflow-hidden grid gap-4 content-start"
                          >
                            {/* Description */}
                            <Collapsible
                              data-testid="settings-description-card"
                              data-card
                              data-card-open={descriptionOpen}
                              open={descriptionOpen}
                              onOpenChange={setDescriptionOpen}
                              className="flex flex-col rounded-md border border-border overflow-hidden min-h-0"
                            >
                              <div
                                className={cn(
                                  'flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground',
                                  descriptionOpen && 'border-b border-border'
                                )}
                              >
                                <CollapsibleTrigger className="flex flex-1 items-center gap-1.5 hover:text-foreground transition-colors [&[data-state=open]>svg:first-child]:rotate-90">
                                  <ChevronRight className="size-3 transition-transform" />
                                  Description
                                </CollapsibleTrigger>
                                <div className="ml-auto flex items-center gap-0.5">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <IconButton
                                        type="button"
                                        variant="ghost"
                                        aria-label={
                                          descriptionExpanded ? 'Default height' : 'Full height'
                                        }
                                        className={cn(
                                          'size-5 hover:text-foreground',
                                          descriptionExpanded
                                            ? 'text-foreground bg-muted'
                                            : 'text-muted-foreground'
                                        )}
                                        onClick={() =>
                                          setDescriptionExpanded((v) => {
                                            if (!v) {
                                              setDetailsOpen(false)
                                              setSubTasksOpen(false)
                                              setArtifactsOpen(false)
                                            } else {
                                              setDetailsOpen(true)
                                              setSubTasksOpen(true)
                                              setArtifactsOpen(true)
                                            }
                                            return !v
                                          })
                                        }
                                      >
                                        <IconArrowsVertical size={12} />
                                      </IconButton>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {descriptionExpanded ? 'Default height' : 'Full height'}
                                    </TooltipContent>
                                  </Tooltip>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <IconButton
                                        type="button"
                                        variant="ghost"
                                        aria-label="Fullscreen"
                                        className="size-5 text-muted-foreground hover:text-foreground"
                                        onClick={() => setDescriptionFullscreen(true)}
                                      >
                                        <IconArrowsMaximize size={12} />
                                      </IconButton>
                                    </TooltipTrigger>
                                    <TooltipContent>Fullscreen</TooltipContent>
                                  </Tooltip>
                                </div>
                              </div>
                              {descriptionOpen && (
                                <div className="flex flex-col min-h-0 flex-1">
                                  <Suspense fallback={<div className="h-20" />}>
                                    <RichTextEditor
                                      value={descriptionValue}
                                      onChange={(md) => {
                                        descriptionDirty.current = true
                                        setDescriptionValue(md)
                                      }}
                                      onBlur={handleDescriptionSave}
                                      placeholder="Add description..."
                                      testId="task-description-editor"
                                      variant="inline"
                                      fontFamily={notesFontFamily}
                                      checkedHighlight={notesCheckedHighlight}
                                      showToolbar={notesShowToolbar}
                                      spellcheck={notesSpellcheck}
                                      themeColors={notesThemeColors}
                                      artifacts={artifacts.map((a) => ({
                                        id: a.id,
                                        title: a.title,
                                        type: RENDER_MODE_INFO[
                                          getEffectiveRenderMode(a.title, a.render_mode)
                                        ].label
                                      }))}
                                      onArtifactClick={(artifactId) => {
                                        if (!panelVisibility.artifacts)
                                          handlePanelToggle('artifacts', true)
                                        artifactsPanelRef.current?.selectArtifact(artifactId)
                                      }}
                                      onUploadImages={handleUploadImages}
                                    />
                                  </Suspense>
                                </div>
                              )}
                            </Collapsible>

                            {/* Sub-tasks */}
                            <Collapsible
                              data-testid="settings-subtasks-card"
                              data-card
                              data-card-open={subTasksOpen}
                              open={subTasksOpen}
                              onOpenChange={setSubTasksOpen}
                              className="group/sub rounded-md border border-border overflow-hidden flex flex-col min-h-0"
                            >
                              <CollapsibleTrigger className="shrink-0 flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 min-h-8 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group-data-[state=open]/sub:border-b border-border [&[data-state=open]>svg:first-child]:rotate-90">
                                <ChevronRight className="size-3 transition-transform" />
                                Sub-tasks
                                {subTasks.length > 0 && (
                                  <span className="ml-auto text-muted-foreground/60 text-[10px]">
                                    {
                                      subTasks.filter((s) =>
                                        isTerminalStatus(s.status, project?.columns_config ?? null)
                                      ).length
                                    }
                                    /{subTasks.length}
                                  </span>
                                )}
                              </CollapsibleTrigger>
                              <CollapsibleContent className="p-2 flex flex-col flex-1 min-h-0">
                                <DndContext
                                  sensors={subTaskSensors}
                                  collisionDetection={closestCenter}
                                  onDragEnd={handleSubTaskDragEnd}
                                >
                                  <SortableContext
                                    items={subTasks.map((s) => s.id)}
                                    strategy={verticalListSortingStrategy}
                                  >
                                    <div
                                      data-card-scroll
                                      className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto overscroll-contain"
                                    >
                                      {subTasks.map((sub) => (
                                        <SortableSubTask
                                          key={sub.id}
                                          sub={sub}
                                          columns={project?.columns_config}
                                          statusOptions={statusOptions}
                                          onNavigate={onNavigateToTask}
                                          onUpdate={handleUpdateSubTask}
                                          onDelete={handleDeleteSubTask}
                                        />
                                      ))}
                                      {addingSubTask ? (
                                        <div className="flex items-center gap-2 py-1 px-1">
                                          <Input
                                            ref={subTaskInputRef}
                                            value={subTaskTitle}
                                            onChange={(e) => setSubTaskTitle(e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault()
                                                handleCreateSubTask()
                                              }
                                              if (e.key === 'Escape') {
                                                setAddingSubTask(false)
                                                setSubTaskTitle('')
                                              }
                                            }}
                                            placeholder="Sub-task title..."
                                            className="h-6 text-xs"
                                            autoFocus
                                          />
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => setAddingSubTask(true)}
                                          className="flex items-center gap-1.5 py-1 px-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 mt-1"
                                        >
                                          <Plus className="size-3" />
                                          Add subtask
                                        </button>
                                      )}
                                    </div>
                                  </SortableContext>
                                </DndContext>
                              </CollapsibleContent>
                            </Collapsible>

                            {/* Artifacts */}
                            <Collapsible
                              data-testid="settings-artifacts-card"
                              data-card
                              data-card-open={artifactsOpen}
                              open={artifactsOpen}
                              onOpenChange={setArtifactsOpen}
                              className="group/artifacts rounded-md border border-border overflow-hidden flex flex-col min-h-0"
                            >
                              <CollapsibleTrigger className="flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 min-h-8 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group-data-[state=open]/artifacts:border-b border-border [&[data-state=open]>svg:first-child]:rotate-90">
                                <ChevronRight className="size-3 transition-transform" />
                                Artifacts
                                {artifacts.length > 0 && (
                                  <span className="ml-auto text-muted-foreground/60 text-[10px]">
                                    {artifacts.length}
                                  </span>
                                )}
                              </CollapsibleTrigger>
                              <CollapsibleContent className="p-2 flex flex-col flex-1 min-h-0">
                                <div
                                  data-card-scroll
                                  className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto overscroll-contain"
                                >
                                  {artifacts.map((artifact) => (
                                    <button
                                      key={artifact.id}
                                      type="button"
                                      className="flex items-center gap-2 py-1 px-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 text-left"
                                      onClick={() => {
                                        if (!panelVisibility.artifacts)
                                          handlePanelToggle('artifacts', true)
                                        artifactsPanelRef.current?.selectArtifact(artifact.id)
                                      }}
                                    >
                                      <Paperclip className="size-3 shrink-0" />
                                      <span className="truncate">{artifact.title}</span>
                                      <span className="ml-auto text-[10px] opacity-60">
                                        {getExtensionFromTitle(artifact.title) || 'file'}
                                      </span>
                                    </button>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (!panelVisibility.artifacts)
                                        handlePanelToggle('artifacts', true)
                                      artifactsPanelRef.current?.createArtifact()
                                    }}
                                    className="flex items-center gap-1.5 py-1 px-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 mt-1"
                                  >
                                    <Plus className="size-3" />
                                    Add artifact
                                  </button>
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                            {/* Details — in full-height mode this becomes a 4th card that
                                shares the grid via the water-fill (collapsed by default
                                when entering full-height). */}
                            {descriptionExpanded && (
                              <Collapsible
                                data-testid="settings-details-card"
                                data-card
                                data-card-open={detailsOpen}
                                open={detailsOpen}
                                onOpenChange={setDetailsOpen}
                                className="group/details rounded-md border border-border overflow-hidden flex flex-col min-h-0"
                              >
                                <CollapsibleTrigger className="shrink-0 flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 min-h-8 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group-data-[state=open]/details:border-b border-border [&[data-state=open]>svg:first-child]:rotate-90">
                                  <ChevronRight className="size-3 transition-transform" />
                                  Details
                                </CollapsibleTrigger>
                                <CollapsibleContent className="flex flex-col flex-1 min-h-0">
                                  <div
                                    data-card-scroll
                                    className="flex-1 min-h-0 overflow-y-auto p-2.5"
                                  >
                                    {detailsBody}
                                  </div>
                                </CollapsibleContent>
                              </Collapsible>
                            )}
                          </div>

                          {/* Details — normal mode: pinned at the bottom of the panel,
                              always visible, never shrinks. */}
                          {!descriptionExpanded && (
                            <div
                              data-testid="settings-details-pinned"
                              className="shrink-0 mt-auto"
                            >
                              {detailsBody}
                            </div>
                          )}
                        </>
                      )
                    }}
                  />
                  </Activity>
                )}
              </div>
            )}

            {/* Resize handle before Processes */}
            {!compact && panelVisibility.processes && renderResizeHandle('processes')}

            {/* Processes Panel */}
            {!compact && panelVisibility.processes && (
              <div
                data-panel-id="processes"
                className={cn(
                  'shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden flex flex-col transition-shadow duration-200',
                  multipleVisiblePanels &&
                    focusedPanel === 'processes' &&
                    'shadow-[0_0_18px_rgba(255,255,255,0.25)]'
                )}
                style={{ width: resolvedWidths.processes, ...panelOrderStyle('processes') }}
              >
                {ownership.hasOtherOwner('processes') ? (
                  <PanelOwnerStub
                    panelLabel="Processes"
                    icon={Cpu}
                    activeElsewhere
                    onActivate={() => ownership.claim('processes')}
                    onActivateAndClose={() => ownership.claimAndCloseOther('processes')}
                  />
                ) : (
                  <Activity mode={isActive ? 'visible' : 'hidden'}>
                    <ProcessesPanel
                      taskId={task.id}
                      projectId={project?.id ?? null}
                      cwd={effectiveRepoPath || project?.path}
                      terminalSessionId={getMainSessionId(task.id)}
                      onOpenUrl={openDevServerInBrowser}
                    />
                  </Activity>
                )}
              </div>
            )}
          </>
        )}
      </div>

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

      <DeleteTaskDialog
        task={task}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onDeleted={handleDeleteConfirm}
        onDeleteTask={onDeleteTask}
      />

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
                  const modeLabel = modes.find((m) => m.id === task.terminal_mode)?.label
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
        />
      </Suspense>
    </div>
  )
})
