import { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { CalendarIcon, ChevronRight, EllipsisIcon, ExternalLinkIcon, RefreshCwIcon, UnlinkIcon, X } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import { priorityOptions } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { isTerminalStatus } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { ExternalLink } from '@slayzone/integrations/shared'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { Calendar } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { Checkbox } from '@slayzone/ui'
import {
  buildStatusOptions,
  cn,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@slayzone/ui'
import { ProjectSelect } from '@slayzone/projects'

interface TaskMetadataSidebarProps {
  task: Task
  tags: Tag[]
  taskTagIds: string[]
  onUpdate: (task: Task) => void
  onTagsChange: (tagIds: string[]) => void
}

export function TaskMetadataSidebar({
  task,
  tags,
  taskTagIds,
  onUpdate,
  onTagsChange
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
  }, [task.id, task.project_id])

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
    const updated = await window.api.db.updateTask({ id: task.id, status })
    onUpdate(updated)
  }

  const handleProjectChange = async (projectId: string): Promise<void> => {
    const updated = await window.api.db.updateTask({ id: task.id, projectId })
    onUpdate(updated)
  }

  const handlePriorityChange = async (priority: number): Promise<void> => {
    const updated = await window.api.db.updateTask({ id: task.id, priority })
    onUpdate(updated)
  }

  const handleDueDateChange = async (date: Date | undefined): Promise<void> => {
    const dueDate = date ? format(date, 'yyyy-MM-dd') : undefined
    const updated = await window.api.db.updateTask({ id: task.id, dueDate })
    onUpdate(updated)
  }

  const handleTagToggle = async (tagId: string, checked: boolean): Promise<void> => {
    const newTagIds = checked ? [...taskTagIds, tagId] : taskTagIds.filter((id) => id !== tagId)
    await window.api.taskTags.setTagsForTask(task.id, newTagIds)
    onTagsChange(newTagIds)
  }

  const selectedTags = tags.filter((t) => taskTagIds.includes(t.id))

  return (
    <div className="space-y-2">
      {/* Project */}
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Project</label>
        <ProjectSelect value={task.project_id} onChange={handleProjectChange} />
      </div>

      {/* Status */}
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

      {/* Priority */}
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
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Due Date */}
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

      {/* Tags */}
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Tags</label>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-start">
              {selectedTags.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {selectedTags.slice(0, 3).map((tag) => (
                    <span
                      key={tag.id}
                      className="rounded px-1.5 py-0.5 text-xs"
                      style={{ backgroundColor: tag.color + '30', color: tag.color }}
                    >
                      {tag.name}
                    </span>
                  ))}
                  {selectedTags.length > 3 && (
                    <span className="text-xs text-muted-foreground">
                      +{selectedTags.length - 3}
                    </span>
                  )}
                </div>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[200px] p-2">
            {tags.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tags created</p>
            ) : (
              <div className="space-y-2">
                {tags.map((tag) => (
                  <label key={tag.id} className="flex cursor-pointer items-center gap-2">
                    <Checkbox
                      checked={taskTagIds.includes(tag.id)}
                      onCheckedChange={(checked) => handleTagToggle(tag.id, checked === true)}
                    />
                    <span
                      className="rounded px-1.5 py-0.5 text-sm"
                      style={{ backgroundColor: tag.color + '30', color: tag.color }}
                    >
                      {tag.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* Blocked By */}
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Blocked By</label>
        <>
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
        </>
      </div>

    </div>
  )
}

// ---------------------------------------------------------------------------
// Linear Card (separate L2 island)
// ---------------------------------------------------------------------------

interface LinearCardProps {
  taskId: string
  onUpdate: (task: Task) => void
}

export function LinearCard({ taskId, onUpdate }: LinearCardProps) {
  const [linearLink, setLinearLink] = useState<ExternalLink | null>(null)
  const [syncMessage, setSyncMessage] = useState('')

  useEffect(() => {
    void window.api.integrations.getLink(taskId, 'linear').then(setLinearLink)
  }, [taskId])

  const handleSync = async () => {
    if (!linearLink) return
    const result = await window.api.integrations.syncNow({ taskId })
    const errSuffix = result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''
    setSyncMessage(`Synced: ${result.pulled} pulled, ${result.pushed} pushed${errSuffix}`)
    const refreshedTask = await window.api.db.getTask(taskId)
    if (refreshedTask) onUpdate(refreshedTask)
  }

  const handleUnlink = async () => {
    if (!linearLink) return
    await window.api.integrations.unlinkTask(taskId, 'linear')
    setLinearLink(null)
    setSyncMessage('Unlinked from Linear')
  }

  if (!linearLink) return null

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors [&[data-state=open]>svg]:rotate-90">
        <ChevronRight className="size-3 transition-transform" />
        Linear
      </CollapsibleTrigger>
      <CollapsibleContent className="border-l border-border ml-2 pl-6 pt-5">
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-sm">{linearLink.external_key}</span>
            <IconButton variant="ghost" aria-label="Open in Linear" className="size-7" onClick={() => window.api.shell.openExternal(linearLink.external_url)} title="Open in Linear">
              <ExternalLinkIcon className="size-3.5" />
            </IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton variant="ghost" aria-label="Linear actions" className="size-7">
                  <EllipsisIcon className="size-3.5" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleSync}>
                  <RefreshCwIcon className="size-3.5" />
                  Sync
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleUnlink}>
                  <UnlinkIcon className="size-3.5" />
                  Unlink
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {syncMessage ? <p className="text-xs text-muted-foreground">{syncMessage}</p> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
