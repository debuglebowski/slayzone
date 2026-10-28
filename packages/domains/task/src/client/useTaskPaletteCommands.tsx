import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format, nextMonday } from 'date-fns'
import {
  AppWindow,
  ArrowUpLeft,
  Camera,
  ClipboardCopy,
  ExternalLink,
  FilePlus,
  Flag,
  FlagOff,
  FolderInput,
  Gauge,
  Globe,
  LayoutTemplate,
  Link,
  Maximize2,
  Plug,
  Power,
  RefreshCcw,
  Stethoscope,
  Wand2,
  X,
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  CalendarDays,
  CalendarX,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  MessageSquare,
  CheckSquare,
  Bot,
  CircleCheckBig,
  Clipboard,
  Heading,
  ListPlus,
  PanelRight,
  Pencil,
  RotateCcw,
  Tag as TagIcon,
  Text,
  Trash2
} from 'lucide-react'
import { useTRPC } from '@slayzone/transport/client'
import {
  PriorityIcon,
  getColumnStatusStyle,
  safeClipboardWriteText,
  useStableCallback,
  usePublishPaletteCommands,
  type PaletteCommand,
  type PaletteIcon,
  type PaletteScope,
  type StatusOption
} from '@slayzone/ui'
import { useDialogStore } from '@slayzone/settings'
import { track } from '@slayzone/telemetry/client'
import type { Tag } from '@slayzone/tags/shared'
import type { TerminalModeInfo } from '@slayzone/terminal-contracts'
import { isTerminalStatus, type ColumnConfig } from '@slayzone/projects/shared'
import { priorityOptions, type Task, type TaskTemplate } from '@slayzone/task/shared'
import { getSnoozePresets } from './SnoozePicker'

const selectTasks = (board: { tasks: Task[] }): Task[] => board.tasks

// Module-level so each priority keeps one component identity across rebuilds.
const PRIORITY_ICONS = new Map<number, PaletteIcon>(
  priorityOptions.map((o) => [
    o.value,
    ({ className }: { className?: string }) => (
      <PriorityIcon priority={o.value} className={className} />
    )
  ])
)

export interface PalettePanel {
  id: string
  label: string
  shortcutId?: string
  open: boolean
}

interface UseTaskPaletteCommandsParams {
  /** Publish only while this task owns the keyboard (active tab / focused explode cell). */
  enabled: boolean
  task: Task | null
  columnsConfig: ColumnConfig[] | null | undefined
  statusOptions: StatusOption[]
  tags: Tag[]
  taskTagIds: string[]
  panels: PalettePanel[]
  modes: TerminalModeInfo[]
  hasConversationId: boolean
  hasDescription: boolean
  onTaskUpdated: (task: Task) => void
  onTagsChange: (tagIds: string[]) => void
  /** The header's inline title editor is on screen (not zen / compact). */
  canRenameInline: boolean
  onRenameInline: () => void
  onRename: (title: string) => Promise<void>
  onArchive: () => void
  onUnarchive: () => Promise<void>
  onDelete: () => void
  onCreateSubTask: (title: string) => Promise<void>
  onModeChange: (mode: string) => Promise<void>
  onRestartAgent: () => void
  onInjectTitle: () => Promise<void>
  onInjectDescription: () => Promise<void>
  onCopyConversationId: () => void
  onTogglePanel: (panelId: string) => void
  /** Opens the page's custom snooze date/time dialog. */
  onCustomSnooze: () => void
  parentTask: { id: string; title: string } | null
  /** Templates offered to a temporary task. */
  templates: TaskTemplate[]
  /** null = detaching unavailable (the task is already open in another window). */
  windowAction: 'detach' | 'reattach' | null
  browserOpen: boolean
  onConvertToTask: () => Promise<void>
  onApplyTemplate: (template: TaskTemplate) => Promise<void>
  onNavigateToTask: (taskId: string) => void
  onCloseTask: () => void
  onToggleWindow: () => void
  onStopAgent: () => Promise<void>
  onResetTerminal: () => void
  onReattachTerminal: () => void
  onCopyHistory: () => void
  onEditFlags: () => void
  onResetFlags: () => Promise<void>
  onDoctor: () => Promise<void>
  onEditDescription: () => void
  onNewArtifact: () => void
  onOpenExternal: (url: string) => void
  onNewBrowserTab: () => void
  onBrowserScreenshot: () => void
}

