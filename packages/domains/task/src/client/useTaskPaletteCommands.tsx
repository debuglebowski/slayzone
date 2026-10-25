import { useMutation } from '@tanstack/react-query'
import {
  Archive,
  ArchiveRestore,
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
import type { TerminalModeInfo } from '@slayzone/terminal/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { priorityOptions, type Task } from '@slayzone/task/shared'

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
    canRenameInline
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

  const setStatus = useStableCallback(async (taskId: string, status: string) => {
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

    scope = {
      key: task.id,
      title: task.is_temporary ? 'Temporary task' : task.title,
      commands
    }
  }

  usePublishPaletteCommands(scope, enabled)
}
