import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MoreHorizontal, Archive, Trash2, AlertTriangle, Sparkles, Loader2, Terminal as TerminalIcon, Globe, Settings2, GitBranch, FileCode, ChevronRight, Plus, GripVertical, Camera, X, Info, CheckCircle2, XCircle, Stethoscope, Cpu } from 'lucide-react'
import { DndContext, PointerSensor, useSensors, useSensor, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Task, PanelVisibility } from '@slayzone/task/shared'
import { BUILTIN_PANEL_IDS, getProviderConversationId, getProviderFlags, setProviderConversationId, setProviderFlags, clearAllConversationIds, PROVIDER_DEFAULTS } from '@slayzone/task/shared'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Project } from '@slayzone/projects/shared'
import { getDefaultStatus, getDoneStatus, getStatusByCategory, isTerminalStatus } from '@slayzone/projects/shared'
import { DEV_SERVER_URL_PATTERN, SESSION_ID_COMMANDS, SESSION_ID_UNAVAILABLE } from '@slayzone/terminal/shared'
import type { TerminalMode, ValidationResult } from '@slayzone/terminal/shared'
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
import { TaskMetadataSidebar, ExternalSyncCard } from './TaskMetadataSidebar'
import { RichTextEditor } from '@slayzone/editor'
import { markSkipCache, usePty, useTerminalModes, getVisibleModes, getModeLabel, groupTerminalModes } from '@slayzone/terminal'
import { TerminalContainer, type TerminalContainerHandle } from '@slayzone/task-terminals'
import { UnifiedGitPanel, type UnifiedGitPanelHandle, type GitTabId } from '@slayzone/worktrees'
import { buildStatusOptions, cn, getColumnStatusStyle, projectColorBg, useAppearance } from '@slayzone/ui'
import { BrowserPanel, type BrowserPanelHandle } from '@slayzone/task-browser'
import { FileEditorView, QuickOpenDialog, type FileEditorViewHandle } from '@slayzone/file-editor/client'
import type { EditorOpenFilesState } from '@slayzone/file-editor/shared'
import { track } from '@slayzone/telemetry/client'
import { usePanelSizes, resolveWidths } from './usePanelSizes'
import { usePanelConfig } from './usePanelConfig'
import { WebPanelView } from './WebPanelView'
import { ResizeHandle } from './ResizeHandle'
import { RegionSelector } from './RegionSelector'
import { ProcessesPanel } from './ProcessesPanel'
// ErrorBoundary should be provided by the app when rendering this component

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
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0">{StatusIcon && <StatusIcon className={cn("size-3.5", statusStyle?.iconClass)} />}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{statusStyle?.label ?? sub.status}</TooltipContent>
          </Tooltip>
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

interface TaskDetailPageProps {
  taskId: string
  isActive?: boolean
  compact?: boolean
  onBack: () => void
  onTaskUpdated: (task: Task) => void
  onArchiveTask?: (taskId: string) => Promise<void>
  onDeleteTask?: (taskId: string) => Promise<void>
  onNavigateToTask?: (taskId: string) => void
  onConvertTask?: (task: Task) => Promise<Task | void>
  onCloseTab: () => void
  settingsRevision?: number
  terminalFocusRequestId?: number
  onTerminalFocusRequestHandled?: (taskId: string, requestId: number) => void
}