/**
 * Publishes the task's Cmd+K commands ("Current task" section). Every command runs
 * an existing task-page handler or the same mutation the page's own controls use.
 */
export function useTaskPaletteCommands(params: UseTaskPaletteCommandsParams): void {
  const {
    enabled,
    task,
    columnsConfig,
    statusOptions,
    tags,
    taskTagIds,
    panels,
    modes,
    hasConversationId,
    hasDescription,
    canRenameInline,
    parentTask,
    templates,
    windowAction,
    browserOpen
  } = params
  const trpc = useTRPC()
  const { mutateAsync: updateTask } = useMutation(trpc.task.update.mutationOptions())
  const { mutateAsync: setTagsForTask } = useMutation(trpc.tags.setForTask.mutationOptions())

  // Stable wrappers: the scope's identity then follows the task's data only.
  const onTaskUpdated = useStableCallback(params.onTaskUpdated)
  const onTagsChange = useStableCallback(params.onTagsChange)
  const onRenameInline = useStableCallback(params.onRenameInline)
  const onRename = useStableCallback(params.onRename)
  const onArchive = useStableCallback(params.onArchive)
  const onUnarchive = useStableCallback(params.onUnarchive)
  const onDelete = useStableCallback(params.onDelete)
  const onCreateSubTask = useStableCallback(params.onCreateSubTask)
  const onModeChange = useStableCallback(params.onModeChange)
  const onRestartAgent = useStableCallback(params.onRestartAgent)
  const onInjectTitle = useStableCallback(params.onInjectTitle)
  const onInjectDescription = useStableCallback(params.onInjectDescription)
  const onCopyConversationId = useStableCallback(params.onCopyConversationId)
  const onTogglePanel = useStableCallback(params.onTogglePanel)
  const onCustomSnooze = useStableCallback(params.onCustomSnooze)
  const onConvertToTask = useStableCallback(params.onConvertToTask)
  const onApplyTemplate = useStableCallback(params.onApplyTemplate)
  const onNavigateToTask = useStableCallback(params.onNavigateToTask)
  const onCloseTask = useStableCallback(params.onCloseTask)
  const onToggleWindow = useStableCallback(params.onToggleWindow)
  const onStopAgent = useStableCallback(params.onStopAgent)
  const onResetTerminal = useStableCallback(params.onResetTerminal)
  const onReattachTerminal = useStableCallback(params.onReattachTerminal)
  const onCopyHistory = useStableCallback(params.onCopyHistory)
  const onEditFlags = useStableCallback(params.onEditFlags)
  const onResetFlags = useStableCallback(params.onResetFlags)
  const onDoctor = useStableCallback(params.onDoctor)
  const onEditDescription = useStableCallback(params.onEditDescription)
  const onNewArtifact = useStableCallback(params.onNewArtifact)
  const onOpenExternal = useStableCallback(params.onOpenExternal)
  const onNewBrowserTab = useStableCallback(params.onNewBrowserTab)
  const onBrowserScreenshot = useStableCallback(params.onBrowserScreenshot)
  const queryClient = useQueryClient()

  // Blockers + candidates: fetched only while this tab publishes. Same queries as the
  // sidebar (getBlockers) and the blocker picker (loadBoardData), so caches are shared.
  const taskId = task?.id ?? ''
  const { data: blockers } = useQuery(
    trpc.task.getBlockers.queryOptions({ taskId }, { enabled: enabled && !!task })
  )
  const { data: allTasks } = useQuery(
    trpc.task.loadBoardData.queryOptions(undefined, {
      enabled: enabled && !!task,
      staleTime: 30_000,
      select: selectTasks
    })
  )
  const { data: projects } = useQuery(
    trpc.projects.list.queryOptions(undefined, { enabled: enabled && !!task })
  )
  const { mutateAsync: addBlocker } = useMutation(trpc.task.addBlocker.mutationOptions())
  const { mutateAsync: removeBlocker } = useMutation(trpc.task.removeBlocker.mutationOptions())

  const update = useStableCallback(async (patch: Omit<Parameters<typeof updateTask>[0], 'id'>) => {
    if (!task) return
    onTaskUpdated(await updateTask({ id: task.id, ...patch }))
  })
  const toggleBlocker = useStableCallback(async (blockerTaskId: string) => {
    if (!task) return
    const isBlocker = (blockers ?? []).some((b) => b.id === blockerTaskId)
    if (isBlocker) await removeBlocker({ taskId: task.id, blockerTaskId })
    else await addBlocker({ taskId: task.id, blockerTaskId })
    await queryClient.invalidateQueries({
      queryKey: trpc.task.getBlockers.queryKey({ taskId: task.id })
    })
  })

  const setStatus = useStableCallback(async (taskId: string, status: string) => {
    if (!task) return
    track('task_status_changed', { from: task.status, to: status })
    if (isTerminalStatus(status, columnsConfig)) {
      track('task_completed', {
        provider: task.terminal_mode ?? 'terminal',
        had_worktree: Boolean(task.worktree_path)
      })
    }
    onTaskUpdated(await updateTask({ id: taskId, status }))
  })
  const setPriority = useStableCallback(async (taskId: string, priority: number) => {
    onTaskUpdated(await updateTask({ id: taskId, priority }))
  })
  const toggleTag = useStableCallback(async (taskId: string, tagId: string) => {
    const checked = !taskTagIds.includes(tagId)
    if (checked) track('tag_assigned')
    const next = checked ? [...taskTagIds, tagId] : taskTagIds.filter((id) => id !== tagId)
    await setTagsForTask({ taskId, tagIds: next })
    onTagsChange(next)
  })

  let scope: PaletteScope | null = null
  if (task) {
    const commands: PaletteCommand[] = []
    const isArchived = !!task.archived_at
    const currentStatus = getColumnStatusStyle(task.status, columnsConfig)

    if (!task.is_temporary) {
      commands.push({
        id: 'status',
        label: 'Change status…',
        keywords: 'status column state',
        icon: currentStatus?.icon,
        iconClassName: currentStatus?.iconClass,
        featured: true,
        page: {
          kind: 'list',
          title: 'Status',
          items: statusOptions.map((opt) => {
            const style = getColumnStatusStyle(opt.value, columnsConfig)
            return {
              id: `status:${opt.value}`,
              label: opt.label,
              icon: style?.icon,
              iconClassName: style?.iconClass,
              checked: opt.value === task.status,
              run: () => setStatus(task.id, opt.value)
            }
          })
        }
      })
      commands.push({
        id: 'priority',
        label: 'Change priority…',
        keywords: 'priority urgent',
        icon: PRIORITY_ICONS.get(task.priority),
        featured: true,
        page: {
          kind: 'list',
          title: 'Priority',
          items: priorityOptions.map((opt) => ({
            id: `priority:${opt.value}`,
            label: opt.label,
            icon: PRIORITY_ICONS.get(opt.value),
            checked: opt.value === task.priority,
            run: () => setPriority(task.id, opt.value)
          }))
        }
      })
      if (tags.length > 0) {
        commands.push({
          id: 'tags',
          label: 'Edit tags…',
          keywords: 'tag label',
          icon: TagIcon,
          page: {
            kind: 'list',
            title: 'Tags',
            // Lists other entities: root search shows at most 5.
            searchLimit: 5,
            items: tags.map((tag) => ({
              id: `tag:${tag.id}`,
              label: tag.name,
              icon: TagIcon,
              checked: taskTagIds.includes(tag.id),
              keepOpen: true,
              run: () => toggleTag(task.id, tag.id)
            }))
          }
        })
      }
      if (projects && projects.length > 1) {
        commands.push({
          id: 'move-project',
          label: 'Move to project…',
          keywords: 'project move transfer',
          icon: FolderInput,
          page: {
            kind: 'list',
            title: 'Project',
            // Lists other entities: root search shows at most 5.
            searchLimit: 5,
            items: projects.map((p) => ({
              id: `project:${p.id}`,
              label: p.name,
              icon: FolderInput,
              checked: p.id === task.project_id,
              run: () => {
                if (p.id === task.project_id) return
                track('task_moved_to_project')
                return update({ projectId: p.id })
              }
            }))
          }
        })
      }
      commands.push({
        id: 'progress',
        label: 'Set progress…',
        keywords: 'progress percent done',
        icon: Gauge,
        page: {
          kind: 'list',
          title: 'Progress',
          items: [
            ...[0, 25, 50, 75, 100].map((pct) => ({
              id: `progress:${pct}`,
              label: `${pct}%`,
              icon: Gauge,
              checked: task.progress === pct,
              run: () => update({ progress: pct })
            }))
          ]
        }
      })
      commands.push({
        id: 'edit-description',
        label: 'Edit description',
        keywords: 'description notes fullscreen',
        icon: Maximize2,
        run: onEditDescription
      })

      const isSnoozed = !!task.snoozed_until && new Date(task.snoozed_until) > new Date()
      commands.push({
        id: 'snooze',
        label: isSnoozed ? 'Change snooze…' : 'Snooze…',
        keywords: 'snooze later remind defer',
        icon: AlarmClock,
        page: {
          kind: 'list',
          title: 'Snooze',
          items: [
            ...getSnoozePresets().map((preset) => ({
              id: `snooze:${preset.label}`,
              label: preset.label,
              icon: preset.icon,
              run: () => {
                track('task_snoozed')
                return update({ snoozedUntil: preset.getDate().toISOString() })
              }
            })),
            {
              id: 'snooze:custom',
              label: 'Pick date & time…',
              icon: CalendarDays,
              takesFocus: true,
              run: onCustomSnooze
            }
          ]
        }
      })
      if (isSnoozed) {
        commands.push({
          id: 'unsnooze',
          label: 'Unsnooze',
          keywords: 'wake snooze',
          icon: AlarmClockOff,
          run: () => update({ snoozedUntil: null })
        })
      }

      commands.push(
        task.is_blocked
          ? {
              id: 'unblock',
              label: 'Unblock',
              keywords: 'blocked',
              icon: ShieldCheck,
              run: () => {
                track('task_unblocked')
                return update({ isBlocked: false, blockedComment: null })
              }
            }
          : {
              id: 'block',
              label: 'Mark blocked',
              keywords: 'blocked',
              icon: ShieldAlert,
              run: () => {
                track('task_blocked', {})
                return update({ isBlocked: true })
              }
            }
      )
      commands.push({
        id: 'block-comment',
        label: task.blocked_comment ? 'Edit blocked comment…' : 'Mark blocked with comment…',
        keywords: 'blocked reason why',
        icon: MessageSquare,
        page: {
          kind: 'prompt',
          title: 'Blocked comment',
          placeholder: 'Why is this task blocked? Enter to save',
          initialValue: task.blocked_comment ?? '',
          onSubmit: (comment) => {
            track('task_blocked', { hasComment: 'true' })
            return update({ isBlocked: true, blockedComment: comment })
          }
        }
      })
      if (task.blocked_comment) {
        commands.push({
          id: 'clear-block-comment',
          label: 'Clear blocked comment',
          keywords: 'blocked',
          icon: ShieldX,
          run: () => update({ blockedComment: null })
        })
      }
      if (allTasks) {
        const blockerIds = new Set((blockers ?? []).map((b) => b.id))
        commands.push({
          id: 'blocked-by',
          label: 'Blocked by…',
          keywords: 'blocker dependency depends waiting',
          icon: ShieldAlert,
          page: {
            kind: 'list',
            title: 'Blocked by',
            // Lists other entities: root search shows at most 5.
            searchLimit: 5,
            placeholder: 'Search tasks...',
            // Current blockers first, then open tasks (not this one, not finished).
            items: [
              ...allTasks.filter((t) => blockerIds.has(t.id)),
              ...allTasks.filter(
                (t) =>
                  t.id !== task.id &&
                  !blockerIds.has(t.id) &&
                  !t.archived_at &&
                  !t.is_temporary &&
                  !isTerminalStatus(
                    t.status,
                    t.project_id === task.project_id ? columnsConfig : undefined
                  )
              )
            ].map((t) => ({
              id: `blocker:${t.id}`,
              label: t.title,
              icon: CheckSquare,
              checked: blockerIds.has(t.id),
              keepOpen: true,
              run: () => toggleBlocker(t.id)
            }))
          }
        })
      }

      const today = new Date()
      const dueOption = (id: string, label: string, date: Date) => ({
        id: `due:${id}`,
        label,
        icon: CalendarDays,
        checked: task.due_date === format(date, 'yyyy-MM-dd'),
        run: () => {
          track('due_date_set')
          return update({ dueDate: format(date, 'yyyy-MM-dd') })
        }
      })
      commands.push({
        id: 'due-date',
        label: task.due_date ? 'Change due date…' : 'Set due date…',
        keywords: 'due deadline date',
        icon: CalendarDays,
        page: {
          kind: 'list',
          title: 'Due date',
          items: [
            dueOption('today', 'Today', today),
            dueOption('tomorrow', 'Tomorrow', addDays(today, 1)),
            dueOption('next-week', 'Next week', nextMonday(today)),
            dueOption('in-2-weeks', 'In 2 weeks', addDays(today, 14)),
            {
              id: 'due:custom',
              label: 'Pick a date…',
              icon: CalendarDays,
              page: {
                kind: 'prompt',
                title: 'Due date',
                placeholder: 'YYYY-MM-DD — Enter to set',
                initialValue: task.due_date ?? '',
                onSubmit: (value) => {
                  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return
                  track('due_date_set')
                  return update({ dueDate: value })
                }
              }
            },
            ...(task.due_date
              ? [
                  {
                    id: 'due:clear',
                    label: 'Clear due date',
                    icon: CalendarX,
                    run: () => update({ dueDate: null })
                  }
                ]
              : [])
          ]
        }
      })

      commands.push({
        id: 'complete-close',
        label: 'Complete & close',
        keywords: 'done finish',
        icon: CircleCheckBig,
        shortcutId: 'complete-close-tab',
        featured: true,
        run: () => useDialogStore.getState().openCompleteTaskDialog()
      })
      commands.push({
        id: 'new-subtask',
        label: 'New subtask…',
        keywords: 'child create add',
        icon: ListPlus,
        featured: true,
        page: {
          kind: 'prompt',
          title: 'New subtask',
          placeholder: 'Subtask title — Enter to create',
          onSubmit: (title) => onCreateSubTask(title)
        }
      })
      // Inline in the header when it is on screen; a prompt page otherwise (zen, compact).
      commands.push({
        id: 'rename',
        label: 'Rename task',
        keywords: 'title edit',
        icon: Pencil,
        ...(canRenameInline
          ? { takesFocus: true, run: onRenameInline }
          : {
              page: {
                kind: 'prompt' as const,
                title: 'Rename task',
                placeholder: 'Task title — Enter to save',
                initialValue: task.title,
                onSubmit: (title: string) => onRename(title)
              }
            })
      })
    }

    if (modes.length > 0) {
      commands.push({
        id: 'mode',
        label: 'Switch agent…',
        keywords: 'mode provider claude codex terminal',
        icon: Bot,
        page: {
          kind: 'list',
          title: 'Agent',
          items: modes
            .filter((m) => m.enabled || m.id === task.terminal_mode)
            .map((m) => ({
              id: `mode:${m.id}`,
              label: m.label,
              icon: Bot,
              checked: m.id === task.terminal_mode,
              run: () => {
                if (m.id !== task.terminal_mode) void onModeChange(m.id)
              }
            }))
        }
      })
    }
    commands.push({
      id: 'restart-agent',
      label: 'Restart agent',
      keywords: 'terminal respawn',
      icon: RotateCcw,
      shortcutId: 'terminal-restart',
      featured: true,
      run: onRestartAgent
    })
    if (task.terminal_mode !== 'terminal') {
      commands.push({
        id: 'stop-agent',
        label: 'Stop agent',
        keywords: 'shut down kill power off',
        icon: Power,
        run: onStopAgent
      })
    }
    commands.push({
      id: 'reset-terminal',
      label: 'Reset terminal',
      keywords: 'fresh clear session',
      icon: RefreshCcw,
      run: onResetTerminal
    })
    commands.push({
      id: 'reattach-terminal',
      label: 'Re-attach terminal',
      keywords: 'reconnect',
      icon: Plug,
      run: onReattachTerminal
    })
    commands.push({
      id: 'copy-history',
      label: 'Copy terminal history',
      keywords: 'clipboard output scrollback',
      icon: ClipboardCopy,
      run: onCopyHistory
    })
    if (task.terminal_mode !== 'terminal') {
      commands.push({
        id: 'edit-flags',
        label: 'Edit CLI flags…',
        keywords: 'flags arguments options',
        icon: Flag,
        run: onEditFlags
      })
      commands.push({
        id: 'reset-flags',
        label: 'Reset CLI flags to default',
        keywords: 'flags default',
        icon: FlagOff,
        run: onResetFlags
      })
      commands.push({
        id: 'doctor',
        label: 'Run doctor',
        keywords: 'diagnose check environment',
        icon: Stethoscope,
        run: onDoctor
      })
    }
    commands.push({
      id: 'inject-title',
      label: 'Insert title into terminal',
      icon: Heading,
      shortcutId: 'terminal-inject-title',
      run: onInjectTitle
    })
    if (hasDescription) {
      commands.push({
        id: 'inject-description',
        label: 'Insert description into terminal',
        icon: Text,
        shortcutId: 'terminal-inject-desc',
        run: onInjectDescription
      })
    }

    for (const panel of panels) {
      commands.push({
        id: `panel:${panel.id}`,
        label: `${panel.open ? 'Hide' : 'Show'} ${panel.label} panel`,
        keywords: 'panel toggle open close',
        icon: PanelRight,
        shortcutId: panel.shortcutId,
        run: () => onTogglePanel(panel.id)
      })
    }

    commands.push({
      id: 'copy-title',
      label: 'Copy task title',
      keywords: 'clipboard name',
      icon: Clipboard,
      run: () => {
        track('copy_title')
        void safeClipboardWriteText(task.title)
      }
    })
    commands.push({
      id: 'copy-link',
      label: 'Copy task link',
      keywords: 'clipboard url deep link',
      icon: Link,
      run: () => {
        track('copy_link')
        void safeClipboardWriteText(`slayzone://task/${task.id}`)
      }
    })
    commands.push({
      id: 'copy-id',
      label: 'Copy task ID',
      keywords: 'uuid clipboard',
      icon: Clipboard,
      run: () => void safeClipboardWriteText(task.id)
    })
    if (hasConversationId) {
      commands.push({
        id: 'copy-conversation-id',
        label: 'Copy conversation ID',
        keywords: 'session clipboard',
        icon: Clipboard,
        run: onCopyConversationId
      })
    }

    if (!task.is_temporary) {
      commands.push(
        isArchived
          ? { id: 'unarchive', label: 'Unarchive task', icon: ArchiveRestore, run: onUnarchive }
          : { id: 'archive', label: 'Archive task', icon: Archive, run: onArchive }
      )
      commands.push({ id: 'delete', label: 'Delete task', icon: Trash2, run: onDelete })
    }

    if (task.is_temporary) {
      commands.push({
        id: 'convert',
        label: 'Turn into task',
        keywords: 'temporary convert keep',
        icon: Wand2,
        featured: true,
        takesFocus: true,
        run: onConvertToTask
      })
      if (templates.length > 0) {
        commands.push({
          id: 'apply-template',
          label: 'Apply template…',
          keywords: 'template preset',
          icon: LayoutTemplate,
          page: {
            kind: 'list',
            title: 'Template',
            // Lists other entities: root search shows at most 5.
            searchLimit: 5,
            items: templates.map((t) => ({
              id: `template:${t.id}`,
              label: t.name,
              icon: LayoutTemplate,
              run: () => onApplyTemplate(t)
            }))
          }
        })
      }
    }
    if (parentTask) {
      commands.push({
        id: 'go-parent',
        label: `Go to parent task: ${parentTask.title}`,
        keywords: 'parent up subtask',
        icon: ArrowUpLeft,
        run: () => onNavigateToTask(parentTask.id)
      })
    }
    commands.push({
      id: 'close-task',
      label: 'Close task tab',
      keywords: 'close tab',
      icon: X,
      shortcutId: 'close-task',
      run: onCloseTask
    })
    if (windowAction) {
      commands.push({
        id: 'window',
        label: windowAction === 'detach' ? 'Open in new window' : 'Reattach to main window',
        keywords: 'detach window pop out',
        icon: AppWindow,
        run: onToggleWindow
      })
    }
    commands.push({
      id: 'new-artifact',
      label: 'New artifact',
      keywords: 'artifact file create',
      icon: FilePlus,
      run: onNewArtifact
    })
    if (browserOpen) {
      commands.push({
        id: 'browser-new-tab',
        label: 'New browser tab',
        keywords: 'browser tab',
        icon: Globe,
        shortcutId: 'browser-new-tab',
        run: onNewBrowserTab
      })
      commands.push({
        id: 'browser-screenshot',
        label: 'Screenshot browser into terminal',
        keywords: 'screenshot capture image',
        icon: Camera,
        run: onBrowserScreenshot
      })
    }
    if (task.linear_url) {
      const url = task.linear_url
      commands.push({
        id: 'open-linear',
        label: 'Open in Linear',
        keywords: 'linear issue external',
        icon: ExternalLink,
        run: () => onOpenExternal(url)
      })
    }

    scope = {
      key: task.id,
      title: task.is_temporary ? 'Temporary task' : task.title,
      commands
    }
  }

  usePublishPaletteCommands(scope, enabled)
}
