import { useState, useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { ArrowDownToLineIcon, ArrowUpToLineIcon, CalendarIcon, Loader2, Pencil, Plus, X } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import { priorityOptions } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { isTerminalStatus } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import { CreateTagDialog } from '@slayzone/tags/client'
import type { ExternalLink, TaskSyncStatus } from '@slayzone/integrations/shared'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { Calendar } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { Checkbox } from '@slayzone/ui'
import {
  buildStatusOptions,
  cn
} from '@slayzone/ui'
import { toast } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'
import { Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import { ProjectSelect } from '@slayzone/projects'

interface TaskMetadataSidebarProps {
  task: Task
  tags: Tag[]
  taskTagIds: string[]
  onUpdate: (task: Task) => void
  onTagsChange: (tagIds: string[]) => void
  onTagCreated?: (tag: Tag) => void
}

export function TaskMetadataSidebar({
  task,
  tags,
  taskTagIds,
  onUpdate,
  onTagsChange,
  onTagCreated
}: TaskMetadataSidebarProps): React.JSX.Element {
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [blockers, setBlockers] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])

  // Load all tasks and current blockers
  useEffect(() => {
    const loadData = async () => {
      const [tasks, currentBlockers, allProjects] = await Promise.all([
        window.api.db.getTasks(),
        window.api.taskDependencies.getBlockers(task.id),
        window.api.db.getProjects()
      ])
      setAllTasks(tasks.filter((t) => t.id !== task.id))
      setBlockers(currentBlockers)
      setProjects(allProjects)
    }
    loadData()
  }, [task.id])

  const handleAddBlocker = async (blockerTaskId: string): Promise<void> => {
    await window.api.taskDependencies.addBlocker(task.id, blockerTaskId)
    const blockerTask = allTasks.find((t) => t.id === blockerTaskId)
    if (blockerTask) {
      setBlockers([...blockers, blockerTask])
    }
  }

  const handleRemoveBlocker = async (blockerTaskId: string): Promise<void> => {
    await window.api.taskDependencies.removeBlocker(task.id, blockerTaskId)
    setBlockers(blockers.filter((b) => b.id !== blockerTaskId))
  }

  const columnsByProject = new Map(projects.map((project) => [project.id, project.columns_config]))
  const availableBlockers = allTasks.filter((t) => (
    !blockers.some((b) => b.id === t.id) && !isTerminalStatus(t.status, columnsByProject.get(t.project_id))
  ))
  const selectedProject = projects.find((project) => project.id === task.project_id)
  const statusOptions = buildStatusOptions(selectedProject?.columns_config)

  const handleStatusChange = async (status: string): Promise<void> => {
    track('task_status_changed', { from: task.status, to: status })
    if (isTerminalStatus(status, selectedProject?.columns_config)) {
      track('task_completed', { provider: task.terminal_mode ?? 'terminal', had_worktree: Boolean(task.worktree_path) })
    }
    const updated = await window.api.db.updateTask({ id: task.id, status })
    onUpdate(updated)
  }

  const handleProjectChange = async (projectId: string): Promise<void> => {
    track('task_moved_to_project')
    const updated = await window.api.db.updateTask({ id: task.id, projectId })
    onUpdate(updated)
  }

  const handlePriorityChange = async (priority: number): Promise<void> => {
    track('task_priority_changed', { priority: String(priority) })
    const updated = await window.api.db.updateTask({ id: task.id, priority })
    onUpdate(updated)
  }

  const handleDueDateChange = async (date: Date | undefined): Promise<void> => {
    track('due_date_set')
    const dueDate = date ? format(date, 'yyyy-MM-dd') : undefined
    const updated = await window.api.db.updateTask({ id: task.id, dueDate })
    onUpdate(updated)
  }

  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const [editingTag, setEditingTag] = useState<Tag | null>(null)

  const handleTagCreated = async (tag: Tag): Promise<void> => {
    onTagCreated?.(tag)
    // Auto-assign to current task
    const newTagIds = [...taskTagIds, tag.id]
    await window.api.taskTags.setTagsForTask(task.id, newTagIds)
    onTagsChange(newTagIds)
  }

  const handleTagToggle = async (tagId: string, checked: boolean): Promise<void> => {
    if (checked) track('tag_assigned')
    const newTagIds = checked ? [...taskTagIds, tagId] : taskTagIds.filter((id) => id !== tagId)
    await window.api.taskTags.setTagsForTask(task.id, newTagIds)
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
                  {opt.label}
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
                    <span className={cn('size-2 rounded-full', {
                      'bg-red-500': opt.value === 1,
                      'bg-orange-500': opt.value === 2,
                      'bg-yellow-500': opt.value === 3,
                      'bg-blue-400': opt.value === 4,
                      'bg-neutral-400': opt.value === 5,
                    })} />
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
                {task.due_date ? format(new Date(task.due_date), 'MMM d, yyyy') : 'No date'}
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
            {tags.length > 0 && (
              <div className="space-y-0.5">
                {tags.map((tag) => (
                  <label key={tag.id} className="group flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
                    <Checkbox
                      checked={taskTagIds.includes(tag.id)}
                      onCheckedChange={(checked) => handleTagToggle(tag.id, checked === true)}
                    />
                    <span
                      className="flex-1 rounded px-2 py-1 text-sm font-medium inline-flex items-center justify-between gap-1"
                      style={{ backgroundColor: tag.color, color: tag.text_color }}
                    >
                      {tag.name}
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingTag(tag); setTagDialogOpen(true) }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className={tags.length > 0 ? 'border-t mt-1.5 pt-1' : ''}>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground h-7 px-1.5"
                onClick={() => { setEditingTag(null); setTagDialogOpen(true) }}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                New tag
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <CreateTagDialog
          open={tagDialogOpen}
          onOpenChange={setTagDialogOpen}
          projectId={task.project_id}
          tag={editingTag}
          onCreated={handleTagCreated}
          onUpdated={() => {}}
        />
      </div>

      {/* Blocked By */}
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Blocked By</label>
        {blockers.length > 0 && (
          <div className="mb-2 space-y-1">
            {blockers.map((blocker) => (
              <div
                key={blocker.id}
                className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-sm"
              >
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
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="w-full">
              Add blocker
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[250px] p-2" align="start">
            {availableBlockers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks available</p>
            ) : (
              <div className="max-h-[200px] space-y-1 overflow-y-auto">
                {availableBlockers.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => handleAddBlocker(t.id)}
                    className="w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  >
                    <span className="line-clamp-1">{t.title}</span>
                  </button>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
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
  const [links, setLinks] = useState<ExternalLink[]>([])
  const [syncStatusByLinkId, setSyncStatusByLinkId] = useState<Record<string, TaskSyncStatus>>({})
  const [linkLoadingById, setLinkLoadingById] = useState<Record<string, 'open' | 'pull' | 'push' | undefined>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [linearLink, githubLink] = await Promise.all([
          window.api.integrations.getLink(taskId, 'linear'),
          window.api.integrations.getLink(taskId, 'github')
        ])

        const loadedLinks = [linearLink, githubLink].filter((link): link is ExternalLink => Boolean(link))
        if (cancelled) return
        setLinks(loadedLinks)

        if (loadedLinks.length === 0) {
          setSyncStatusByLinkId({})
          return
        }

        const statusEntries = await Promise.all(loadedLinks.map(async (link) => {
          try {
            const status = await window.api.integrations.getTaskSyncStatus(taskId, link.provider)
            return [link.id, status] as const
          } catch {
            return [link.id, toUnknownSyncStatus(link, taskId)] as const
          }
        }))

        if (cancelled) return
        setSyncStatusByLinkId(Object.fromEntries(statusEntries))
      } catch {
        if (cancelled) return
        setLinks([])
        setSyncStatusByLinkId({})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [taskId])

  const refreshLinkSyncStatus = async (link: ExternalLink) => {
    try {
      const status = await window.api.integrations.getTaskSyncStatus(taskId, link.provider)
      setSyncStatusByLinkId((current) => ({ ...current, [link.id]: status }))
    } catch {
      setSyncStatusByLinkId((current) => ({ ...current, [link.id]: toUnknownSyncStatus(link, taskId) }))
    }
  }

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
      await window.api.shell.openExternal(link.external_url)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      await refreshLinkSyncStatus(link)
      setLinkLoading(link.id, null)
    }
  }

  const handlePull = async (link: ExternalLink) => {
    setLinkLoading(link.id, 'pull')
    try {
      if (link.provider === 'linear') {
        const result = await window.api.integrations.syncNow({ taskId })
        const errSuffix = result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''
        const message = `${PROVIDER_LABELS[link.provider]} synced: ${result.pulled} pulled, ${result.pushed} pushed${errSuffix}`
        if (result.errors.length > 0) toast.error(message)
        else toast.success(message)
        const refreshedTask = await window.api.db.getTask(taskId)
        if (refreshedTask) onUpdate(refreshedTask)
        return
      }

      const result = await window.api.integrations.pullTask({
        taskId,
        provider: 'github'
      })
      const message = result.message ?? (result.pulled ? 'Pulled remote changes from GitHub' : 'No pull performed')
      if (result.pulled) toast.success(message)
      else toast(message)
      if (result.pulled) {
        const refreshedTask = await window.api.db.getTask(taskId)
        if (refreshedTask) onUpdate(refreshedTask)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      await refreshLinkSyncStatus(link)
      setLinkLoading(link.id, null)
    }
  }

  const handlePush = async (link: ExternalLink) => {
    setLinkLoading(link.id, 'push')
    try {
      if (link.provider === 'linear') {
        const result = await window.api.integrations.syncNow({ taskId })
        const errSuffix = result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''
        const message = `${PROVIDER_LABELS[link.provider]} synced: ${result.pulled} pulled, ${result.pushed} pushed${errSuffix}`
        if (result.pushed > 0) toast.success(message)
        else if (result.errors.length > 0) toast.error(message)
        else toast(message)
        if (result.pulled > 0) {
          const refreshedTask = await window.api.db.getTask(taskId)
          if (refreshedTask) onUpdate(refreshedTask)
        }
        return
      }

      const result = await window.api.integrations.pushTask({
        taskId,
        provider: 'github'
      })
      const message = result.message ?? (result.pushed ? 'Pushed local changes to GitHub' : 'No push performed')
      if (result.pushed) toast.success(message)
      else toast(message)
      if (result.pushed) {
        const refreshedTask = await window.api.db.getTask(taskId)
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