export function TaskDetailPage({
  taskId,
  isActive,
  compact,
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
}: TaskDetailPageProps): React.JSX.Element {
  const { modes } = useTerminalModes()

  const { colorTintsEnabled } = useAppearance()
  // Main tab session ID format used by TerminalContainer/useTaskTerminals.
  const getMainSessionId = useCallback((id: string) => `${id}:${id}`, [])

  const [task, setTask] = useState<Task | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [taskTagIds, setTaskTagIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const statusOptions = useMemo(() => buildStatusOptions(project?.columns_config), [project?.columns_config])
  const completedStatus = useMemo(() => getDoneStatus(project?.columns_config), [project?.columns_config])
  const startedStatus = useMemo(
    () => getStatusByCategory('started', project?.columns_config) ?? getDefaultStatus(project?.columns_config),
    [project?.columns_config]
  )
  const startedStatusLabel = useMemo(
    () => statusOptions.find((option) => option.value === startedStatus)?.label ?? 'In Progress',
    [statusOptions, startedStatus]
  )

  // Sub-tasks
  const [subTasks, setSubTasks] = useState<Task[]>([])
  const [addingSubTask, setAddingSubTask] = useState(false)
  const [subTaskTitle, setSubTaskTitle] = useState('')
  const subTaskInputRef = useRef<HTMLInputElement>(null)
  const [parentTask, setParentTask] = useState<Task | null>(null)

  // Project path validation
  const [projectPathMissing, setProjectPathMissing] = useState(false)

  // PTY context for buffer management
  const { resetTaskState, subscribeSessionDetected, subscribeDevServer, getQuickRunPrompt, clearQuickRunPrompt } = usePty()

  // Detected session ID from /status command
  const [detectedSessionId, setDetectedSessionId] = useState<string | null>(null)

  // Title editing state
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleValue, setTitleValue] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Delete/archive dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)

  // Doctor dialog state
  const [doctorDialogOpen, setDoctorDialogOpen] = useState(false)
  const [doctorResults, setDoctorResults] = useState<ValidationResult[] | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(false)

  // In-progress prompt state

  // Description editing state
  const [descriptionValue, setDescriptionValue] = useState('')
  const [generatingDescription, setGeneratingDescription] = useState(false)

  // Terminal restart key (changing this forces remount)
  const [terminalKey, setTerminalKey] = useState(0)

  // Track if the main terminal tab is active (for bottom bar visibility)
  const [isMainTabActive, setIsMainTabActive] = useState(true)
  const [flagsInputValue, setFlagsInputValue] = useState('')
  const [isEditingFlags, setIsEditingFlags] = useState(false)
  const [ccsProfiles, setCcsProfiles] = useState<string[]>([])
  const flagsInputRef = useRef<HTMLInputElement>(null)

  // Panel visibility state
  const defaultPanelVisibility: PanelVisibility = { terminal: true, browser: false, diff: false, settings: true, editor: false, processes: false }
  const [panelVisibility, setPanelVisibility] = useState<PanelVisibility>(defaultPanelVisibility)

  // Browser tabs state
  const defaultBrowserTabs: BrowserTabsState = {
    tabs: [{ id: 'default', url: 'about:blank', title: 'New Tab' }],
    activeTabId: 'default'
  }
  const [browserTabs, setBrowserTabs] = useState<BrowserTabsState>(defaultBrowserTabs)

  // Global panel configuration (which panels are enabled, custom web panels)
  const { enabledWebPanels, isBuiltinEnabled } = usePanelConfig()

  // Panel sizes for resizable panels
  const [panelSizes, updatePanelSizes, resetPanelSize, resetAllPanels] = usePanelSizes()
  const [isResizing, setIsResizing] = useState(false)

  // Measure split-view container width for auto panel sizing
  const [containerWidth, setContainerWidth] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const splitContainerRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect()
      roRef.current = null
    }
    if (el) {
      roRef.current = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width))
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

  // Subscribe to session detected events
  useEffect(() => {
    if (!task) return
    return subscribeSessionDetected(getMainSessionId(task.id), setDetectedSessionId)
  }, [task?.id, subscribeSessionDetected, getMainSessionId])

  // Dev server URL detection
  const [detectedDevUrl, setDetectedDevUrl] = useState<string | null>(null)
  const devUrlDismissedRef = useRef<Set<string>>(new Set())
  const devServerToastEnabledRef = useRef(true)
  const devServerAutoOpenRef = useRef(false)
  const devServerAutoOpenCallbackRef = useRef<((url: string) => void) | null>(null)
  const browserOpenRef = useRef(panelVisibility.browser)
  const gitPanelRef = useRef<UnifiedGitPanelHandle>(null)
  const [gitDefaultTab, setGitDefaultTab] = useState<GitTabId>('general')
  const [quickOpenVisible, setQuickOpenVisible] = useState(false)
  const fileEditorRef = useRef<FileEditorViewHandle>(null)
  const terminalContainerRef = useRef<TerminalContainerHandle>(null)
  const browserPanelRef = useRef<BrowserPanelHandle>(null)
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

  // Load task data on mount or when taskId changes
  useEffect(() => {
    // Reset transient state when switching tasks
    setLoading(true)
    setDetectedSessionId(null)
    setEditingTitle(false)
    setGeneratingDescription(false)

    const loadData = async (): Promise<void> => {
      const checkProjectPathExists = async (path: string): Promise<boolean> => {
        const pathExists = window.api.files?.pathExists
        if (typeof pathExists === 'function') return pathExists(path)
        console.warn('window.api.files.pathExists is unavailable; skipping path validation')
        return true
      }

      const [loadedTask, loadedTags, loadedTaskTags, projects, loadedSubTasks] = await Promise.all([
        window.api.db.getTask(taskId),
        window.api.tags.getTags(),
        window.api.taskTags.getTagsForTask(taskId),
        window.api.db.getProjects(),
        window.api.db.getSubTasks(taskId)
      ])

      if (loadedTask) {
        setTask(loadedTask)
        setTitleValue(loadedTask.title)
        setDescriptionValue(loadedTask.description ?? '')
        // Restore panel visibility and browser tabs (always reset to defaults if not saved)
        setPanelVisibility({
          ...defaultPanelVisibility,
          ...(loadedTask.panel_visibility ?? {}),
          ...(loadedTask.is_temporary ? { settings: false } : {})
        })
        if (loadedTask.browser_tabs) {
          setBrowserTabs(loadedTask.browser_tabs)
        } else {
          // Default to first URL from other tasks
          const allTasks = await window.api.db.getTasks()
          let firstUrl = 'about:blank'
          for (const t of allTasks) {
            if (t.id === loadedTask.id) continue
            const url = t.browser_tabs?.tabs?.find(tab => tab.url && tab.url !== 'about:blank')?.url
            if (url) {
              firstUrl = url
              break
            }
          }
          setBrowserTabs({
            tabs: [{ id: 'default', url: firstUrl, title: firstUrl === 'about:blank' ? 'New Tab' : firstUrl }],
            activeTabId: 'default'
          })
        }
        // Find project for this task
        const taskProject = projects.find((p) => p.id === loadedTask.project_id)
        setProject(taskProject || null)
        if (taskProject?.path) {
          const exists = await checkProjectPathExists(taskProject.path)
          setProjectPathMissing(!exists)
        } else {
          setProjectPathMissing(false)
        }
      }
      setSubTasks(loadedSubTasks)
      if (loadedTask?.parent_id) {
        const parent = await window.api.db.getTask(loadedTask.parent_id)
        setParentTask(parent)
      } else {
        setParentTask(null)
      }
      setTags(loadedTags)
      setTaskTagIds(loadedTaskTags.map((t) => t.id))
      setLoading(false)
    }

    loadData()
  }, [taskId])

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

  // Keep project in sync when task project assignment changes.
  useEffect(() => {
    if (!task) return
    let cancelled = false

    const checkProjectPathExists = async (path: string): Promise<boolean> => {
      const pathExists = window.api.files?.pathExists
      if (typeof pathExists === 'function') return pathExists(path)
      console.warn('window.api.files.pathExists is unavailable; skipping path validation')
      return true
    }

    const syncProject = async (): Promise<void> => {
      const projects = await window.api.db.getProjects()
      const taskProject = projects.find((p) => p.id === task.project_id) || null
      if (cancelled) return

      setProject(taskProject)

      if (taskProject?.path) {
        const exists = await checkProjectPathExists(taskProject.path)
        if (!cancelled) setProjectPathMissing(!exists)
      } else if (!cancelled) {
        setProjectPathMissing(false)
      }
    }

    void syncProject()
    return () => {
      cancelled = true
    }
  }, [task?.project_id, task?.id])

  // Handle session ID creation from terminal
  const handleSessionCreated = useCallback(
    async (sessionId: string) => {
      if (!task) return
      const updated = await window.api.db.updateTask({
        id: task.id,
        providerConfig: setProviderConversationId(task.provider_config, task.terminal_mode, sessionId)
      })
      setTask(updated)
      onTaskUpdated(updated)
    },
    [task, onTaskUpdated]
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

  // Get current conversation ID for mode (with claude_session_id legacy fallback)
  const getConversationIdForMode = useCallback((t: Task): string | null => {
    const id = getProviderConversationId(t.provider_config, t.terminal_mode)
    if (id) return id
    if (t.terminal_mode === 'claude-code') return t.claude_session_id || null
    return null
  }, [])

  // Update DB with detected session ID
  const handleUpdateSessionId = useCallback(async () => {
    if (!task || !detectedSessionId) return
    const updated = await window.api.db.updateTask({
      id: task.id,
      providerConfig: setProviderConversationId(task.provider_config, task.terminal_mode, detectedSessionId)
    })
    setTask(updated)
    onTaskUpdated(updated)
    setDetectedSessionId(null)
  }, [task, detectedSessionId, onTaskUpdated])

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
      setTask(updated)
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
    setTask(updated)
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
    setTask(updated)
    onTaskUpdated(updated)
    await new Promise((r) => setTimeout(r, 100))
    markSkipCache(mainSessionId)
    setTerminalKey((k) => k + 1)
  }, [task, resetTaskState, onTaskUpdated, getMainSessionId])

  // Doctor: validate CLI binary and dependencies
  const handleDoctor = useCallback(async () => {
    if (!task || task.terminal_mode === 'terminal') return
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

  // Screenshot: show region selector, then capture and inject
  const [showRegionSelector, setShowRegionSelector] = useState(false)

  const handleScreenshot = useCallback(() => {
    setShowRegionSelector(true)
  }, [])

  const handleRegionSelect = useCallback(async (rect: { x: number; y: number; width: number; height: number }) => {
    setShowRegionSelector(false)
    // Small delay to let the overlay unmount before capturing
    await new Promise(r => setTimeout(r, 50))
    const result = await window.api.screenshot.captureRegion(rect)
    if (!result.success || !result.path) return
    const escaped = result.path.includes(' ') ? `"${result.path}"` : result.path
    await terminalApiRef.current?.write(escaped)
  }, [])

  const handleRegionCancel = useCallback(() => {
    setShowRegionSelector(false)
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
    // Strip HTML tags to get plain text
    const tmp = document.createElement('div')
    tmp.innerHTML = descriptionValue
    const plainText = tmp.textContent || tmp.innerText || ''
    if (plainText.trim()) {
      await terminalApiRef.current.sendInput(plainText.trim())
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

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isActive) return
      if (e.metaKey && e.key === 'i') {
        if (!isTerminalFocused()) return
        e.preventDefault()
        if (e.shiftKey) {
          handleInjectDescription()
        } else {
          handleInjectTitle()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isActive, handleInjectTitle, handleInjectDescription])

  // Cmd+Shift+S screenshot trigger from main process
  useEffect(() => {
    if (!isActive) return
    return window.api.app.onScreenshotTrigger(() => {
      void handleScreenshot()
    })
  }, [isActive, handleScreenshot])

  // Keep a ref so the onCloseCurrent handler always sees current browserTabs without re-subscribing
  const browserTabsRef = useRef(browserTabs)
  useEffect(() => { browserTabsRef.current = browserTabs }, [browserTabs])

  // Track last-focused sub-panel via focusin (macOS native menu accelerators clear activeElement by callback time)
  const lastFocusedPanelRef = useRef<'terminal' | 'editor' | 'browser' | null>(null)
  const [focusedPanel, setFocusedPanel] = useState<string | null>(null)
  const onCloseTabRef = useRef(onCloseTab)
  onCloseTabRef.current = onCloseTab
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
    if (!isActive) return
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
        }
      }
      // Nothing was closed — close the task tab
      onCloseTabRef.current?.()
    })
  }, [isActive, setBrowserTabs])

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
        providerConfig: clearAllConversationIds(task.provider_config),
        claudeSessionId: null
      })
      if (!updated) return
      setTask(updated)
      onTaskUpdated(updated)
      // Remount terminal (mark skip to prevent cleanup from re-caching old content)
      markSkipCache(mainSessionId)
      setTerminalKey((k) => k + 1)
    },
    [task, onTaskUpdated, resetTaskState]
  )

  const getProviderFlagsForMode = useCallback((currentTask: Task): string => {
    return getProviderFlags(currentTask.provider_config, currentTask.terminal_mode)
  }, [])

  const handleFlagsSave = useCallback(
    async (nextValue: string) => {
      if (!task || task.terminal_mode === 'terminal') return
      const currentValue = getProviderFlagsForMode(task)
      if (currentValue === nextValue) return

      const update = {
        id: task.id,
        providerConfig: setProviderFlags(task.provider_config, task.terminal_mode, nextValue)
      }

      const updated = await window.api.db.updateTask(update)
      setTask(updated)
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
    const def = PROVIDER_DEFAULTS[task.terminal_mode]
    if (!def) return
    const defaultFlags = (await window.api.settings.get(def.settingsKey)) ?? def.fallback
    setFlagsInputValue(defaultFlags)
    await handleFlagsSave(defaultFlags)
  }, [task, handleFlagsSave])

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
      // Persist to DB
      const updated = await window.api.db.updateTask({
        id: task.id,
        panelVisibility: newVisibility
      })
      setTask(updated)
      onTaskUpdated(updated)
    },
    [task, panelVisibility, onTaskUpdated, resetPanelSize]
  )

  const handleQuickOpenFile = useCallback((filePath: string) => {
    if (fileEditorRef.current) {
      fileEditorRef.current.openFile(filePath)
    } else {
      // Editor not mounted yet — queue file and enable panel
      pendingEditorFileRef.current = filePath
      handlePanelToggle('editor', true)
    }
  }, [handlePanelToggle])

  // Cmd+T/B/G/S/E/P + web panel shortcuts for panel toggles
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isActive) return
      // Cmd+Shift+G: git diff tab toggle
      if (e.metaKey && e.shiftKey) {
        // Cmd+Shift+F: open editor panel + search sidebar
        if (e.key.toLowerCase() === 'f' && isBuiltinEnabled('editor')) {
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
        if (e.key.toLowerCase() === 'l' && isBuiltinEnabled('browser') && panelVisibility.browser) {
          e.preventDefault()
          browserPanelRef.current?.pickElement()
          return
        }
        if (e.key.toLowerCase() === 'g' && isBuiltinEnabled('diff')) {
          e.preventDefault()
          if (!panelVisibility.diff) {
            setGitDefaultTab('changes')
            handlePanelToggle('diff', true)
          } else if (gitPanelRef.current?.getActiveTab() === 'changes') {
            handlePanelToggle('diff', false)
          } else {
            gitPanelRef.current?.switchToTab('changes')
          }
        }
      }

      if (e.metaKey && !e.shiftKey) {
        // Cmd+P: quick open — works even inside CodeMirror
        const editorProjectPath = task?.worktree_path || project?.path
        if (e.key === 'p' && isBuiltinEnabled('editor') && editorProjectPath) {
          e.preventDefault()
          setQuickOpenVisible(true)
          return
        }

        // Cmd+E: toggle editor panel — works even inside CodeMirror
        if (e.key === 'e' && isBuiltinEnabled('editor')) {
          e.preventDefault()
          handlePanelToggle('editor', !panelVisibility.editor)
          return
        }

        // Skip shortcuts when focus is in CodeMirror or contenteditable editors
        const target = e.target as HTMLElement
        const inEditor = target?.closest?.('[contenteditable="true"]')
        const inCodeMirror = target?.closest?.('.cm-editor')
        if (inCodeMirror) return

        // Cmd+G: git general tab toggle
        if (e.key === 'g' && isBuiltinEnabled('diff')) {
          e.preventDefault()
          if (!panelVisibility.diff) {
            setGitDefaultTab('general')
            handlePanelToggle('diff', true)
          } else if (gitPanelRef.current?.getActiveTab() === 'general') {
            handlePanelToggle('diff', false)
          } else {
            gitPanelRef.current?.switchToTab('general')
          }
        } else if (e.key === 't' && isBuiltinEnabled('terminal')) {
          e.preventDefault()
          handlePanelToggle('terminal', !panelVisibility.terminal)
        } else if (e.key === 'b' && !inEditor && isBuiltinEnabled('browser')) {
          e.preventDefault()
          handlePanelToggle('browser', !panelVisibility.browser)
        } else if (e.key === 's' && isBuiltinEnabled('settings')) {
          e.preventDefault()
          handlePanelToggle('settings', !panelVisibility.settings)
        } else if (e.key === 'o' && import.meta.env.DEV && isBuiltinEnabled('processes')) {
          e.preventDefault()
          handlePanelToggle('processes', !panelVisibility.processes)
        } else {
          // Web panel shortcuts
          for (const wp of enabledWebPanels) {
            if (wp.shortcut && e.key === wp.shortcut) {
              e.preventDefault()
              handlePanelToggle(wp.id, !panelVisibility[wp.id])
              return
            }
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isActive, panelVisibility, handlePanelToggle, isBuiltinEnabled, enabledWebPanels])

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
    setTask(updated)
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
    if (!task) return

    const updated = await window.api.db.updateTask({
      id: task.id,
      description: descriptionValue || undefined
    })
    setTask(updated)
    onTaskUpdated(updated)
  }

  const handleGenerateDescription = async (): Promise<void> => {
    if (!task || generatingDescription) return
    setGeneratingDescription(true)
    try {
      const result = await window.api.ai.generateDescription(
        task.title,
        task.terminal_mode
      )
      if (result.success && result.description) {
        setDescriptionValue(result.description)
        const updated = await window.api.db.updateTask({
          id: task.id,
          description: result.description
        })
        setTask(updated)
        onTaskUpdated(updated)
      } else if (result.error) {
        console.error('[generate] Error:', result.error)
      }
    } catch (err) {
      console.error('[generate] Exception:', err)
    } finally {
      setGeneratingDescription(false)
    }
  }

  const handleCreateSubTask = async (): Promise<void> => {
    if (!task || !subTaskTitle.trim()) return
    const sub = await window.api.db.createTask({
      projectId: task.project_id,
      title: subTaskTitle.trim(),
      parentId: task.id,
      status: getDefaultStatus(project?.columns_config)
    })
    if (sub) setSubTasks(prev => [...prev, sub])
    setSubTaskTitle('')
    setAddingSubTask(false)
  }

  const handleUpdateSubTask = async (subId: string, updates: Record<string, unknown>): Promise<void> => {
    const updated = await window.api.db.updateTask({ id: subId, ...updates })
    if (updated) {
      setSubTasks(prev => prev.map(s => s.id === subId ? updated : s))
    }
  }

  const handleDeleteSubTask = async (subId: string): Promise<void> => {
    await window.api.db.deleteTask(subId)
    setSubTasks(prev => prev.filter(s => s.id !== subId))
  }

  const subTaskSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const handleSubTaskDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setSubTasks(prev => {
      const oldIndex = prev.findIndex(s => s.id === active.id)
      const newIndex = prev.findIndex(s => s.id === over.id)
      const reordered = arrayMove(prev, oldIndex, newIndex)
      window.api.db.reorderTasks(reordered.map(t => t.id))
      return reordered
    })
  }

  const handleTaskUpdate = (updated: Task): void => {
    setTask(updated)
    setTitleValue(updated.title)
    setDescriptionValue(updated.description ?? '')
    onTaskUpdated(updated)
  }

  // Wrapper for GitPanel that calls API and notifies parent
  const updateTaskAndNotify = async (data: { id: string; worktreePath?: string | null; worktreeParentBranch?: string | null; browserUrl?: string | null; status?: Task['status'] }): Promise<Task> => {
    // If worktreePath is changing, kill old PTY first so terminal restarts with new cwd
    if (data.worktreePath !== undefined) {
      const mainSessionId = `${data.id}:${data.id}`
      resetTaskState(mainSessionId)
      await window.api.pty.kill(mainSessionId)
      markSkipCache(mainSessionId)
    }

    const updated = await window.api.db.updateTask(data)
    handleTaskUpdate(updated)

    // Force terminal remount if worktreePath changed
    if (data.worktreePath !== undefined) {
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
    taskIdRef.current = task?.id ?? null
    if (task?.web_panel_urls) webPanelUrlsRef.current = { ...task.web_panel_urls }
    else webPanelUrlsRef.current = {}
  }, [task?.id, flushPendingUrlSave, flushPendingEditorSave])

  // Flush pending saves on unmount
  useEffect(() => {
    return () => { flushPendingUrlSave(); flushPendingEditorSave() }
  }, [flushPendingUrlSave, flushPendingEditorSave])

  const handleWebPanelUrlChange = useCallback((panelId: string, url: string) => {
    if (!taskIdRef.current) return
    webPanelUrlsRef.current = { ...webPanelUrlsRef.current, [panelId]: url }
    if (webPanelUrlTimerRef.current) clearTimeout(webPanelUrlTimerRef.current)
    const id = taskIdRef.current
    const urlSnapshot = { ...webPanelUrlsRef.current }
    webPanelUrlTimerRef.current = setTimeout(async () => {
      const updated = await window.api.db.updateTask({
        id,
        webPanelUrls: urlSnapshot
      })
      setTask(updated)
    }, 500)
  }, [])

  const handleEditorStateChange = useCallback((state: EditorOpenFilesState) => {
    editorStateRef.current = state
    if (editorStateTimerRef.current) clearTimeout(editorStateTimerRef.current)
    const id = taskIdRef.current
    editorStateTimerRef.current = setTimeout(async () => {
      if (!id) return
      const updated = await window.api.db.updateTask({
        id,
        editorOpenFiles: state
      })
      setTask(updated)
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

  const handleConfirmInProgress = async (): Promise<void> => {
    if (!task) return
    const updated = await window.api.db.updateTask({ id: task.id, status: startedStatus })
    handleTaskUpdate(updated)
  }

  if (loading) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>
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
    <div id="task-detail" className={cn("h-full flex flex-col bg-surface-0", compact ? "p-0" : "px-6 py-4 gap-4")} style={colorTintsEnabled && projectColorBg(project?.color) ? { backgroundImage: `linear-gradient(${projectColorBg(project?.color)}, ${projectColorBg(project?.color)})` } : undefined}>
      {compact && (
        <div className="shrink-0 flex items-center gap-2 px-2 h-10 bg-surface-1 border-b border-border min-w-0">
          <span className="text-xs font-medium truncate flex-1">
            {task.is_temporary ? 'Temporary task' : task.title}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0">{task.terminal_mode}</span>
        </div>
      )}
      {!compact && showRegionSelector && (
        <RegionSelector onSelect={handleRegionSelect} onCancel={handleRegionCancel} />
      )}
      {/* Header */}
      {!compact && <header className="shrink-0 relative">
        <div>
          <div className="flex items-center gap-4 window-no-drag">
            {task.is_temporary ? (
              <div className="flex flex-1 min-w-0">
                <div className="relative min-w-0 w-full">
                  <div className="flex items-center gap-3">
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
                  </div>
                  <p className="pointer-events-none absolute left-0 top-full z-10 -mt-0.5 whitespace-nowrap text-[11px] text-muted-foreground/55">
                    Auto-deletes on terminal exit or tab close.
                  </p>
                </div>
              </div>
            ) : (
              <input
                ref={titleInputRef}
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={handleTitleKeyDown}
                onClick={() => setEditingTitle(true)}
                readOnly={!editingTitle}
                className={cn(
                  'text-2xl font-bold bg-transparent border-none outline-none flex-1',
                  !editingTitle && 'cursor-pointer'
                )}
              />
            )}

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

            {!task.is_temporary && task.status !== startedStatus && (
              <button
                type="button"
                onClick={handleConfirmInProgress}
                className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20 dark:text-yellow-400 transition-colors cursor-pointer"
              >
                Set status to <em>{startedStatusLabel}</em>
              </button>
            )}

            <div className="flex items-center gap-2">
              <PanelToggle
                panels={(() => {
                  const builtins: { id: string; icon: typeof Globe; label: string; shortcut?: string }[] = [
                    { id: 'terminal', icon: TerminalIcon, label: 'Terminal', shortcut: '⌘T' },
                    { id: 'browser', icon: Globe, label: 'Browser', shortcut: '⌘B' },
                    { id: 'editor', icon: FileCode, label: 'Editor', shortcut: '⌘E' },
                    { id: 'diff', icon: GitBranch, label: 'Git', shortcut: '⌘G' },
                    ...(import.meta.env.DEV ? [{ id: 'processes', icon: Cpu, label: 'Processes', shortcut: '⌘O' }] : []),
                    { id: 'settings', icon: Settings2, label: 'Settings', shortcut: '⌘S' },
                  ].filter(p => isBuiltinEnabled(p.id) && !(task.is_temporary && p.id === 'settings'))

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
            <div className="w-full max-w-xl min-h-52 rounded-lg border border-border bg-surface-2 px-5 py-7 text-center flex flex-col items-center justify-center">
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
            !compact && "rounded-md bg-surface-2 border border-border",
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
                Session ID detection not available for this provider — don't close the tab or resume won't work. Providers with resume: Claude Code, Codex, Gemini
              </span>
              <button
                className="ml-auto text-amber-500 hover:text-amber-400 shrink-0"
                onClick={() => setSessionUnavailableDismissed(task?.id ?? null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {/* Terminal + mode bar wrapper */}
          <div className="flex-1 min-h-0 overflow-hidden">
              {isResizing ? (
                <div className="h-full bg-black" />
              ) : project?.id === task.project_id && project.path && !projectPathMissing ? (
                <TerminalContainer
                  ref={terminalContainerRef}
                  key={`${terminalKey}-${task.project_id}-${project?.path || ''}-${task.worktree_path || ''}`}
                  taskId={task.id}
                  isActive={isActive}
                  cwd={task.worktree_path || project.path}
                  defaultMode={task.terminal_mode}
                  conversationId={getConversationIdForMode(task) || undefined}
                  existingConversationId={getConversationIdForMode(task) || undefined}
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
                            onValueChange={(value) => handleModeChange(value as TerminalMode)}
                          >
                            <SelectTrigger
                              data-testid="terminal-mode-trigger"
                              size="sm"
                              className="min-w-32 h-7 text-xs bg-neutral-100 border-neutral-300 dark:bg-neutral-800 dark:border-neutral-700"
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
                              <SelectSeparator />
                              <SelectItem value="terminal">Terminal</SelectItem>
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
                                      setTask(updated)
                                      onTaskUpdated(updated)
                                    }
                                  }}
                                >
                                  <SelectTrigger className="h-7 text-xs bg-neutral-100 border-neutral-300 dark:bg-neutral-800 dark:border-neutral-700 w-28">
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

                          {task.terminal_mode !== 'terminal' && task.terminal_mode !== 'ccs' && (
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
                                className="h-7 text-xs bg-neutral-100 border-neutral-300 dark:bg-neutral-800 dark:border-neutral-700 w-72"
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
                                      <div className="text-xs text-neutral-700 dark:text-neutral-200 truncate">
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

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <IconButton variant="ghost" aria-label="Screenshot to terminal" className="size-7" onClick={() => void handleScreenshot()}>
                                <Camera className="size-3.5" />
                              </IconButton>
                            </TooltipTrigger>
                            <TooltipContent>Screenshot to terminal (⌘⇧S)</TooltipContent>
                          </Tooltip>

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
                                <span className="ml-auto text-xs text-muted-foreground">⌘I</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void handleInjectDescription()}>
                                Inject description
                                <span className="ml-auto text-xs text-muted-foreground">⌘⇧I</span>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={handleReattachTerminal}>
                                Re-attach terminal
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={handleRestartTerminal}>
                                Restart terminal
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
          <div data-panel-id="browser" className={cn("shrink-0 rounded-md bg-surface-2 border border-border overflow-hidden transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'browser' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.browser }}>
            <BrowserPanel
              ref={browserPanelRef}
              className="h-full"
              tabs={browserTabs}
              onTabsChange={handleBrowserTabsChange}
              taskId={task.id}
              isResizing={isResizing}
              isActive={isActive}
              onElementSnippet={handleInsertElementSnippet}
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
        {!compact && panelVisibility.editor && project?.path && (
          <div data-panel-id="editor" className={cn("shrink-0 overflow-hidden rounded-md bg-surface-2 border border-border transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'editor' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.editor }}>
            <FileEditorView
              ref={fileEditorRefCallback}
              projectPath={task.worktree_path || project.path}
              initialEditorState={task.editor_open_files}
              onEditorStateChange={handleEditorStateChange}
            />
          </div>
        )}

        {/* Web Panels (custom + predefined) — rendered between editor and diff */}
        {!compact && enabledWebPanels.map((wp, idx) => {
          if (!panelVisibility[wp.id]) return null
          // Show resize handle if there's a visible panel before this one
          const hasLeftNeighbor = panelVisibility.terminal || panelVisibility.browser || panelVisibility.editor ||
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
              <div data-panel-id={wp.id} className={cn("shrink-0 rounded-md bg-surface-2 border border-border overflow-hidden transition-shadow duration-200", multipleVisiblePanels && focusedPanel === wp.id && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths[wp.id] }}>
                <WebPanelView
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
          <div data-panel-id="diff" data-testid="task-git-panel" className={cn("shrink-0 rounded-md bg-surface-2 border border-border overflow-hidden flex flex-col transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'diff' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.diff }}>
            <UnifiedGitPanel
              ref={gitPanelRef}
              task={task}
              projectPath={project?.path ?? null}
              completedStatus={completedStatus}
              visible={panelVisibility.diff}
              defaultTab={gitDefaultTab}
              pollIntervalMs={5000}
              onUpdateTask={updateTaskAndNotify}
              onTaskUpdated={handleTaskUpdate}
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
        <div data-panel-id="settings" data-testid="task-settings-panel" className={cn("shrink-0 rounded-md bg-surface-2 border border-border p-3 flex flex-col gap-4 overflow-y-auto transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'settings' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.settings }}>
          <div className="shrink-0 h-10 px-2 -mx-3 -mt-3 border-b border-border bg-surface-1 flex items-center">
            <span className="text-sm font-medium">Settings</span>
          </div>

          {/* External sync links */}
          <ExternalSyncCard taskId={task.id} onUpdate={handleTaskUpdate} />

          {/* Description */}
          <div className="flex flex-col min-h-0 relative">
            <RichTextEditor
              value={descriptionValue}
              onChange={setDescriptionValue}
              onBlur={handleDescriptionSave}
              placeholder="Add description..."
              minHeight="150px"
              maxHeight="300px"
              className="rounded-md border border-input bg-transparent p-3"
              testId="task-description-editor"
            />
            {task.terminal_mode !== 'terminal' && (
              <IconButton
                data-testid="generate-description-button"
                type="button"
                variant="ghost"
                aria-label="Generate description"
                className="absolute bottom-1 right-1 size-6 text-muted-foreground hover:text-foreground"
                onClick={() => handleGenerateDescription()}
                disabled={generatingDescription || !task.title}
              >
                {generatingDescription ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
              </IconButton>
            )}
          </div>

          {/* Sub-tasks (only for top-level tasks) */}
          {!parentTask && <Collapsible defaultOpen>
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors [&[data-state=open]>svg:first-child]:rotate-90">
              <ChevronRight className="size-3 transition-transform" />
              Sub-tasks
              {subTasks.length > 0 && (
                <span className="ml-auto text-muted-foreground/60 text-[10px]">
                  {subTasks.filter((s) => isTerminalStatus(s.status, project?.columns_config ?? null)).length}/{subTasks.length}
                </span>
              )}
            </CollapsibleTrigger>
            <CollapsibleContent className="border-l border-border ml-2 pl-4 pt-2">
              <DndContext sensors={subTaskSensors} collisionDetection={closestCenter} onDragEnd={handleSubTaskDragEnd}>
              <SortableContext items={subTasks.map(s => s.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-0.5">
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
          </Collapsible>}

          {/* Spacer — pushes remaining groups to bottom */}
          <div className="flex-1" />

          {/* Details */}
          <TaskMetadataSidebar
            task={task}
            tags={tags}
            taskTagIds={taskTagIds}
            onUpdate={handleTaskUpdate}
            onTagsChange={handleTagsChange}
          />

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
        )}

        {/* Resize handle: ... | Processes */}
        {import.meta.env.DEV && !compact && panelVisibility.processes && (panelVisibility.terminal || panelVisibility.browser || panelVisibility.editor || panelVisibility.diff || panelVisibility.settings || enabledWebPanels.some(wp => panelVisibility[wp.id])) && (
          <ResizeHandle
            width={resolvedWidths.processes ?? 300}
            minWidth={200}
            onWidthChange={(w) => updatePanelSizes({ processes: w })}
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
            onReset={resetAllPanels}
          />
        )}

        {/* Processes Panel — dev mode only */}
        {import.meta.env.DEV && !compact && panelVisibility.processes && (
          <div data-panel-id="processes" className={cn("shrink-0 rounded-md bg-surface-2 border border-border overflow-hidden flex flex-col transition-shadow duration-200", multipleVisiblePanels && focusedPanel === 'processes' && "shadow-[0_0_18px_rgba(255,255,255,0.25)]")} style={{ width: resolvedWidths.processes }}>
            <ProcessesPanel taskId={task.id} projectId={project?.id ?? null} cwd={task.worktree_path || project?.path} terminalSessionId={getMainSessionId(task.id)} />
          </div>
        )}
      </div>

      {project?.path && (
        <QuickOpenDialog
          open={quickOpenVisible}
          onOpenChange={setQuickOpenVisible}
          projectPath={task.worktree_path || project.path}
          onOpenFile={handleQuickOpenFile}
        />
      )}

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
              {task && PROVIDER_DEFAULTS[task.terminal_mode] && (
                <span className="text-muted-foreground font-normal text-sm">
                  — {PROVIDER_DEFAULTS[task.terminal_mode].label}
                </span>
              )}
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
                    <code className="text-xs bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 rounded px-2 py-1.5 font-mono block">
                      {r.fix}
                    </code>
                  </div>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

    </div>
  )
}
