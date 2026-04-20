import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MoreHorizontal, Archive, Trash2, AlertTriangle, Loader2, Terminal as TerminalIcon, Globe, Settings2, GitBranch, FileCode, ChevronRight, Plus, GripVertical, X, Info, CheckCircle2, XCircle, Stethoscope, Cpu, Circle, Repeat, LayoutTemplate, Paperclip } from 'lucide-react'
import { IconArrowsVertical, IconArrowsMaximize } from '@tabler/icons-react'
import { DescriptionDialog } from './DescriptionDialog'
import { AssetsPanel, type AssetsPanelHandle } from './AssetsPanel'
import { useAssets } from './useAssets'
import { DndContext, PointerSensor, useSensors, useSensor, closestCenter } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Task, PanelVisibility, UpdateTaskInput } from '@slayzone/task/shared'
import type { TaskTemplate } from '@slayzone/task/shared'
import type { TaskDetailData } from './taskDetailCache'
import { BUILTIN_PANEL_IDS, getProviderConversationId, getProviderFlags, setProviderConversationId, setProviderFlags, clearAllConversationIds, priorityOptions } from '@slayzone/task/shared'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Project } from '@slayzone/projects/shared'
import { getDefaultStatus, getDoneStatus, isTerminalStatus, resolveRepoPath } from '@slayzone/projects/shared'
import { useDetectedRepos } from '@slayzone/projects'
import { DEV_SERVER_URL_PATTERN, SESSION_ID_COMMANDS, SESSION_ID_UNAVAILABLE } from '@slayzone/terminal/shared'
import type { TerminalMode, TerminalState, ValidationResult } from '@slayzone/terminal/shared'
import { Button, IconButton, PanelToggle, DevServerToast, Collapsible, CollapsibleTrigger, CollapsibleContent } from '@slayzone/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@slayzone/ui'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
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
import { RichTextEditor } from '@slayzone/editor'
import { normalizeDescription, stripMarkdown, getExtensionFromTitle, getEffectiveRenderMode, RENDER_MODE_INFO } from '@slayzone/task/shared'
import { useTheme, useDialogStore, type SearchFileContext } from '@slayzone/settings/client'
import { markSkipCache, usePty, useTerminalModes, getVisibleModes, getModeLabel, groupTerminalModes, useLoopMode, isLoopActive, stripAnsi, serializeTerminalHistory, LoopModeBanner, LoopModeDialog, SlayNudgeBanner, useSlayNudge } from '@slayzone/terminal'
import type { LoopConfig } from '@slayzone/terminal/shared'
import { TerminalContainer, type TerminalContainerHandle, ConfirmDisplayModeDialog, type TabDisplayMode, isChatSupported } from '@slayzone/task-terminals'
import { UnifiedGitPanel, type UnifiedGitPanelHandle, type GitTabId } from '@slayzone/worktrees'
import { buildStatusOptions, cn, getColumnStatusStyle, getTerminalStateStyle, PriorityIcon, useAppearance, matchesShortcut, useShortcutStore, useShortcutDisplay, withModalGuard, getThemeEditorColors, type EditorThemeColors } from '@slayzone/ui'
import { BrowserPanel, type BrowserPanelHandle } from '@slayzone/task-browser'
import { FileEditorView, type FileEditorViewHandle } from '@slayzone/file-editor/client'
import type { EditorOpenFilesState, OpenFileOptions } from '@slayzone/file-editor/shared'
import { track } from '@slayzone/telemetry/client'
import { usePanelSizes, resolveWidths } from './usePanelSizes'
import { usePanelConfig } from './usePanelConfig'
import { useSubTasks } from './useSubTasks'
import { useTaskTagIds } from './useTaskTagIds'
import { WebPanelView } from './WebPanelView'
import { ResizeHandle } from './ResizeHandle'
import { ProcessesPanel } from './ProcessesPanel'
import { TaskSettingsPanel } from './TaskSettingsPanel'

