import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { format } from 'date-fns'
import { CalendarIcon, Plus } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Tag } from '@slayzone/tags/shared'
import { CreateTagDialog } from '@slayzone/tags/client'
import type { Project } from '@slayzone/projects/shared'
import { getDefaultStatus } from '@slayzone/projects/shared'
import { SuccessToast } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'
import {
  createTaskSchema,
  type CreateTaskFormData,
  priorityOptions
} from '@slayzone/task/shared'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Textarea } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { Calendar } from '@slayzone/ui'
import { Checkbox } from '@slayzone/ui'
import { ProjectSelect } from '@slayzone/projects'
import { buildStatusOptions, cn } from '@slayzone/ui'

interface CreateTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (task: Task) => void
  onCreatedAndOpen?: (task: Task) => void
  defaultProjectId?: string
  defaultStatus?: Task['status']
  defaultPriority?: number
  defaultDueDate?: string | null
  tags: Tag[]
  onTagCreated?: (tag: Tag) => void
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  onCreated,
  onCreatedAndOpen,
  defaultProjectId,
  defaultStatus,
  defaultPriority,
  defaultDueDate,
  tags,
  onTagCreated
}: CreateTaskDialogProps): React.JSX.Element {
  const [createTagOpen, setCreateTagOpen] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const form = useForm<CreateTaskFormData>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: {
      projectId: defaultProjectId ?? '',
      title: '',
      description: '',
      status: defaultStatus ?? 'inbox',
      priority: defaultPriority ?? 3,
      dueDate: defaultDueDate ?? null,
      tagIds: []
    }
  })

  // Reset form when dialog opens with new defaults
  useEffect(() => {
    if (open) {
      form.reset({
        projectId: defaultProjectId ?? '',
        title: '',
        description: '',
        status: defaultStatus ?? 'inbox',
        priority: defaultPriority ?? 3,
        dueDate: defaultDueDate ?? null,
        tagIds: []
      })
    }
  }, [open, defaultProjectId, defaultStatus, defaultPriority, defaultDueDate, form])

  useEffect(() => {
    if (!open) return
    window.api.db.getProjects().then((list) => setProjects(list))
  }, [open])

  const selectedProjectId = form.watch('projectId')
  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const projectStatusOptions = buildStatusOptions(selectedProject?.columns_config)

  useEffect(() => {
    const currentStatus = form.getValues('status')
    if (!projectStatusOptions.some((option) => option.value === currentStatus)) {
      form.setValue('status', getDefaultStatus(selectedProject?.columns_config))
    }
  }, [projectStatusOptions, selectedProject, form])

  const createTask = async (
    data: CreateTaskFormData,
    opts?: { statusOverride?: Task['status']; andOpen?: boolean }
  ): Promise<void> => {
    const isAutoCreateEnabledForProject = async (projectId: string): Promise<boolean> => {
      const [globalSetting, projects] = await Promise.all([
        window.api.settings.get('auto_create_worktree_on_task_create'),
        window.api.db.getProjects()
      ])
      const project = projects.find((p) => p.id === projectId)
      const override = project?.auto_create_worktree_on_task_create
      if (override === 1) return true
      if (override === 0) return false
      return globalSetting === '1'
    }

    let shouldAutoCreateWorktree = false
    try {
      shouldAutoCreateWorktree = await isAutoCreateEnabledForProject(data.projectId)
    } catch {
      shouldAutoCreateWorktree = false
    }

    const task = await window.api.db.createTask({
      projectId: data.projectId,
      title: data.title,
      description: data.description || undefined,
      status: opts?.statusOverride ?? data.status,
      priority: data.priority,
      dueDate: data.dueDate ?? undefined
    })
    if (data.tagIds.length > 0) {
      await window.api.taskTags.setTagsForTask(task.id, data.tagIds)
    }
    if (shouldAutoCreateWorktree && !task.worktree_path) {
      window.alert('Task created, but worktree auto-create failed. You can add one from the Git panel.')
    }

    if (shouldAutoCreateWorktree && task.worktree_path) {
      track('worktree_created', { auto_vs_manual: 'auto' })
    }
    if (opts?.andOpen && onCreatedAndOpen) {
      onCreatedAndOpen(task)
    } else {
      onCreated(task)
    }
    form.reset()
    setShowSuccess(true)
    setTimeout(() => setShowSuccess(false), 3000)
  }

  const onSubmit = async (data: CreateTaskFormData): Promise<void> => {
    await createTask(data)
  }

  // Get selected tags for display
  const selectedTagIds = form.watch('tagIds')
  const selectedTags = tags.filter((t) => selectedTagIds.includes(t.id))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[575px]" onOpenAutoFocus={(e) => {
          e.preventDefault()
          const input = document.querySelector<HTMLInputElement>('[name="title"]')
          input?.focus()
        }} onCloseAutoFocus={(e) => {
          // Keep focus control in the task view (terminal/editor) when closing after create.
          e.preventDefault()
        }}>
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.metaKey && e.shiftKey) {
                e.preventDefault()
                form.handleSubmit(onSubmit)()
              } else if (e.key === 'Enter' && e.metaKey) {
                e.preventDefault()
                if (onCreatedAndOpen) {
                  form.handleSubmit((data) => createTask(data, { andOpen: true }))()
                } else {
                  form.handleSubmit(onSubmit)()
                }
              }
            }}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input {...field} autoFocus placeholder="Task title" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea {...field} placeholder="Optional description" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {projectStatusOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Priority</FormLabel>
                    <Select
                      onValueChange={(v) => field.onChange(Number(v))}
                      value={String(field.value)}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {priorityOptions.map((opt) => (
                          <SelectItem key={opt.value} value={String(opt.value)}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="dueDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Due Date</FormLabel>
                  <Popover>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          variant="outline"
                          className={cn(
                            'w-full justify-start text-left font-normal',
                            !field.value && 'text-muted-foreground'
                          )}
                        >
                          <CalendarIcon className="mr-2 size-4" />
                          {field.value ? format(new Date(field.value), 'PPP') : 'Pick a date'}
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={field.value ? new Date(field.value) : undefined}
                        onSelect={(date) =>
                          field.onChange(date ? format(date, 'yyyy-MM-dd') : null)
                        }
                      />
                    </PopoverContent>
                  </Popover>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="tagIds"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tags</FormLabel>
                  <Popover>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button variant="outline" className="w-full justify-start">
                          {selectedTags.length === 0 ? (
                            <span className="text-muted-foreground">Select tags...</span>
                          ) : (
                            <div className="flex gap-1">
                              {selectedTags.slice(0, 3).map((tag) => (
                                <span
                                  key={tag.id}
                                  className="rounded px-2 py-1 text-sm font-medium"
                                  style={{ backgroundColor: tag.color, color: tag.text_color }}
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
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="w-[200px] p-1.5" align="start">
                      {tags.length > 0 && (
                        <div className="space-y-0.5">
                          {tags.map((tag) => (
                            <label key={tag.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
                              <Checkbox
                                checked={field.value.includes(tag.id)}
                                onCheckedChange={(checked) => {
                                  const newValue = checked
                                    ? [...field.value, tag.id]
                                    : field.value.filter((id: string) => id !== tag.id)
                                  field.onChange(newValue)
                                }}
                              />
                              <span
                                className="rounded px-2 py-1 text-sm font-medium"
                                style={{ backgroundColor: tag.color, color: tag.text_color }}
                              >
                                {tag.name}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                      <div className={tags.length > 0 ? 'border-t mt-1.5 pt-1' : ''}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-muted-foreground h-7 px-1.5"
                          onClick={() => setCreateTagOpen(true)}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1.5" />
                          New tag
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <CreateTagDialog
                    open={createTagOpen}
                    onOpenChange={setCreateTagOpen}
                    projectId={selectedProjectId}
                    existingTags={tags}
                    onCreated={(tag) => {
                      onTagCreated?.(tag)
                      field.onChange([...field.value, tag.id])
                    }}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="projectId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Project</FormLabel>
                  <FormControl>
                    <ProjectSelect value={field.value} onChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <div className="flex-1" />
              <Button type="submit" variant={onCreatedAndOpen ? 'outline' : 'default'}>
                Create
                <kbd className="ml-2 opacity-70" style={{ fontFamily: 'system-ui' }}>
                  {onCreatedAndOpen ? '⇧⌘↩' : '⌘↩'}
                </kbd>
              </Button>
              {onCreatedAndOpen && (
                <Button
                  type="button"
                  onClick={() => form.handleSubmit((data) => createTask(data, { andOpen: true }))()}
                >
                  Create + open
                  <kbd className="ml-2 text-muted-foreground" style={{ fontFamily: 'system-ui' }}>⌘↩</kbd>
                </Button>
              )}
            </div>
          </form>
        </Form>
        <SuccessToast
          message="Task created successfully!"
          show={showSuccess}
          onComplete={() => setShowSuccess(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
