import { useState, useEffect, useRef, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ArrowDownToLineIcon, ArrowUpToLineIcon, CalendarIcon, Gauge, ListChecks, Loader2, MessageSquare, X, AlarmClock, SearchIcon } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import { priorityOptions } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { isCompletedStatus, isTerminalStatus } from '@slayzone/projects/shared'
import { TaskProgressPopover } from './TaskProgressPopover'
import type { Tag } from '@slayzone/tags/shared'
import { TagSelector } from '@slayzone/tags/client'
import { useTRPC } from '@slayzone/transport/client'
import type { ExternalLink, TaskSyncStatus } from '@slayzone/integrations/shared'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { SplitButton, SplitButtonItem } from '@slayzone/ui'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Calendar } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import {
  buildStatusOptions,
  cn,
  getColumnStatusStyle,
  Input,
  PriorityIcon,
  Textarea
} from '@slayzone/ui'
import { toast } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'
import { Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import { ProjectSelect } from '@slayzone/projects'
import { SnoozePicker } from './SnoozePicker'

interface TaskMetadataSidebarProps {
  task: Task
  tags: Tag[]
  taskTagIds: string[]
  onUpdate: (task: Task) => void
  onTagsChange: (tagIds: string[]) => void
  onTagCreated?: (tag: Tag) => void
}

function matchesTaskSearch(task: Task, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return task.title.toLowerCase().includes(normalizedQuery)
}

export function BlockerStatusIcon({
  task,
  columns
}: {
  task: Task
  columns?: Project['columns_config']
}): React.JSX.Element | null {
  const statusStyle = getColumnStatusStyle(task.status, columns)
  const StatusIcon = statusStyle?.icon

  if (!StatusIcon) return null

  return (
    <span className="shrink-0" title={statusStyle.label}>
      <StatusIcon
        aria-hidden="true"
        className={cn('size-3.5', statusStyle.iconClass)}
        strokeWidth={2.5}
      />
    </span>
  )
}

export function TaskMetadataSidebar({
  task,
  tags,
  taskTagIds,
  onUpdate,
  onTagsChange,
  onTagCreated
}: TaskMetadataSidebarProps): React.JSX.Element {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [addBlockerSearch, setAddBlockerSearch] = useState('')
  const [blockerDialogOpen, setBlockerDialogOpen] = useState(false)
  const [commentDialogOpen, setCommentDialogOpen] = useState(false)
  const [blockedComment, setBlockedComment] = useState('')

  const allTasksQuery = useQuery(trpc.task.getAll.queryOptions())
  const blockersQuery = useQuery(trpc.task.getBlockers.queryOptions({ taskId: task.id }))
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())

  const allTasks = (allTasksQuery.data ?? []).filter((t) => t.id !== task.id)
  const blockers = blockersQuery.data ?? []
  const projects = projectsQuery.data ?? []

  // Reset search input when task changes
  useEffect(() => { setAddBlockerSearch('') }, [task.id])

  const updateTaskMutation = useMutation(trpc.task.update.mutationOptions())
  const addBlockerMutation = useMutation(trpc.task.addBlocker.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.task.getBlockers.queryKey({ taskId: task.id }) }),
  }))
  const removeBlockerMutation = useMutation(trpc.task.removeBlocker.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.task.getBlockers.queryKey({ taskId: task.id }) }),
  }))
  const setTagsForTaskMutation = useMutation(trpc.tags.setForTask.mutationOptions())

  const handleAddBlocker = useCallback(async (blockerTaskId: string): Promise<void> => {
    await addBlockerMutation.mutateAsync({ taskId: task.id, blockerTaskId })
    setAddBlockerSearch('')
  }, [task.id, addBlockerMutation])

  const handleRemoveBlocker = useCallback(async (blockerTaskId: string): Promise<void> => {
    await removeBlockerMutation.mutateAsync({ taskId: task.id, blockerTaskId })
  }, [task.id, removeBlockerMutation])

  const handleSetBlocked = useCallback(async (): Promise<void> => {
    track('task_blocked', {})
    const updated = await updateTaskMutation.mutateAsync({ id: task.id, isBlocked: true })
    onUpdate(updated)
  }, [task.id, updateTaskMutation, onUpdate])

  const handleUnblock = useCallback(async (): Promise<void> => {
    track('task_unblocked')
    const updated = await updateTaskMutation.mutateAsync({ id: task.id, isBlocked: false, blockedComment: null })
    onUpdate(updated)
  }, [task.id, updateTaskMutation, onUpdate])

  const handleSetBlockedWithComment = useCallback(async (): Promise<void> => {
    track('task_blocked', { hasComment: 'true' })
    const updated = await updateTaskMutation.mutateAsync({
      id: task.id,
      isBlocked: true,
      blockedComment: blockedComment.trim() || null
    })
    onUpdate(updated)
    setCommentDialogOpen(false)
    setBlockedComment('')
  }, [task.id, blockedComment, updateTaskMutation, onUpdate])

  const columnsByProject = new Map(projects.map((project) => [project.id, project.columns_config]))
  const availableBlockers = allTasks.filter((t) => (
    !blockers.some((b) => b.id === t.id) && !isTerminalStatus(t.status, columnsByProject.get(t.project_id))
  ))
  const filteredAvailableBlockers = availableBlockers.filter((blocker) => matchesTaskSearch(blocker, addBlockerSearch))
  const selectedProject = projects.find((project) => project.id === task.project_id)
  const statusOptions = buildStatusOptions(selectedProject?.columns_config)

  const handleStatusChange = async (status: string): Promise<void> => {
    track('task_status_changed', { from: task.status, to: status })
    if (isTerminalStatus(status, selectedProject?.columns_config)) {
      track('task_completed', { provider: task.terminal_mode ?? 'terminal', had_worktree: Boolean(task.worktree_path) })
    }
    const updated = await updateTaskMutation.mutateAsync({ id: task.id, status })
    onUpdate(updated)
  }

  const handleProjectChange = async (projectId: string): Promise<void> => {
    track('task_moved_to_project')
    const updated = await updateTaskMutation.mutateAsync({ id: task.id, projectId })
    onUpdate(updated)
  }

  const handlePriorityChange = async (priority: number): Promise<void> => {
    track('task_priority_changed', { priority: String(priority) })
    const updated = await updateTaskMutation.mutateAsync({ id: task.id, priority })
    onUpdate(updated)
  }

  const handleDueDateChange = async (date: Date | undefined): Promise<void> => {
    track('due_date_set')
    const dueDate = date ? format(date, 'yyyy-MM-dd') : null
    const updated = await updateTaskMutation.mutateAsync({ id: task.id, dueDate })
    onUpdate(updated)
  }

  const handleSnooze = async (until: string): Promise<void> => {
    track('task_snoozed')
    const updated = await updateTaskMutation.mutateAsync({ id: task.id, snoozedUntil: until })
    onUpdate(updated)
  }

  const handleUnsnooze = async (): Promise<void> => {
    track('task_unsnoozed')
    const updated = await updateTaskMutation.mutateAsync({ id: task.id, snoozedUntil: null })
    onUpdate(updated)
  }

  const handleProgressChange = async (progress: number): Promise<void> => {
    track('task_progress_changed', { value: String(progress) })
    const updated = await updateTaskMutation.mutateAsync({ id: task.id, progress })
    onUpdate(updated)
  }

  const isSnoozed = task.snoozed_until && new Date(task.snoozed_until) > new Date()

  const handleTagToggle = async (tagId: string, checked: boolean): Promise<void> => {
    if (checked) track('tag_assigned')
    const newTagIds = checked ? [...taskTagIds, tagId] : taskTagIds.filter((id) => id !== tagId)
    await setTagsForTaskMutation.mutateAsync({ taskId: task.id, tagIds: newTagIds })
    onTagsChange(newTagIds)
  }

  const selectedTags = tags.filter((t) => taskTagIds.includes(t.id))

  // Measure how many tag pills fit in the button
  const [maxVisible, setMaxVisible] = useState(Infinity)
  const measureContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = measureContainerRef.current
    if (!el) return
    const measure = () => {
      const children = Array.from(el.querySelectorAll('[data-tag]')) as HTMLElement[]
      if (children.length === 0) { setMaxVisible(Infinity); return }
      const containerRight = el.getBoundingClientRect().right
      const reserve = children.length > 1 ? 32 : 0
      let count = 0
      for (const child of children) {
        if (child.getBoundingClientRect().right <= containerRight - reserve) count++
        else break
      }
      setMaxVisible(Math.max(1, count))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [selectedTags.length])

  return (
    <div className="space-y-2">
      {/* Project & Status */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Project</label>
          <ProjectSelect value={task.project_id} onChange={handleProjectChange} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Status</label>
          <Select value={task.status} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className="flex items-center gap-1.5">
                    <opt.icon className={cn('size-3.5', opt.iconClass)} />
                    {opt.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Priority & Due Date */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Priority</label>
          <Select
            value={String(task.priority)}
            onValueChange={(v) => handlePriorityChange(Number(v))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {priorityOptions.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)}>
                  <span className="flex items-center gap-1.5">
                    <PriorityIcon priority={opt.value} className="h-3.5 w-3.5" />
                    {opt.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Due Date</label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  'w-full justify-start text-left font-normal',
                  !task.due_date && 'text-muted-foreground'
                )}
              >
                <CalendarIcon className="mr-2 size-4" />
                <span className="flex-1">{task.due_date ? format(new Date(task.due_date), 'MMM d, yyyy') : 'No date'}</span>
                {task.due_date && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDueDateChange(undefined) }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={task.due_date ? new Date(task.due_date) : undefined}
                onSelect={handleDueDateChange}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Snooze + Progress */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Snooze</label>
          {isSnoozed ? (
            <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm">
              <AlarmClock className="size-3.5 text-muted-foreground shrink-0" />
              <span className="flex-1 truncate">{format(new Date(task.snoozed_until!), 'MMM d · h:mm a')}</span>
              <button onClick={handleUnsnooze} className="text-muted-foreground hover:text-foreground shrink-0">
                <X className="size-3.5" />
              </button>
            </div>
          ) : (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start text-muted-foreground">
                  <AlarmClock className="mr-2 size-4" />
                  Not snoozed
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <SnoozePicker onSnooze={handleSnooze} />
              </PopoverContent>
            </Popover>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Progress</label>
          {isCompletedStatus(task.status, selectedProject?.columns_config) ? (
            <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground">
              <span className="flex-1 truncate">Complete</span>
            </div>
          ) : (
            <div className="flex items-stretch">
              <TaskProgressPopover
                value={task.progress ?? 0}
                onCommit={handleProgressChange}
                align="start"
              >
                <Button
                  variant="outline"
                  className={cn(
                    'flex-1 justify-start min-w-0',
                    (task.progress ?? 0) > 0 && 'rounded-r-none border-r-0',
                    (task.progress ?? 0) === 0 && 'text-muted-foreground',
                  )}
                >
                  <Gauge className="mr-2 size-4 shrink-0" />
                  <span className="flex-1 text-left truncate">
                    {(task.progress ?? 0) === 0 ? 'Not started' : `${task.progress}%`}
                  </span>
                </Button>
              </TaskProgressPopover>
              {(task.progress ?? 0) > 0 && (
                <Button
                  variant="outline"
                  className="rounded-l-none px-2 text-muted-foreground hover:text-foreground shrink-0"
                  onClick={() => handleProgressChange(0)}
                  aria-label="Clear progress"
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tags */}
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Tags</label>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-start p-1 overflow-hidden relative">
              {selectedTags.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <>
                  {/* Hidden measurement layer — renders all tags to measure which fit */}
                  <div ref={measureContainerRef} className="flex flex-nowrap gap-1 absolute inset-0 p-1 pointer-events-none opacity-0" aria-hidden="true">
                    {selectedTags.map((tag) => (
                      <span key={tag.id} data-tag className="rounded px-1.5 py-1 text-xs font-medium shrink-0">
                        {tag.name}
                      </span>
                    ))}
                  </div>
                  {/* Visible layer — shows only the tags that fit */}
                  <div className="flex flex-nowrap gap-1 min-w-0">
                    {selectedTags.slice(0, maxVisible).map((tag) => (
                      <span
                        key={tag.id}
                        className="rounded px-1.5 py-1 text-xs font-medium shrink-0"
                        style={{ backgroundColor: tag.color, color: tag.text_color }}
                      >
                        {tag.name}
                      </span>
                    ))}
                    {selectedTags.length > maxVisible && (
                      <span data-overflow="true" className="rounded px-1.5 py-1 text-xs font-medium shrink-0 bg-muted text-muted-foreground">
                        +{selectedTags.length - maxVisible}
                      </span>
                    )}
                  </div>
                </>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[200px] p-1.5">
            <TagSelector
              tags={tags}
              selectedTagIds={taskTagIds}
              projectId={task.project_id}
              onToggle={handleTagToggle}
              onTagCreated={(tag) => {
                onTagCreated?.(tag)
                window.dispatchEvent(new CustomEvent('slayzone:tag-created', { detail: tag }))
              }}
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* Blocked By */}
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Blocked By</label>
        {task.blocked_comment && (
          <div className="mb-2 flex items-start gap-2 rounded bg-muted/50 px-2 py-1.5 text-sm text-muted-foreground">
            <span className="flex-1 whitespace-pre-wrap">{task.blocked_comment}</span>
            <button
              onClick={async () => {
                const updated = await updateTaskMutation.mutateAsync({ id: task.id, blockedComment: null })
                onUpdate(updated)
              }}
              className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {blockers.length > 0 && (
          <div className="mb-2 space-y-1">
            {blockers.map((blocker) => (
              <div
                key={blocker.id}
                className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-sm"
              >
                <BlockerStatusIcon task={blocker} columns={columnsByProject.get(blocker.project_id)} />
                <span className="flex-1 truncate">{blocker.title}</span>
                <button
                  onClick={() => handleRemoveBlocker(blocker.id)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Split button: Set blocked / Unblock */}
        <SplitButton
          onClick={task.is_blocked ? handleUnblock : handleSetBlocked}
          className="flex-1"
          menu={(close) => (
            <>
              <SplitButtonItem onClick={() => { close(); setBlockerDialogOpen(true) }}>
                <ListChecks className="h-3 w-3 shrink-0 text-muted-foreground" />
                Set blocking task
              </SplitButtonItem>
              <SplitButtonItem onClick={() => {
                close()
                setBlockedComment(task.blocked_comment ?? '')
                setCommentDialogOpen(true)
              }}>
                <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
                Set blocked with comment
              </SplitButtonItem>
            </>
          )}
        >
          {task.is_blocked ? 'Unblock' : 'Set blocked'}
        </SplitButton>

        {/* Blocking task dialog */}
        <Dialog open={blockerDialogOpen} onOpenChange={(open) => { setBlockerDialogOpen(open); if (!open) setAddBlockerSearch('') }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Add blocking task</DialogTitle>
            </DialogHeader>
            {availableBlockers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks available</p>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={addBlockerSearch}
                    onChange={(e) => setAddBlockerSearch(e.target.value)}
                    aria-label="Search available blockers"
                    placeholder="Search tasks..."
                    className="h-8 pl-8 text-sm"
                  />
                </div>
                {filteredAvailableBlockers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tasks match your search</p>
                ) : (
                  <div className="max-h-[200px] space-y-1 overflow-y-auto">
                    {filteredAvailableBlockers.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => { handleAddBlocker(t.id); setBlockerDialogOpen(false) }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                      >
                        <BlockerStatusIcon task={t} columns={columnsByProject.get(t.project_id)} />
                        <span className="line-clamp-1 flex-1">{t.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Blocked with comment dialog */}
        <Dialog open={commentDialogOpen} onOpenChange={(open) => { setCommentDialogOpen(open); if (!open) setBlockedComment('') }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Set blocked with comment</DialogTitle>
            </DialogHeader>
            <Textarea
              value={blockedComment}
              onChange={(e) => setBlockedComment(e.target.value)}
              placeholder="Why is this task blocked?"
              rows={3}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setCommentDialogOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={handleSetBlockedWithComment}>Set blocked</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

    </div>
  )
}

// ---------------------------------------------------------------------------
// External Sync Card (provider-aware scaffold)
// ---------------------------------------------------------------------------

interface ExternalSyncCardProps {
  taskId: string
  onUpdate: (task: Task) => void
}

const PROVIDER_LABELS: Record<ExternalLink['provider'], string> = {
  linear: 'Linear',
  github: 'GitHub',
  jira: 'Jira'
}

const SYNC_STATE_META: Record<TaskSyncStatus['state'], { label: string; className: string }> = {
  in_sync: { label: 'In sync', className: 'bg-emerald-500/15 text-emerald-300' },
  local_ahead: { label: 'Local ahead', className: 'bg-blue-500/15 text-blue-300' },
  remote_ahead: { label: 'Remote ahead', className: 'bg-amber-500/15 text-amber-300' },
  conflict: { label: 'Conflict', className: 'bg-red-500/15 text-red-300' },
  unknown: { label: 'Unknown', className: 'bg-muted text-muted-foreground' }
}

function toUnknownSyncStatus(link: ExternalLink, taskId: string): TaskSyncStatus {
  return {
    provider: link.provider,
    taskId,
    state: 'unknown',
    fields: [],
    comparedAt: new Date().toISOString()
  }
}

export function ExternalSyncCard({ taskId, onUpdate }: ExternalSyncCardProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [linkLoadingById, setLinkLoadingById] = useState<Record<string, 'open' | 'pull' | 'push' | undefined>>({})

  const linearLinkQuery = useQuery(trpc.integrations.getLink.queryOptions({ taskId, provider: 'linear' }))
  const githubLinkQuery = useQuery(trpc.integrations.getLink.queryOptions({ taskId, provider: 'github' }))

  const links: ExternalLink[] = [linearLinkQuery.data, githubLinkQuery.data].filter((link): link is ExternalLink => Boolean(link))

  const syncStatusQueries = [
    useQuery({
      ...trpc.integrations.getTaskSyncStatus.queryOptions({ taskId, provider: 'linear' }),
      enabled: !!linearLinkQuery.data,
    }),
    useQuery({
      ...trpc.integrations.getTaskSyncStatus.queryOptions({ taskId, provider: 'github' }),
      enabled: !!githubLinkQuery.data,
    }),
  ]

  const syncStatusByLinkId: Record<string, TaskSyncStatus> = {}
  if (linearLinkQuery.data && syncStatusQueries[0].data) {
    syncStatusByLinkId[linearLinkQuery.data.id] = syncStatusQueries[0].data
  } else if (linearLinkQuery.data) {
    syncStatusByLinkId[linearLinkQuery.data.id] = toUnknownSyncStatus(linearLinkQuery.data, taskId)
  }
  if (githubLinkQuery.data && syncStatusQueries[1].data) {
    syncStatusByLinkId[githubLinkQuery.data.id] = syncStatusQueries[1].data
  } else if (githubLinkQuery.data) {
    syncStatusByLinkId[githubLinkQuery.data.id] = toUnknownSyncStatus(githubLinkQuery.data, taskId)
  }

  const refreshLinkSyncStatus = (link: ExternalLink) => {
    queryClient.invalidateQueries({ queryKey: trpc.integrations.getTaskSyncStatus.queryKey({ taskId, provider: link.provider }) })
  }

  const openExternalMutation = useMutation(trpc.app.shell.openExternal.mutationOptions())
  const syncNowMutation = useMutation(trpc.integrations.syncNow.mutationOptions())
  const pullTaskMutation = useMutation(trpc.integrations.pullTask.mutationOptions())
  const pushTaskMutation = useMutation(trpc.integrations.pushTask.mutationOptions())
  const taskGetMutation = useMutation({
    mutationFn: async (input: { id: string }) => {
      const r = await queryClient.fetchQuery(trpc.task.get.queryOptions(input))
      return r
    },
  })

  const setLinkLoading = (linkId: string, action: 'open' | 'pull' | 'push' | null) => {
    setLinkLoadingById((current) => {
      const next = { ...current }
      if (action === null) {
        delete next[linkId]
      } else {
        next[linkId] = action
      }
      return next
    })
  }

  const handleOpen = async (link: ExternalLink) => {
    if (!link.external_url) return
    setLinkLoading(link.id, 'open')
    try {
      await openExternalMutation.mutateAsync({ url: link.external_url })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      refreshLinkSyncStatus(link)
      setLinkLoading(link.id, null)
    }
  }

  const handlePull = async (link: ExternalLink) => {
    setLinkLoading(link.id, 'pull')
    try {
      if (link.provider === 'linear') {
        const result = await syncNowMutation.mutateAsync({ taskId })
        const errSuffix = result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''
        const message = `${PROVIDER_LABELS[link.provider]} synced: ${result.pulled} pulled, ${result.pushed} pushed${errSuffix}`
        if (result.errors.length > 0) toast.error(message)
        else toast.success(message)
        const refreshedTask = await taskGetMutation.mutateAsync({ id: taskId })
        if (refreshedTask) onUpdate(refreshedTask)
        return
      }

      const result = await pullTaskMutation.mutateAsync({ taskId, provider: 'github' })
      const message = result.message ?? (result.pulled ? 'Pulled remote changes from GitHub' : 'No pull performed')
      if (result.pulled) toast.success(message)
      else toast(message)
      if (result.pulled) {
        const refreshedTask = await taskGetMutation.mutateAsync({ id: taskId })
        if (refreshedTask) onUpdate(refreshedTask)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      refreshLinkSyncStatus(link)
      setLinkLoading(link.id, null)
    }
  }

  const handlePush = async (link: ExternalLink) => {
    setLinkLoading(link.id, 'push')
    try {
      if (link.provider === 'linear') {
        const result = await syncNowMutation.mutateAsync({ taskId })
        const errSuffix = result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''
        const message = `${PROVIDER_LABELS[link.provider]} synced: ${result.pulled} pulled, ${result.pushed} pushed${errSuffix}`
        if (result.pushed > 0) toast.success(message)
        else if (result.errors.length > 0) toast.error(message)
        else toast(message)
        if (result.pulled > 0) {
          const refreshedTask = await taskGetMutation.mutateAsync({ id: taskId })
          if (refreshedTask) onUpdate(refreshedTask)
        }
        return
      }

      const result = await pushTaskMutation.mutateAsync({ taskId, provider: 'github' })
      const message = result.message ?? (result.pushed ? 'Pushed local changes to GitHub' : 'No push performed')
      if (result.pushed) toast.success(message)
      else toast(message)
      if (result.pushed) {
        const refreshedTask = await taskGetMutation.mutateAsync({ id: taskId })
        if (refreshedTask) onUpdate(refreshedTask)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLinkLoading(link.id, null)
    }
  }

  if (links.length === 0) return null

  return (
    <div className="space-y-2">
      {links.map((link) => {
        const loadingAction = linkLoadingById[link.id]
        const linkBusy = Boolean(loadingAction)
        const syncStatus = syncStatusByLinkId[link.id]
        return (
          <div
            key={link.id}
            role={link.external_url && !linkBusy ? 'link' : undefined}
            tabIndex={link.external_url && !linkBusy ? 0 : -1}
            className={cn(
              'flex items-center gap-1.5 rounded-md border border-border bg-muted/25 px-2 py-1.5',
              link.external_url && !linkBusy ? 'cursor-pointer hover:bg-muted/60' : 'cursor-default'
            )}
            onClick={() => void handleOpen(link)}
            onKeyDown={(event) => {
              if (!link.external_url || linkBusy) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                void handleOpen(link)
              }
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2" title={link.external_key}>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {PROVIDER_LABELS[link.provider]}
              </span>
              {loadingAction === 'open' ? (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              ) : null}
              <span className="truncate text-xs text-muted-foreground">{link.external_key}</span>
              {syncStatus ? (
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                    SYNC_STATE_META[syncStatus.state].className
                  )}
                >
                  {SYNC_STATE_META[syncStatus.state].label}
                </span>
              ) : null}
            </div>

            <div className="ml-auto flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Pull from external issue"
                    className="size-7"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handlePull(link)
                    }}
                    disabled={linkBusy}
                  >
                    {loadingAction === 'pull' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowDownToLineIcon className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Pull</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Push to external issue"
                    className="size-7"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handlePush(link)
                    }}
                    disabled={linkBusy}
                  >
                    {loadingAction === 'push' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowUpToLineIcon className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Push</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function LinearCard(props: ExternalSyncCardProps) {
  return <ExternalSyncCard {...props} />
}