function SortableSubTask({ sub, columns, statusOptions, onNavigate, onUpdate, onDelete }: {
  sub: Task
  columns?: Project['columns_config']
  statusOptions: Array<{ value: string; label: string }>
  onNavigate?: (id: string) => void
  onUpdate: (id: string, updates: Record<string, unknown>) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sub.id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const statusStyle = getColumnStatusStyle(sub.status, columns)
  const StatusIcon = statusStyle?.icon
  const [statusOpen, setStatusOpen] = useState(false)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          className={cn(
            "relative flex items-center gap-2 py-1 px-1 rounded cursor-pointer hover:bg-muted/50 group select-none",
            isDragging && "opacity-50"
          )}
        >
          <span {...attributes} {...listeners} className="absolute -left-4 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground">
            <GripVertical className="size-3" />
          </span>
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Status: ${statusStyle?.label ?? sub.status}`}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 cursor-pointer transition-opacity hover:opacity-70"
              >
                {StatusIcon && <StatusIcon className={cn("size-3.5", statusStyle?.iconClass)} />}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="start" onClick={(e) => e.stopPropagation()}>
              {statusOptions.map((opt) => {
                const optStyle = getColumnStatusStyle(opt.value, columns)
                const OptIcon = optStyle?.icon ?? Circle
                const isCurrent = opt.value === sub.status
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm cursor-pointer hover:bg-accent', isCurrent && 'bg-accent font-medium')}
                    onClick={() => {
                      onUpdate(sub.id, { status: opt.value })
                      setStatusOpen(false)
                    }}
                  >
                    <OptIcon className={cn('size-4', optStyle?.iconClass)} />
                    {opt.label}
                  </button>
                )
              })}
            </PopoverContent>
          </Popover>
          <span
            className={cn("text-xs flex-1 truncate", isTerminalStatus(sub.status, columns ?? null) && "line-through text-muted-foreground")}
            onClick={() => onNavigate?.(sub.id)}
          >
            {sub.title}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onNavigate?.(sub.id)}>Open</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Status</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={sub.status} onValueChange={(v) => onUpdate(sub.id, { status: v })}>
              {statusOptions.map((s) => (
                <ContextMenuRadioItem key={s.value} value={s.value}>{s.label}</ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Priority</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={String(sub.priority)} onValueChange={(v) => onUpdate(sub.id, { priority: parseInt(v, 10) })}>
              {Object.entries({ 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Someday' }).map(([value, label]) => (
                <ContextMenuRadioItem key={value} value={value}>{label}</ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(sub.id)}>Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function PtyStateDot({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { getState, subscribeState } = usePty()
  const [state, setState] = useState<TerminalState>(() => getState(sessionId))
  useEffect(() => {
    setState(getState(sessionId))
    return subscribeState(sessionId, (next) => setState(next))
  }, [sessionId, getState, subscribeState])
  const style = state !== 'starting' ? getTerminalStateStyle(state) : null
  if (!style) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('shrink-0 size-2 rounded-full', style.color)} aria-label={`Terminal: ${style.label}`} />
      </TooltipTrigger>
      <TooltipContent>Terminal: {style.label}</TooltipContent>
    </Tooltip>
  )
}

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
}: TaskDetailPageProps): React.JSX.Element {
  // Prefer live global state; fall back to suspense-cached data for subtask race window
  const task = taskProp ?? initialData?.task ?? null
  const project = projectProp ?? initialData?.project ?? null

  // Owns keyboard shortcuts; falls back to isActive so non-explode callers need not set it.
  const shortcutActive = hasShortcutFocus ?? isActive

  const { modes } = useTerminalModes()

  const { editorThemeId, contentVariant } = useTheme()
  const { notesFontFamily, notesReadability, notesWidth, notesCheckedHighlight, notesShowToolbar, notesSpellcheck } = useAppearance()
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
      setTags((prev) => prev.map((t) => t.id === tag.id ? tag : t))
    }
    window.addEventListener('slayzone:tag-updated', handleTagUpdated)
    return () => window.removeEventListener('slayzone:tag-updated', handleTagUpdated)
  }, [])
  const { tagIds: taskTagIds, setTagIds: setTaskTagIds } = useTaskTagIds(task?.id, initialData?.taskTagIds)
  const statusOptions = useMemo(() => buildStatusOptions(project?.columns_config), [project?.columns_config])
  const completedStatus = useMemo(() => getDoneStatus(project?.columns_config), [project?.columns_config])
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false)
  const [priorityPopoverOpen, setPriorityPopoverOpen] = useState(false)

  // Sub-tasks
  const { subTasks, createSubTask, updateSubTask: handleUpdateSubTask, deleteSubTask: handleDeleteSubTask, handleDragEnd: handleSubTaskDragEnd } = useSubTasks(task?.id, initialData?.subTasks)

  // Assets
  const { assets } = useAssets(task?.id)
  const [addingSubTask, setAddingSubTask] = useState(false)
  const [subTaskTitle, setSubTaskTitle] = useState('')
  const subTaskInputRef = useRef<HTMLInputElement>(null)
  const [parentTask] = useState<Task | null>(initialData?.parentTask ?? null)

  // Project path validation
  const [projectPathMissing, setProjectPathMissing] = useState(initialData?.projectPathMissing ?? false)

  // Multi-repo detection
  const detectedRepos = useDetectedRepos(project?.path ?? null)
  const resolvedRepo = useMemo(
    () => resolveRepoPath(project?.path ?? null, detectedRepos, task?.repo_name ?? null),
    [project?.path, detectedRepos, task?.repo_name]
  )
  // Effective repo path (worktree > resolved child repo > project path)
  const effectiveRepoPath = task?.worktree_path ?? task?.base_dir ?? resolvedRepo.path
  const handleRepoChange = useCallback((repoName: string) => {
    if (!task) return
    window.api.db.updateTask({ id: task.id, repoName }).then((updated) => {
      onTaskUpdated(updated)
    })
  }, [task?.id, onTaskUpdated])

  // PTY context for buffer management
  const { resetTaskState, subscribeSessionDetected, subscribeDevServer, getQuickRunPrompt, clearQuickRunPrompt } = usePty()

  // Shortcut display strings (reactive to user customization)
  const panelTerminalShortcut = useShortcutDisplay('panel-terminal')
  const panelBrowserShortcut = useShortcutDisplay('panel-browser')
  const panelEditorShortcut = useShortcutDisplay('panel-editor')
  const panelGitShortcut = useShortcutDisplay('panel-git')
  const panelProcessesShortcut = useShortcutDisplay('panel-processes')
  const panelSettingsShortcut = useShortcutDisplay('panel-settings')
  const panelAssetsShortcut = useShortcutDisplay('panel-assets')

  const terminalInjectTitleShortcut = useShortcutDisplay('terminal-inject-title')
  const terminalInjectDescShortcut = useShortcutDisplay('terminal-inject-desc')
  const terminalRestartShortcut = useShortcutDisplay('terminal-restart')
  const syncSessionIdShortcut = useShortcutDisplay('sync-session-id')

  // Detected session ID from /status command
  const [detectedSessionId, setDetectedSessionId] = useState<string | null>(null)

  // Title editing state
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleValue, setTitleValue] = useState(task?.title ?? '')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Delete/archive dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)

  // Templates for temporary tasks
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  useEffect(() => {
    if (!task?.is_temporary || !task.project_id) return
    window.api.taskTemplates.getByProject(task.project_id).then(setTemplates)
  }, [task?.is_temporary, task?.project_id])

  // Description fullscreen dialog
  const [descriptionFullscreen, setDescriptionFullscreen] = useState(false)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [descriptionOpen, setDescriptionOpen] = useState(true)
  const [subTasksOpen, setSubTasksOpen] = useState(true)
  const [assetsOpen, setAssetsOpen] = useState(true)
  const [detailsOpen, setDetailsOpen] = useState(true)

  // Doctor dialog state
  const [doctorDialogOpen, setDoctorDialogOpen] = useState(false)
  const [doctorResults, setDoctorResults] = useState<ValidationResult[] | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(false)

  // In-progress prompt state

  // Description editing state
  const [descriptionValue, setDescriptionValue] = useState(() => normalizeDescription(task?.description ?? null, task?.description_format ?? 'html'))
  const descriptionDirty = useRef(false)

  // Terminal restart key (changing this forces remount)
  const [terminalKey, setTerminalKey] = useState(0)

  // Track if the main terminal tab is active (for bottom bar visibility)
  const [isMainTabActive, setIsMainTabActive] = useState(true)
  const [flagsInputValue, setFlagsInputValue] = useState('')
  const [isEditingFlags, setIsEditingFlags] = useState(false)
  const [ccsProfiles, setCcsProfiles] = useState<string[]>([])
  const flagsInputRef = useRef<HTMLInputElement>(null)

  // Panel visibility state
  const defaultPanelVisibility: PanelVisibility = { terminal: true, browser: false, diff: false, settings: true, editor: false, assets: false, processes: false }
  const [panelVisibility, setPanelVisibility] = useState<PanelVisibility>(initialData?.panelVisibility ?? defaultPanelVisibility)

  // Sync title/description from global state when changed externally
  useEffect(() => {
    if (task && !editingTitle) setTitleValue(task.title)
  }, [task?.title, editingTitle])

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
  const [browserTabs, setBrowserTabs] = useState<BrowserTabsState>(initialData?.browserTabs ?? defaultBrowserTabs)

  // Global panel configuration (which panels are enabled, custom web panels)
  const { enabledWebPanels, isBuiltinEnabled } = usePanelConfig()

  // Panel sizes for resizable panels
  const [panelSizes, updatePanelSizes, resetPanelSize, resetAllPanels] = usePanelSizes()
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

  // Resolved panel widths (auto panels get equal share of remaining space)
  const resolvedWidths = useMemo(
    () => resolveWidths(panelSizes, panelVisibility, containerWidth),
    [panelSizes, panelVisibility, containerWidth]
  )

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
  const loopConfigured = task?.loop_config != null && !!(task.loop_config.prompt.trim() && task.loop_config.criteriaPattern.trim())
  useEffect(() => {
    window.api.app.isLoopModeEnabled().then(setLoopModeAvailable)
  }, [])
  const mainSessionId = task ? getMainSessionId(task.id) : ''
  const handleLoopConfigChange = useCallback((cfg: LoopConfig | null) => {
    if (!task) return
    window.api.db.updateTask({ id: task.id, loopConfig: cfg }).then((updated) => {
      if (updated) onTaskUpdated(updated)
    })
  }, [task?.id, onTaskUpdated])
  const { status: loopStatus, iteration: loopIteration, startLoop, pauseLoop, resumeLoop, stopLoop } = useLoopMode({
    sessionId: mainSessionId,
    config: task?.loop_config ?? null,
    onConfigChange: handleLoopConfigChange
  })

  const { showBanner: showSlayNudge, dismiss: dismissSlayNudge, recheck: recheckSlayNudge } = useSlayNudge({
    projectId: task?.project_id ?? null,
    projectPath: effectiveRepoPath ?? project?.path ?? null,
  })

  // Dev server URL detection
  const [detectedDevUrl, setDetectedDevUrl] = useState<string | null>(null)
  const devUrlDismissedRef = useRef<Set<string>>(new Set())
  const devServerToastEnabledRef = useRef(true)
  const devServerAutoOpenRef = useRef(false)
  const devServerAutoOpenCallbackRef = useRef<((url: string) => void) | null>(null)
  const browserOpenRef = useRef(panelVisibility.browser)
  const gitPanelRef = useRef<UnifiedGitPanelHandle>(null)
  const [gitDefaultTab, setGitDefaultTab] = useState<GitTabId>('general')
  const fileEditorRef = useRef<FileEditorViewHandle>(null)
  const terminalContainerRef = useRef<TerminalContainerHandle>(null)
  const [mainTabDisplayMode, setMainTabDisplayMode] = useState<TabDisplayMode>('xterm')
  const [pendingChatEnable, setPendingChatEnable] = useState(false)
  const browserPanelRef = useRef<BrowserPanelHandle>(null)
  const assetsPanelRef = useRef<AssetsPanelHandle>(null)
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
  useEffect(() => { browserOpenRef.current = panelVisibility.browser }, [panelVisibility.browser])

  // Load dev server settings (re-read on settingsRevision change)
  useEffect(() => {
    Promise.all([
      window.api.settings.get('dev_server_toast_enabled'),
      window.api.settings.get('dev_server_auto_open_browser'),
    ]).then(([toast, autoOpen]) => {
      devServerToastEnabledRef.current = toast !== '0'
      devServerAutoOpenRef.current = autoOpen === '1'
    })
  }, [settingsRevision])

  // Load CCS profiles when mode is 'ccs'
  useEffect(() => {
    if (task?.terminal_mode === 'ccs') {
      window.api.pty.ccsListProfiles().then(({ profiles }) => setCcsProfiles(profiles)).catch(() => {})
    }
  }, [task?.terminal_mode])

  useEffect(() => {
    if (!task) return
    const sid = getMainSessionId(task.id)

    const handleUrl = (url: string) => {
      if (browserOpenRef.current || devUrlDismissedRef.current.has(url)) return
      devUrlDismissedRef.current.add(url)
      if (devServerAutoOpenRef.current) {
        devServerAutoOpenCallbackRef.current?.(url)
      } else if (devServerToastEnabledRef.current) {
        setDetectedDevUrl(url)
      }
    }

    // Subscribe first, then check buffer (avoids race where URL emits between read and subscribe)
    const unsub = subscribeDevServer(sid, handleUrl)

    window.api.pty.getBuffer(sid).then((buf) => {
      if (!buf || browserOpenRef.current) return
      DEV_SERVER_URL_PATTERN.lastIndex = 0
      const match = buf.match(DEV_SERVER_URL_PATTERN)
      if (match) {
        const url = match[match.length - 1].replace('0.0.0.0', 'localhost')
        handleUrl(url)
      }
    })

    return unsub
  }, [task?.id, subscribeDevServer, getMainSessionId])

  useEffect(() => {
    if (panelVisibility.browser) setDetectedDevUrl(null)
  }, [panelVisibility.browser])

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
    if (!project?.path) { setProjectPathMissing(false); return }
    const pathExists = window.api.files?.pathExists
    if (typeof pathExists !== 'function') return
    let cancelled = false
    pathExists(project.path).then((exists) => { if (!cancelled) setProjectPathMissing(!exists) })
    return () => { cancelled = true }
  }, [project?.path])

  // Handle session ID creation from terminal — persist to DB only.
  // Don't setTask/onTaskUpdated: the conversation ID is internal terminal state.
  // Updating task state here would change the conversationId prop flowing back into
  // Terminal, causing initTerminal to re-run (detach + reattach), which loses focus.
  // The DB write is sufficient — the value is read back on future task loads.
  const handleSessionCreated = useCallback(
    (sessionId: string) => {
      if (!task) return
      if (window.api.app.isPlaywright) return
      void window.api.db.updateTask({
        id: task.id,
        providerConfig: setProviderConversationId(task.provider_config, task.terminal_mode, sessionId)
      })
    },
    [task]
  )

  // Handle terminal ready - memoized to prevent effect cascade
  const handleTerminalReady = useCallback((api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => {
    terminalApiRef.current = api
  }, [])

  const handleTerminalFocusRequestHandled = useCallback((requestId: number): void => {
    onTerminalFocusRequestHandled?.(taskId, requestId)
  }, [onTerminalFocusRequestHandled, taskId])


  // Session ID discovery: providers that don't support --session-id at creation
  const sessionIdCommand = task ? SESSION_ID_COMMANDS[task.terminal_mode] : undefined
  const showSessionBanner = !!sessionIdCommand && !!task && !getProviderConversationId(task.provider_config, task.terminal_mode) && !detectedSessionId

  // Providers where session ID detection is not possible
  const sessionIdUnavailable = !!task && SESSION_ID_UNAVAILABLE.includes(task.terminal_mode)
  const [sessionUnavailableDismissed, setSessionUnavailableDismissed] = useState<string | null>(null)
  const showUnavailableBanner = sessionIdUnavailable && !getProviderConversationId(task?.provider_config, task?.terminal_mode ?? '') && sessionUnavailableDismissed !== task?.id

  const handleDetectSessionId = useCallback(async () => {
    if (!task || !sessionIdCommand) return
    const sid = getMainSessionId(task.id)
    const exists = await window.api.pty.exists(sid)
    if (!exists) return
    await window.api.pty.write(sid, sessionIdCommand + '\r')
  }, [task, sessionIdCommand, getMainSessionId])

  const getConversationIdForMode = useCallback((t: Task): string | null => {
    return getProviderConversationId(t.provider_config, t.terminal_mode)
  }, [])

  // Subscribe to session detected events
  useEffect(() => {
    if (!task) return
    return subscribeSessionDetected(getMainSessionId(task.id), (id) => {
      const current = getConversationIdForMode(task)
      if (id !== current) {
        setDetectedSessionId(id)
      }
    })
  }, [task, subscribeSessionDetected, getMainSessionId, getConversationIdForMode])

  // Update DB with detected session ID
  const handleUpdateSessionId = useCallback(async () => {
    if (!task || !detectedSessionId) return
    const updated = await window.api.db.updateTask({
      id: task.id,
      providerConfig: setProviderConversationId(task.provider_config, task.terminal_mode, detectedSessionId)
    })
    onTaskUpdated(updated)
    setDetectedSessionId(null)
  }, [task, detectedSessionId, onTaskUpdated])

  const handleUpdateSessionIdRef = useRef(handleUpdateSessionId)
  useEffect(() => { handleUpdateSessionIdRef.current = handleUpdateSessionId }, [handleUpdateSessionId])

  // Cmd+Shift+U: sync detected session ID to DB (only when this task is active and banner is showing)
  useEffect(() => {
    if (!shortcutActive) return
    return window.api.app.onSyncSessionId(() => { void handleUpdateSessionIdRef.current() })
  }, [shortcutActive])

  // Persist detected conversation IDs immediately for modes that need session discovery.
  useEffect(() => {
    if (!task || !detectedSessionId || !sessionIdCommand) return
    if (getConversationIdForMode(task) === detectedSessionId) {
      setDetectedSessionId(null)
      return
    }

    let cancelled = false
    void (async () => {
      const updated = await window.api.db.updateTask({
        id: task.id,
        providerConfig: setProviderConversationId(task.provider_config, task.terminal_mode, detectedSessionId)
      })
      if (cancelled) return
      onTaskUpdated(updated)
      setDetectedSessionId(null)
    })()

    return () => {
      cancelled = true
    }
  }, [task, detectedSessionId, sessionIdCommand, onTaskUpdated, getConversationIdForMode])

  // Handle invalid session (e.g., "No conversation found" error)
  const handleSessionInvalid = useCallback(async () => {
    if (!task) return
    const mainSessionId = getMainSessionId(task.id)

    // Clear the stale session ID from the database
    const updated = await window.api.db.updateTask({
      id: task.id,
      providerConfig: setProviderConversationId(task.provider_config, task.terminal_mode, null)
    })
    onTaskUpdated(updated)

    // Kill the current PTY so we can restart fresh
    await window.api.pty.kill(mainSessionId)
  }, [task, onTaskUpdated, getMainSessionId])

  // Restart terminal (kill PTY, remount, keep session for --resume)
  const handleRestartTerminal = useCallback(async () => {
    if (!task) return
    const mainSessionId = getMainSessionId(task.id)
    resetTaskState(mainSessionId)
    await window.api.pty.kill(mainSessionId)
    await new Promise((r) => setTimeout(r, 100))
    markSkipCache(mainSessionId)
    setTerminalKey((k) => k + 1)
  }, [task, resetTaskState, getMainSessionId])

  // Reset terminal (kill PTY, clear session ID, remount fresh)
  const handleResetTerminal = useCallback(async () => {
    if (!task) return
    const mainSessionId = getMainSessionId(task.id)
    resetTaskState(mainSessionId)
    await window.api.pty.kill(mainSessionId)
    // Clear session ID so new session starts fresh
    const updated = await window.api.db.updateTask({
      id: task.id,
      providerConfig: setProviderConversationId(task.provider_config, task.terminal_mode, null)
    })
    onTaskUpdated(updated)
    await new Promise((r) => setTimeout(r, 100))
    markSkipCache(mainSessionId)
    setTerminalKey((k) => k + 1)
  }, [task, resetTaskState, onTaskUpdated, getMainSessionId])

  // Doctor: validate CLI binary and dependencies
  const handleDoctor = useCallback(async () => {
    if (!task) return
    setDoctorLoading(true)
    setDoctorResults(null)
    setDoctorDialogOpen(true)
    try {
      const results = await window.api.pty.validate(task.terminal_mode)
      setDoctorResults(results)
    } catch {
      setDoctorResults([{ check: 'Validation', ok: false, detail: 'Failed to run checks' }])
    } finally {
      setDoctorLoading(false)
    }
  }, [task])

  // Re-attach terminal (remount without killing PTY - reuses cached terminal)
  const handleReattachTerminal = useCallback(() => {
    if (!task) return
    setTerminalKey((k) => k + 1)
  }, [task])

  // Sync Claude session name with task title
  const handleSyncSessionName = useCallback(async () => {
    if (!task || !terminalApiRef.current) return
    await terminalApiRef.current.sendInput(`/rename ${task.title}\r`)
  }, [task])

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

  const handleInsertElementSnippet = useCallback(async (snippet: string) => {
    if (!task) return
    const text = snippet.trim()
    if (!text) return
    const mainSessionId = `${task.id}:${task.id}`
    await window.api.pty.write(mainSessionId, text)
  }, [task])

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
  useEffect(() => { browserTabsRef.current = browserTabs }, [browserTabs])

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
      } else if (target?.closest('.cm-editor')) {
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
        const closed = await terminalContainerRef.current?.closeActiveGroup() ?? true
        if (closed) return
      } else if (panel === 'editor') {
        const closed = fileEditorRef.current?.closeActiveFile()
        if (closed) return
      } else if (panel === 'browser') {
        const bt = browserTabsRef.current
        if (bt.tabs.length > 1) {
          const idx = bt.tabs.findIndex(t => t.id === bt.activeTabId)
          const newTabs = bt.tabs.filter(t => t.id !== bt.activeTabId)
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
    const modeInfo = modes.find(m => m.id === task.terminal_mode)
    const defaultFlags = modeInfo?.defaultFlags ?? ''
    setFlagsInputValue(defaultFlags)
    await handleFlagsSave(defaultFlags)
  }, [task, modes, handleFlagsSave])

  useEffect(() => {
    if (!task) return
    setFlagsInputValue(getProviderFlagsForMode(task))
    setIsEditingFlags(false)
  }, [task, getProviderFlagsForMode])

  useEffect(() => {
    if (!isEditingFlags) return
    requestAnimationFrame(() => {
      flagsInputRef.current?.focus()
      flagsInputRef.current?.select()
    })
  }, [isEditingFlags])

  // Handle panel visibility toggle
  const handlePanelToggle = useCallback(
    async (panelId: string, active: boolean) => {
      if (!task) return
      track('panel_toggled', { panel: panelId, active, context: 'task' })
      // Reset panel size to default when opening
      if (active) resetPanelSize(panelId)
      const newVisibility = { ...panelVisibility, [panelId]: active }
      setPanelVisibility(newVisibility)
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
      // Persist to DB
      const updated = await window.api.db.updateTask({
        id: task.id,
        panelVisibility: newVisibility
      })
      onTaskUpdated(updated)
    },
    [task, panelVisibility, onTaskUpdated, resetPanelSize]
  )
  handlePanelToggleRef.current = handlePanelToggle

  const openAssetRef = useRef<(taskId: string, assetId: string) => void>(() => {})
  openAssetRef.current = (targetTaskId, assetId) => {
    if (!task || targetTaskId !== task.id) return
    if (!panelVisibility.assets) handlePanelToggle('assets', true)
    assetsPanelRef.current?.selectAsset(assetId)
  }
  useEffect(() => window.api.app.onOpenAsset((tid, aid) => openAssetRef.current(tid, aid)), [])

  const handleQuickOpenFile = useCallback((filePath: string, options?: OpenFileOptions) => {
    if (fileEditorRef.current) {
      fileEditorRef.current.openFile(filePath, options)
    } else {
      pendingEditorFileRef.current = filePath
      handlePanelToggle('editor', true)
    }
  }, [handlePanelToggle])

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
      if (matchesShortcut(e, keys('browser-element-picker')) && isBuiltinEnabled('browser', 'task') && panelVisibility.browser) {
        e.preventDefault()
        browserPanelRef.current?.pickElement()
        return
      }
      if (matchesShortcut(e, keys('browser-focus-url')) && isBuiltinEnabled('browser', 'task') && panelVisibility.browser) {
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
      if (matchesShortcut(e, keys('browser-new-tab')) && panelVisibility.browser && isBuiltinEnabled('browser', 'task')) {
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
      if (matchesShortcut(e, keys('panel-assets')) && isBuiltinEnabled('assets', 'task')) {
        e.preventDefault()
        handlePanelToggle('assets', !panelVisibility.assets)
        return
      }
      // Skip shortcuts inside CodeMirror / contenteditable so editor bindings (e.g. Mod+B) win
      const target = e.target as HTMLElement
      const inEditor = target?.closest?.('[contenteditable="true"]')
      const inCodeMirror = target?.closest?.('.cm-editor')
      if (inCodeMirror) return

      if (matchesShortcut(e, keys('panel-browser')) && !inEditor && isBuiltinEnabled('browser', 'task')) {
        e.preventDefault()
        handlePanelToggle('browser', !panelVisibility.browser)
      } else if (matchesShortcut(e, keys('panel-settings')) && isBuiltinEnabled('settings', 'task')) {
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
  }, [shortcutActive, panelVisibility, handlePanelToggle, isBuiltinEnabled, enabledWebPanels, buildTaskFileContext])

  // Focus and select title input when editing
  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [editingTitle])

  const handleTitleSave = async (): Promise<void> => {
    if (!task || titleValue === task.title) {
      setEditingTitle(false)
      return
    }

    const updated = await window.api.db.updateTask({
      id: task.id,
      title: titleValue
    })
    onTaskUpdated(updated)
    setEditingTitle(false)
  }

  const handleTitleKeyDown = async (e: React.KeyboardEvent): Promise<void> => {
    if (e.key === 'Enter') {
      await handleTitleSave()
    } else if (e.key === 'Escape') {
      setTitleValue(task?.title ?? '')
      setEditingTitle(false)
      titleInputRef.current?.blur()
    }
  }

  const handleDescriptionSave = async (): Promise<void> => {
    if (!task || !descriptionDirty.current) return
    descriptionDirty.current = false

    const updated = await window.api.db.updateTask({
      id: task.id,
      description: descriptionValue || undefined,
    })
    onTaskUpdated(updated)
  }


  const handleCreateSubTask = async (): Promise<void> => {
    if (!task || !subTaskTitle.trim()) return
    await createSubTask({
      projectId: task.project_id,
      title: subTaskTitle.trim(),
      status: getDefaultStatus(project?.columns_config),
    })
    setSubTaskTitle('')
    setAddingSubTask(false)
  }

  const subTaskSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const handleTaskUpdate = (updated: Task): void => {
    setTitleValue(updated.title)
    setDescriptionValue(updated.description ?? '')
    onTaskUpdated(updated)
  }

  const applyTemplate = useCallback(async (template: TaskTemplate) => {
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
      setTerminalKey(k => k + 1)
    }
  }, [task, getMainSessionId, resetTaskState])

  // Wrapper for GitPanel that calls API and notifies parent
  const updateTaskAndNotify = async (data: { id: string; worktreePath?: string | null; worktreeParentBranch?: string | null; baseDir?: string | null; browserUrl?: string | null; status?: Task['status'] }): Promise<Task> => {
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
      setTerminalKey(k => k + 1)
    }

    return updated
  }

  // Handler for browser tabs changes
  const handleBrowserTabsChange = useCallback(async (tabs: BrowserTabsState) => {
    setBrowserTabs(tabs)
    if (!task) return
    // Persist to DB (debounced via the tab state itself)
    await window.api.db.updateTask({
      id: task.id,
      browserTabs: tabs
    })
  }, [task])

  // Web panel URL persistence — use ref to avoid stale closures
  const webPanelUrlsRef = useRef<Record<string, string>>({})
  const webPanelUrlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const taskIdRef = useRef<string | null>(null)

  // Flush any pending URL save (fire-and-forget)
  const flushPendingUrlSave = useCallback(() => {
    if (webPanelUrlTimerRef.current) {
      clearTimeout(webPanelUrlTimerRef.current)
      webPanelUrlTimerRef.current = null
      if (taskIdRef.current && Object.keys(webPanelUrlsRef.current).length > 0) {
        window.api.db.updateTask({
          id: taskIdRef.current,
          webPanelUrls: { ...webPanelUrlsRef.current }
        })
      }
    }
  }, [])

  // Active asset persistence — debounced, ref-based
  const activeAssetIdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPendingActiveAssetSave = useCallback(() => {
    if (activeAssetIdTimerRef.current) {
      clearTimeout(activeAssetIdTimerRef.current)
      activeAssetIdTimerRef.current = null
    }
  }, [])

  const handleActiveAssetIdChange = useCallback((id: string | null) => {
    if (activeAssetIdTimerRef.current) clearTimeout(activeAssetIdTimerRef.current)
    const taskId = taskIdRef.current
    activeAssetIdTimerRef.current = setTimeout(async () => {
      if (!taskId) return
      await window.api.db.updateTask({ id: taskId, activeAssetId: id })
    }, 500)
  }, [])

  // Editor open files persistence — debounced, ref-based (same pattern as webPanelUrls)
  const editorStateRef = useRef<EditorOpenFilesState | null>(null)
  const editorStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPendingEditorSave = useCallback(() => {
    if (editorStateTimerRef.current) {
      clearTimeout(editorStateTimerRef.current)
      editorStateTimerRef.current = null
      if (taskIdRef.current && editorStateRef.current) {
        window.api.db.updateTask({
          id: taskIdRef.current,
          editorOpenFiles: editorStateRef.current
        })
      }
    }
  }, [])

  // Initialize from task on load — flush old task's pending saves first
  useEffect(() => {
    flushPendingUrlSave()
    flushPendingEditorSave()
    flushPendingActiveAssetSave()
    taskIdRef.current = task?.id ?? null
    if (task?.web_panel_urls) webPanelUrlsRef.current = { ...task.web_panel_urls }
    else webPanelUrlsRef.current = {}
  }, [task?.id, flushPendingUrlSave, flushPendingEditorSave, flushPendingActiveAssetSave])

  // Flush pending saves on unmount
  useEffect(() => {
    return () => { flushPendingUrlSave(); flushPendingEditorSave(); flushPendingActiveAssetSave() }
  }, [flushPendingUrlSave, flushPendingEditorSave])

  const handleWebPanelUrlChange = useCallback((panelId: string, url: string) => {
    if (!taskIdRef.current) return
    webPanelUrlsRef.current = { ...webPanelUrlsRef.current, [panelId]: url }
    if (webPanelUrlTimerRef.current) clearTimeout(webPanelUrlTimerRef.current)
    const id = taskIdRef.current
    const urlSnapshot = { ...webPanelUrlsRef.current }
    webPanelUrlTimerRef.current = setTimeout(async () => {
      await window.api.db.updateTask({
        id,
        webPanelUrls: urlSnapshot
      })
    }, 500)
  }, [])

  const handleEditorStateChange = useCallback((state: EditorOpenFilesState) => {
    editorStateRef.current = state
    if (editorStateTimerRef.current) clearTimeout(editorStateTimerRef.current)
    const id = taskIdRef.current
    editorStateTimerRef.current = setTimeout(async () => {
      if (!id) return
      await window.api.db.updateTask({
        id,
        editorOpenFiles: state
      })
    }, 500)
  }, [])

  // Handle web panel favicon change
  const handleWebPanelFaviconChange = useCallback((_panelId: string, _favicon: string) => {
    // Favicon caching — no-op for now, auto-fetched by webview on each load
  }, [])

  // Open a dev server URL in the browser panel (used by both auto-open and toast)
  const openDevServerInBrowser = useCallback((url: string) => {
    handlePanelToggle('browser', true)
    const newTab = { id: `tab-${crypto.randomUUID().slice(0, 8)}`, url, title: url }
    if (browserOpenRef.current) {
      handleBrowserTabsChange({ tabs: [...browserTabs.tabs, newTab], activeTabId: newTab.id })
    } else {
      handleBrowserTabsChange({ tabs: [newTab], activeTabId: newTab.id })
    }
  }, [handlePanelToggle, handleBrowserTabsChange, browserTabs])

  useEffect(() => {
    devServerAutoOpenCallbackRef.current = openDevServerInBrowser
  }, [openDevServerInBrowser])

  // CLI: open browser panel when requested by main process (slay tasks browser --panel=visible)
  useEffect(() => {
    if (!isActive || !task) return
    return window.api.app.onBrowserEnsurePanelOpen((taskId, url) => {
      if (taskId !== task.id) return
      if (url) {
        openDevServerInBrowser(url)
      } else {
        handlePanelToggle('browser', true)
      }
    })
  }, [isActive, task?.id, openDevServerInBrowser, handlePanelToggle])

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
    onBack()
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

  const visiblePanelCount = [...BUILTIN_PANEL_IDS, ...enabledWebPanels.map((wp) => wp.id)]
    .filter((panelId) => !!panelVisibility[panelId]).length
  const hasVisiblePanels = visiblePanelCount > 0
  const multipleVisiblePanels = visiblePanelCount > 1

  return (
    <div id="task-detail" className={cn("h-full flex flex-col", compact ? "p-0" : "gap-4")}>
      {compact && (
        <div className="shrink-0 flex items-center gap-1.5 px-2 h-10 bg-surface-1 border-b border-border min-w-0">
          {!task.is_temporary && (() => {
            const statusStyle = getColumnStatusStyle(task.status, project?.columns_config)
            if (!statusStyle) return null
            const StatusIcon = statusStyle.icon
            return (
              <Popover open={statusPopoverOpen} onOpenChange={setStatusPopoverOpen}>
                <PopoverTrigger asChild>
                  <button type="button" className="shrink-0 cursor-pointer transition-opacity hover:opacity-70">
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
                        className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm cursor-pointer hover:bg-accent', isCurrent && 'bg-accent font-medium')}
                        onClick={async () => {
                          const updated = await window.api.db.updateTask({ id: task.id, status: opt.value })
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
                <button type="button" className="shrink-0 inline-flex items-center rounded-full bg-muted/50 px-1.5 py-0.5 cursor-pointer transition-colors hover:bg-muted">
                  <PriorityIcon priority={task.priority} className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[140px] p-1" align="end">
                {priorityOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-xs cursor-pointer hover:bg-accent', opt.value === task.priority && 'bg-accent font-medium')}
                    onClick={async () => {
                      const updated = await window.api.db.updateTask({ id: task.id, priority: opt.value })
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
      {!compact && !zenMode && <header className="shrink-0 relative">
        <div>
          <div className="flex items-center justify-between gap-4 window-no-drag">
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
                            <DropdownMenuItem key={t.id} className="items-baseline gap-2.5" onClick={() => applyTemplate(t)}>
                              <span className="text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
                              {t.name}{t.is_default ? ' ♦' : ''}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              </div>
            ) : (<div className="flex items-center gap-2 shrink-0">
              {(() => {
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
                        <StatusIcon className={cn('size-5', statusStyle.iconClass)} strokeWidth={3} />
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
                              const updated = await window.api.db.updateTask({ id: task.id, status: opt.value })
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
            </div>)}

            {task.linear_url && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); window.api.shell.openExternal(task.linear_url!) }}
                    className="shrink-0 rounded bg-indigo-500/10 px-1.5 py-0.5 text-xs font-semibold text-indigo-600 hover:bg-indigo-500/20 dark:text-indigo-400"
                  >
                    Linear
                  </a>
                </TooltipTrigger>
                <TooltipContent>Open in Linear</TooltipContent>
              </Tooltip>
            )}


            <div className="min-w-0">
              <PanelToggle
                panels={(() => {
                  const builtins: { id: string; icon: typeof Globe; label: string; shortcut?: string | null }[] = [
                    { id: 'terminal', icon: TerminalIcon, label: 'Terminal', shortcut: panelTerminalShortcut },
                    { id: 'browser', icon: Globe, label: 'Browser', shortcut: panelBrowserShortcut },
                    { id: 'editor', icon: FileCode, label: 'Editor', shortcut: panelEditorShortcut },
                    { id: 'assets', icon: Paperclip, label: 'Assets', shortcut: panelAssetsShortcut },
                    { id: 'diff', icon: GitBranch, label: 'Git', shortcut: panelGitShortcut },
                    { id: 'processes', icon: Cpu, label: 'Processes', shortcut: panelProcessesShortcut },
                    { id: 'settings', icon: Settings2, label: 'Settings', shortcut: panelSettingsShortcut },
                  ].filter(p => isBuiltinEnabled(p.id, 'task') && !(task.is_temporary && p.id === 'settings'))

                  // Insert web panels after editor
                  const editorIdx = builtins.findIndex(p => p.id === 'editor')
                  const webItems = enabledWebPanels.map(wp => ({
                    id: wp.id,
                    icon: Globe,
                    label: wp.name,
                    shortcut: wp.shortcut ? `⌘${wp.shortcut.toUpperCase()}` : undefined
                  }))
                  const insertIdx = editorIdx >= 0 ? editorIdx + 1 : builtins.length
                  builtins.splice(insertIdx, 0, ...webItems)

                  return builtins.map(p => ({ ...p, active: !!panelVisibility[p.id] }))
                })()}
                onChange={handlePanelToggle}
              />
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
      </header>}

      {/* Dev server detected toast */}
      {!compact && <DevServerToast
        url={detectedDevUrl}
        onOpen={() => {
          if (!detectedDevUrl) return
          openDevServerInBrowser(detectedDevUrl)
          setDetectedDevUrl(null)
        }}
        onDismiss={() => setDetectedDevUrl(null)}
      />}

      {/* Split view: terminal | browser | settings | git diff */}
      <div id="task-panels" ref={splitContainerRef} className="flex-1 flex min-h-0">
        {!compact && !hasVisiblePanels && (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-full max-w-xl min-h-52 rounded-lg border border-border bg-surface-3 px-5 py-7 text-center flex flex-col items-center justify-center">
              <p className="text-2xl font-semibold">No panel tab is shown</p>
              <p className="mt-3 text-base text-muted-foreground">Use the panel tabs in the header to open one.</p>
            </div>
          </div>
        )}

        {/* Terminal Panel */}
        {(compact || panelVisibility.terminal) && (
        <div
          data-panel-id="terminal"
          className={cn(
            "min-w-0 shrink-0 overflow-hidden flex flex-col transition-shadow duration-200",
            !compact && "rounded-md bg-surface-1 border border-border",
            !compact && multipleVisiblePanels && focusedPanel === 'terminal' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]"
          )}
          style={compact ? { flex: 1 } : containerWidth > 0 ? { width: resolvedWidths.terminal } : { flex: 1 }}
        >
          {projectPathMissing && project?.path && (
            <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span className="text-sm text-amber-500">
                Project path not found: <code className="bg-amber-500/10 px-1 rounded">{project.path}</code>
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
                <kbd className="ml-2 opacity-70" style={{ fontFamily: 'system-ui' }}>{syncSessionIdShortcut}</kbd>
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
                  The AI provider's session ID hasn't been captured yet. Without it, closing and reopening this task will start a fresh conversation instead of resuming. Click "Run {sessionIdCommand}" to detect it automatically.
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
                Session ID detection not available for this provider — don't close the tab or resume won't work. Providers with resume: Claude Code, Codex, Gemini, Qwen, Copilot
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
            <SlayNudgeBanner projectPath={effectiveRepoPath ?? project?.path ?? ''} onDismiss={dismissSlayNudge} onSetupComplete={recheckSlayNudge} />
          )}
          {/* Terminal + mode bar wrapper */}
          <div className="flex-1 min-h-0 overflow-hidden">
              {isResizing ? (
                <div className="h-full bg-black" />
              ) : (effectiveRepoPath || project?.path) && !projectPathMissing ? (
                <TerminalContainer
                  ref={terminalContainerRef}
                  key={`${terminalKey}-${task.project_id}-${effectiveRepoPath || ''}-${task.worktree_path || ''}-${task.base_dir || ''}`}
                  taskId={task.id}
                  isActive={isActive}
                  hasShortcutFocus={shortcutActive}
                  cwd={effectiveRepoPath || project?.path || ''}
                  defaultMode={task.terminal_mode}
                  conversationId={getConversationIdForMode(task) || undefined}
                  existingConversationId={getConversationIdForMode(task) || undefined}
                  supportsSessionId={modes.find(m => m.id === task.terminal_mode)?.initialCommand?.includes('{id}') ?? false}
                  initialPrompt={getQuickRunPrompt(task.id)}
                  providerFlags={getProviderFlagsForMode(task)}
                  executionContext={project?.execution_context}
                  focusRequestId={terminalFocusRequestId}
                  onConversationCreated={handleSessionCreated}
                  onSessionInvalid={handleSessionInvalid}
                  onReady={handleTerminalReady}
                  onRetry={handleRestartTerminal}
                  onFocusRequestHandled={handleTerminalFocusRequestHandled}
                  onMainTabActiveChange={setIsMainTabActive}
                  onMainDisplayModeChange={setMainTabDisplayMode}
                  onOpenUrl={openDevServerInBrowser}
                  onOpenFile={handleQuickOpenFile}
                  onMainReset={handleResetTerminal}
                  overlay={isActive && loopConfigured ? (
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
                  ) : undefined}
                  rightContent={
                    <Tooltip open={!isMainTabActive && !task.is_temporary ? undefined : false}>
                      <TooltipTrigger asChild>
                        <div className={cn(
                          "flex items-center gap-2 transition-opacity",
                          !isMainTabActive && !task.is_temporary && "opacity-40 pointer-events-none"
                        )}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                          <Select
                            value={task.terminal_mode}
                            onValueChange={(value) => {
                              if (modes.some(m => m.id === value)) handleModeChange(value as TerminalMode)
                            }}
                          >
                            <SelectTrigger
                              data-testid="terminal-mode-trigger"
                              size="sm"
                              className="min-w-32 !h-7 py-0 text-xs"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent position="popper" className="min-w-[var(--radix-select-trigger-width)] max-h-none">
                              {(() => {
                                const visibleModes = getVisibleModes(modes, task.terminal_mode)
                                const { builtin, custom } = groupTerminalModes(visibleModes)
                                return (
                                  <>
                                    {builtin.map(mode => (
                                      <SelectItem key={mode.id} value={mode.id}>
                                        {getModeLabel(mode)}
                                      </SelectItem>
                                    ))}
                                    {custom.length > 0 && builtin.length > 0 && <SelectSeparator />}
                                    {custom.map(mode => (
                                      <SelectItem key={mode.id} value={mode.id}>
                                        {getModeLabel(mode)}
                                      </SelectItem>
                                    ))}
                                  </>
                                )
                              })()}
                            </SelectContent>
                          </Select>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                              AI provider for this task. Each provider tracks its own conversation history separately.
                            </TooltipContent>
                          </Tooltip>

                          {task.terminal_mode === 'ccs' && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Select
                                  value={getProviderFlags(task.provider_config, 'ccs') || '__none__'}
                                  onValueChange={async (val) => {
                                    const profile = val === '__none__' ? '' : val
                                    const updated = await window.api.db.updateTask({
                                      id: task.id,
                                      providerConfig: setProviderFlags(task.provider_config, 'ccs', profile)
                                    })
                                    if (updated) {
                                      onTaskUpdated(updated)
                                    }
                                  }}
                                >
                                  <SelectTrigger className="h-7 text-xs w-28">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none__">Default</SelectItem>
                                    {ccsProfiles.map((p) => (
                                      <SelectItem key={p} value={p}>{p}</SelectItem>
                                    ))}
                                    {(() => {
                                      const currentProfile = getProviderFlags(task.provider_config, 'ccs')
                                      return currentProfile && !ccsProfiles.includes(currentProfile) ? (
                                        <SelectItem value={currentProfile}>{currentProfile}</SelectItem>
                                      ) : null
                                    })()}
                                  </SelectContent>
                                </Select>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">
                                CCS profile
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {task.terminal_mode !== 'ccs' && (
                            isEditingFlags ? (
                              <Input
                                ref={flagsInputRef}
                                value={flagsInputValue}
                                onChange={(e) => setFlagsInputValue(e.target.value)}
                                onBlur={() => {
                                  setIsEditingFlags(false)
                                  void handleFlagsSave(flagsInputValue)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    setIsEditingFlags(false)
                                    void handleFlagsSave(flagsInputValue)
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault()
                                    setFlagsInputValue(getProviderFlagsForMode(task))
                                    setIsEditingFlags(false)
                                  }
                                }}
                                placeholder="Flags"
                                className="h-7 text-xs w-72"
                              />
                            ) : (
                              flagsInputValue.trim().length === 0 ? (
                                <div className="flex items-center gap-2">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button variant="outline" size="sm" className="!h-7 !min-h-7 text-xs" onClick={() => setIsEditingFlags(true)}>
                                        Set flags
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom" className="max-w-64">
                                      CLI flags passed to the provider on startup (e.g. --no-cache). Overrides the defaults set in settings.
                                    </TooltipContent>
                                  </Tooltip>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button variant="outline" size="sm" className="!h-7 !min-h-7 text-xs" onClick={() => { void handleSetDefaultFlags() }}>
                                        Set default flags
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom" className="max-w-64">
                                      Copy the default flags from settings into this task.
                                    </TooltipContent>
                                  </Tooltip>
                                </div>
                              ) : (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div
                                      className="h-7 w-fit max-w-72 px-2 flex items-center cursor-pointer rounded hover:bg-muted/50"
                                      onClick={() => setIsEditingFlags(true)}
                                    >
                                      <div className="text-xs text-foreground dark:text-foreground truncate">
                                        {flagsInputValue}
                                      </div>
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent side="bottom" className="max-w-64">
                                    CLI flags for {task.terminal_mode}. Click to edit.
                                  </TooltipContent>
                                </Tooltip>
                              )
                            )
                          )}

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

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton data-testid="terminal-menu-trigger" variant="ghost" aria-label="Terminal menu" className="size-7">
                                <MoreHorizontal className="size-3.5" />
                              </IconButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-60">
                              {task.terminal_mode === 'claude-code' && (
                                <DropdownMenuItem onClick={handleSyncSessionName}>
                                  Sync name
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={handleInjectTitle}>
                                Inject title
                                <span className="ml-auto text-xs text-muted-foreground">{terminalInjectTitleShortcut}</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void handleInjectDescription()}>
                                Inject description
                                <span className="ml-auto text-xs text-muted-foreground">{terminalInjectDescShortcut}</span>
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
                                <span className="ml-auto pl-4 text-xs text-muted-foreground">{terminalRestartShortcut}</span>
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
                              {isChatSupported(task.terminal_mode) && mainTabDisplayMode !== 'chat' && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => setPendingChatEnable(true)}>
                                    Enable chat (beta)
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <ConfirmDisplayModeDialog
                            open={pendingChatEnable}
                            target="chat"
                            onConfirm={() => {
                              void terminalContainerRef.current?.setMainDisplayMode('chat')
                              setPendingChatEnable(false)
                            }}
                            onCancel={() => setPendingChatEnable(false)}
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>Switch to Main tab to use these controls</TooltipContent>
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
          </div>
        </div>
        )}

        {/* Non-terminal panels hidden in compact mode */}
        {!compact && panelVisibility.terminal && panelVisibility.browser && (
          <ResizeHandle
            width={resolvedWidths.browser ?? 200}
            minWidth={200}
            onWidthChange={(w) => updatePanelSizes({ browser: w })}
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
            onReset={resetAllPanels}
          />
        )}

        {/* Browser Panel */}
        {!compact && panelVisibility.browser && (
          <div data-panel-id="browser" className={cn("shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'browser' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.browser }}>
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
          </div>
        )}

        {/* Resize handle: Browser | Editor or Terminal | Editor */}
        {!compact && panelVisibility.editor && (panelVisibility.browser || panelVisibility.terminal) && (
          <ResizeHandle
            width={resolvedWidths.editor ?? 250}
            minWidth={250}
            onWidthChange={(w) => updatePanelSizes({ editor: w })}
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
            onReset={resetAllPanels}
          />
        )}

        {/* File Editor Panel */}
        {!compact && panelVisibility.editor && effectiveRepoPath && (
          <div data-panel-id="editor" className={cn("shrink-0 overflow-hidden rounded-md bg-surface-1 border border-border transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'editor' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.editor }}>
            <FileEditorView
              ref={fileEditorRefCallback}
              projectPath={effectiveRepoPath}
              initialEditorState={task.editor_open_files}
              onEditorStateChange={handleEditorStateChange}
            />
          </div>
        )}

        {/* Resize handle: ... | Assets */}
        {!compact && panelVisibility.assets && (panelVisibility.terminal || panelVisibility.browser || panelVisibility.editor) && (
          <ResizeHandle
            width={resolvedWidths.assets ?? 300}
            minWidth={200}
            onWidthChange={(w) => updatePanelSizes({ assets: w })}
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
            onReset={resetAllPanels}
          />
        )}

        {/* Assets Panel */}
        {!compact && panelVisibility.assets && (
          <div data-panel-id="assets" className={cn("shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden flex flex-col transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'assets' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.assets }}>
            <AssetsPanel ref={assetsPanelRef} taskId={task.id} isResizing={isResizing} initialActiveAssetId={task.active_asset_id} onActiveAssetIdChange={handleActiveAssetIdChange} />
          </div>
        )}

        {/* Web Panels (custom + predefined) — rendered between editor and diff */}
        {!compact && enabledWebPanels.map((wp, idx) => {
          if (!panelVisibility[wp.id]) return null
          // Show resize handle if there's a visible panel before this one
          const hasLeftNeighbor = panelVisibility.terminal || panelVisibility.browser || panelVisibility.editor || panelVisibility.assets ||
            enabledWebPanels.slice(0, idx).some(prev => panelVisibility[prev.id])
          return (
            <div key={wp.id} className="contents">
              {hasLeftNeighbor && (
                <ResizeHandle
                  width={resolvedWidths[wp.id] ?? 200}
                  minWidth={200}
                  onWidthChange={(w) => updatePanelSizes({ [wp.id]: w })}
                  onDragStart={() => setIsResizing(true)}
                  onDragEnd={() => setIsResizing(false)}
                  onReset={resetAllPanels}
                />
              )}
              <div data-panel-id={wp.id} className={cn("shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden transition-shadow duration-200", multipleVisiblePanels && focusedPanel === wp.id && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths[wp.id] }}>
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
              </div>
            </div>
          )
        })}

        {/* Resize handle: Editor/WebPanels | Diff or Browser | Diff or Terminal | Diff */}
        {!compact && panelVisibility.diff && (panelVisibility.editor || panelVisibility.browser || panelVisibility.terminal || enabledWebPanels.some(wp => panelVisibility[wp.id])) && (
          <ResizeHandle
            width={resolvedWidths.diff ?? 50}
            minWidth={50}
            onWidthChange={(w) => updatePanelSizes({ diff: w })}
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
            onReset={resetAllPanels}
          />
        )}

        {/* Git Panel */}
        {!compact && panelVisibility.diff && (
          <div data-panel-id="diff" data-testid="task-git-panel" className={cn("shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden flex flex-col transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'diff' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.diff }}>
            <UnifiedGitPanel
              ref={gitPanelRef}
              task={task}
              projectId={task.project_id}
              projectPath={resolvedRepo.path}
              completedStatus={completedStatus}
              visible={panelVisibility.diff}
              defaultTab={gitDefaultTab}
              pollIntervalMs={5000}
              onUpdateTask={updateTaskAndNotify}
              onTaskUpdated={handleTaskUpdate}
              detectedRepos={detectedRepos}
              selectedRepoName={task.repo_name}
              isRepoStale={resolvedRepo.stale}
              onRepoChange={handleRepoChange}
            />
          </div>
        )}

        {/* Resize handle: Diff | Settings or Editor | Settings or ... */}
        {!compact && panelVisibility.settings && (panelVisibility.diff || panelVisibility.editor || panelVisibility.browser || panelVisibility.terminal || enabledWebPanels.some(wp => panelVisibility[wp.id])) && (
          <ResizeHandle
            width={resolvedWidths.settings ?? 440}
            minWidth={200}
            onWidthChange={(w) => updatePanelSizes({ settings: w })}
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
            onReset={resetAllPanels}
          />
        )}

        {/* Settings Panel */}
        {!compact && panelVisibility.settings && (
        <div data-panel-id="settings" data-testid="task-settings-panel" className={cn("shrink-0 rounded-md bg-surface-1 border border-border p-3 flex flex-col gap-4 overflow-y-auto transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'settings' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.settings }}>
          <TaskSettingsPanel
            taskId={task.id}
            renderDefaultContent={() => (
              <>

          {/* External sync links */}
          <ExternalSyncCard taskId={task.id} onUpdate={handleTaskUpdate} />

          {/* Description */}
          <Collapsible open={descriptionOpen} onOpenChange={setDescriptionOpen} className={cn("flex flex-col rounded-md border border-border overflow-hidden", descriptionExpanded && descriptionOpen ? "min-h-0 flex-1" : "shrink-0")}>
            <div className={cn("flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground", descriptionOpen && "border-b border-border")}>
              <CollapsibleTrigger className="flex items-center gap-1.5 hover:text-foreground transition-colors [&[data-state=open]>svg:first-child]:rotate-90">
                <ChevronRight className="size-3 transition-transform" />
                Description
              </CollapsibleTrigger>
              <div className="ml-auto flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton type="button" variant="ghost" aria-label={descriptionExpanded ? "Default height" : "Full height"} className={cn("size-5 hover:text-foreground", descriptionExpanded ? "text-foreground bg-muted" : "text-muted-foreground")} onClick={() => setDescriptionExpanded((v) => { if (!v) { setDetailsOpen(false); setSubTasksOpen(false); setAssetsOpen(false) } else { setDetailsOpen(true); setSubTasksOpen(true); setAssetsOpen(true) } return !v })}>
                      <IconArrowsVertical size={12} />
                    </IconButton>
                  </TooltipTrigger>
                  <TooltipContent>{descriptionExpanded ? "Default height" : "Full height"}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton type="button" variant="ghost" aria-label="Fullscreen" className="size-5 text-muted-foreground hover:text-foreground" onClick={() => setDescriptionFullscreen(true)}>
                      <IconArrowsMaximize size={12} />
                    </IconButton>
                  </TooltipTrigger>
                  <TooltipContent>Fullscreen</TooltipContent>
                </Tooltip>
              </div>
            </div>
            {descriptionOpen && (
              <div className={cn("flex flex-col min-h-0 flex-1", !descriptionExpanded && "min-h-[150px] max-h-[300px]")}>
                <RichTextEditor
                  value={descriptionValue}
                  onChange={(md) => { descriptionDirty.current = true; setDescriptionValue(md) }}
                  onBlur={handleDescriptionSave}
                  placeholder="Add description..."
                  testId="task-description-editor"
                  variant="inline"
                  fontFamily={notesFontFamily}
                  checkedHighlight={notesCheckedHighlight}
                  showToolbar={notesShowToolbar}
                  spellcheck={notesSpellcheck}
                  themeColors={notesThemeColors}
                  assets={assets.map(a => ({ id: a.id, title: a.title, type: RENDER_MODE_INFO[getEffectiveRenderMode(a.title, a.render_mode)].label }))}
                  onAssetClick={(assetId) => {
                    if (!panelVisibility.assets) handlePanelToggle('assets', true)
                    assetsPanelRef.current?.selectAsset(assetId)
                  }}
                />
              </div>
            )}
          </Collapsible>

          {/* Sub-tasks */}
          <Collapsible open={subTasksOpen} onOpenChange={setSubTasksOpen} className={cn("group/sub rounded-md border border-border flex flex-col", subTasksOpen && !(descriptionExpanded && descriptionOpen) ? (subTasks.length > 5 ? "flex-1 min-h-0" : "shrink-0 min-h-[160px]") : "shrink-0")}>
            <div className="shrink-0 flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 min-h-8 text-xs font-medium text-muted-foreground group-data-[state=open]/sub:border-b border-border">
              <CollapsibleTrigger className="flex items-center gap-1.5 hover:text-foreground transition-colors [&[data-state=open]>svg:first-child]:rotate-90">
                <ChevronRight className="size-3 transition-transform" />
                Sub-tasks
              </CollapsibleTrigger>
              {subTasks.length > 0 && (
                <span className="ml-auto text-muted-foreground/60 text-[10px]">
                  {subTasks.filter((s) => isTerminalStatus(s.status, project?.columns_config ?? null)).length}/{subTasks.length}
                </span>
              )}
            </div>
            <CollapsibleContent className="p-2 flex-1 min-h-0 flex flex-col">
              <DndContext sensors={subTaskSensors} collisionDetection={closestCenter} onDragEnd={handleSubTaskDragEnd}>
              <SortableContext items={subTasks.map(s => s.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto overscroll-contain">
                {subTasks.map(sub => (
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
                        if (e.key === 'Enter') { e.preventDefault(); handleCreateSubTask() }
                        if (e.key === 'Escape') { setAddingSubTask(false); setSubTaskTitle('') }
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

          {/* Assets */}
          <Collapsible open={assetsOpen} onOpenChange={setAssetsOpen} className="group/assets shrink-0 rounded-md border border-border overflow-hidden">
            <div className="flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 min-h-8 text-xs font-medium text-muted-foreground group-data-[state=open]/assets:border-b border-border">
              <CollapsibleTrigger className="flex items-center gap-1.5 hover:text-foreground transition-colors [&[data-state=open]>svg:first-child]:rotate-90">
                <ChevronRight className="size-3 transition-transform" />
                Assets
              </CollapsibleTrigger>
              {assets.length > 0 && (
                <span className="ml-auto text-muted-foreground/60 text-[10px]">{assets.length}</span>
              )}
            </div>
            <CollapsibleContent className="p-2">
              <div className="flex flex-col gap-0.5 max-h-[30vh] overflow-y-auto overscroll-contain">
                {assets.map(asset => (
                  <button
                    key={asset.id}
                    type="button"
                    className="flex items-center gap-2 py-1 px-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 text-left"
                    onClick={() => {
                      if (!panelVisibility.assets) handlePanelToggle('assets', true)
                      assetsPanelRef.current?.selectAsset(asset.id)
                    }}
                  >
                    <Paperclip className="size-3 shrink-0" />
                    <span className="truncate">{asset.title}</span>
                    <span className="ml-auto text-[10px] opacity-60">{getExtensionFromTitle(asset.title) || 'file'}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    if (!panelVisibility.assets) handlePanelToggle('assets', true)
                    assetsPanelRef.current?.createAsset()
                  }}
                  className="flex items-center gap-1.5 py-1 px-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 mt-1"
                >
                  <Plus className="size-3" />
                  Add asset
                </button>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Details */}
          <Collapsible open={descriptionExpanded && descriptionOpen ? detailsOpen : true} onOpenChange={setDetailsOpen} className="shrink-0 mt-auto">
            {descriptionExpanded && descriptionOpen && (
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 min-h-8 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors [&[data-state=open]>svg:first-child]:rotate-90">
                <ChevronRight className="size-3 transition-transform" />
                Details
              </CollapsibleTrigger>
            )}
            <CollapsibleContent className={descriptionExpanded && descriptionOpen ? "pt-4" : ""}>
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
              <div className="flex-1 min-w-0 text-xs text-muted-foreground truncate px-2 py-1.5 rounded border border-border bg-muted/30" title={effectiveRepoPath ?? 'No directory set'}>
                {effectiveRepoPath ?? 'No directory set'}
                {task.worktree_path && <span className="ml-1 text-[10px] opacity-60">(worktree)</span>}
                {!task.worktree_path && task.base_dir && <span className="ml-1 text-[10px] opacity-60">(custom)</span>}
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
                  await updateTaskAndNotify({ id: task.id, baseDir: result.filePaths[0] })
                }}
              >
                <FileCode className="size-3.5 text-muted-foreground" />
              </button>
              {task.base_dir && (
                <button
                  className="shrink-0 h-7 w-7 flex items-center justify-center rounded hover:bg-muted"
                  title="Clear custom directory"
                  onClick={() => { void updateTaskAndNotify({ id: task.id, baseDir: null }) }}
                >
                  <X className="size-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
            {task.worktree_path && (
              <Button variant="outline" size="sm" className="text-xs w-full justify-start" onClick={() => { void updateTaskAndNotify({ id: task.id, worktreePath: null, worktreeParentBranch: null }) }}>
                <GitBranch className="mr-1.5 size-3" />
                Detach worktree
              </Button>
            )}
            {task.worktree_path && task.base_dir && (
              <span className="text-[10px] text-amber-400/80">Worktree active — custom dir overridden</span>
            )}
          </div>

          {/* Danger zone */}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Danger zone</span>
            <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={isArchived ? handleUnarchive : () => setArchiveDialogOpen(true)}>
              <Archive className="mr-1.5 size-3" />
              {isArchived ? 'Unarchive' : 'Archive'}
            </Button>
            <Button variant="outline" size="sm" className="flex-1 text-xs text-destructive hover:text-destructive" onClick={() => setDeleteDialogOpen(true)}>
              <Trash2 className="mr-1.5 size-3" />
              Delete
            </Button>
            </div>
          </div>

          </div>
            </CollapsibleContent>
          </Collapsible>
              </>
            )}
          />

        </div>
        )}

        {/* Resize handle: ... | Processes */}
        {!compact && panelVisibility.processes && (panelVisibility.terminal || panelVisibility.browser || panelVisibility.editor || panelVisibility.diff || panelVisibility.settings || enabledWebPanels.some(wp => panelVisibility[wp.id])) && (
          <ResizeHandle
            width={resolvedWidths.processes ?? 300}
            minWidth={200}
            onWidthChange={(w) => updatePanelSizes({ processes: w })}
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
            onReset={resetAllPanels}
          />
        )}

        {/* Processes Panel */}
        {!compact && panelVisibility.processes && (
          <div data-panel-id="processes" className={cn("shrink-0 rounded-md bg-surface-1 border border-border overflow-hidden flex flex-col transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'processes' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.processes }}>
            <ProcessesPanel taskId={task.id} projectId={project?.id ?? null} cwd={effectiveRepoPath || project?.path} terminalSessionId={getMainSessionId(task.id)} onOpenUrl={openDevServerInBrowser} />
          </div>
        )}
      </div>

      <LoopModeDialog
        open={loopDialogOpen}
        onOpenChange={(open) => { setLoopDialogOpen(open) }}
        config={task.loop_config ?? { prompt: '', criteriaType: 'contains', criteriaPattern: '', maxIterations: 50 }}
        onSave={(cfg) => { handleLoopConfigChange(cfg); setLoopDialogOpen(false) }}
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
            <AlertDialogAction onClick={handleArchive}>{isArchived ? 'Unarchive' : 'Archive'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={doctorDialogOpen} onOpenChange={setDoctorDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Stethoscope className="size-4 text-muted-foreground" />
              Environment check
              {task && (() => {
                const modeLabel = modes.find(m => m.id === task.terminal_mode)?.label
                return modeLabel ? <span className="text-muted-foreground font-normal text-sm">— {modeLabel}</span> : null
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
                  {r.ok
                    ? <CheckCircle2 className="size-4 text-green-600 dark:text-green-400 shrink-0 mt-px" />
                    : <XCircle className="size-4 text-red-500 dark:text-red-400 shrink-0 mt-px" />
                  }
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
        assets={assets.map(a => ({ id: a.id, title: a.title, type: RENDER_MODE_INFO[getEffectiveRenderMode(a.title, a.render_mode)].label }))}
        onAssetClick={(assetId) => {
          if (!panelVisibility.assets) handlePanelToggle('assets', true)
          assetsPanelRef.current?.selectAsset(assetId)
        }}
      />

    </div>
  )
})
