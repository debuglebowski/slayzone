import { Suspense, useRef, useState } from 'react'
import { Archive, FileCode, GitBranch, Info, Plus, Trash2, X } from 'lucide-react'
import { DndContext, PointerSensor, useSensors, useSensor, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { isTerminalStatus } from '@slayzone/projects-contracts'
import { getEffectiveRenderMode, RENDER_MODE_INFO } from '@slayzone/task-contracts'
import { Button, Input, toast, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
import { hasOwnFolder } from '../../../shared/main-terminal'
import { TaskMetadataSidebar } from '../../TaskMetadataSidebar'
import { RichTextEditor } from '../../task-detail/lazyPanels'
import { SortableSubTask } from '../../task-detail/TaskOverviewRow'
import { useTaskPageContext } from '../TaskPageContext'

/**
 * The task's Description, Sub-tasks and Details: the bodies of the Settings
 * panel's cards, and of the Description / Subtasks / Details panels that show one
 * of them on its own (docs/plans/panel-model.md step 12). Each reads the task page,
 * so every place shows the same task state.
 */

/** The description editor (saves on blur). */
export function DescriptionEditor({
  testId = 'task-description-editor'
}: {
  testId?: string
}): React.JSX.Element {
  const { canEdit, settings } = useTaskPageContext()
  const {
    descriptionValue,
    setDescriptionValue,
    descriptionDirty: descriptionDirtyRef,
    handleDescriptionSave,
    handleUploadImages,
    handleDescriptionOpenLink,
    notes,
    artifacts,
    selectArtifactInPanel
  } = settings
  return (
    <Suspense fallback={<div className="h-20" />}>
      <RichTextEditor
        value={descriptionValue}
        onChange={(md) => {
          descriptionDirtyRef.current = true
          setDescriptionValue(md)
        }}
        onBlur={handleDescriptionSave}
        placeholder={canEdit ? 'Add description...' : ''}
        readOnly={!canEdit}
        testId={testId}
        variant="inline"
        fontFamily={notes.fontFamily}
        checkedHighlight={notes.checkedHighlight}
        showToolbar={notes.showToolbar}
        spellcheck={notes.spellcheck}
        themeColors={notes.themeColors}
        artifacts={artifacts.map((a) => ({
          id: a.id,
          title: a.title,
          type: RENDER_MODE_INFO[getEffectiveRenderMode(a.title, a.render_mode)].label
        }))}
        onArtifactClick={selectArtifactInPanel}
        onUploadImages={handleUploadImages}
        onOpenLink={handleDescriptionOpenLink}
      />
    </Suspense>
  )
}

/** "done/total" of the task's sub-tasks, or null when it has none. */
export function useSubtaskProgress(): string | null {
  const { project, settings } = useTaskPageContext()
  const { subTasks } = settings
  if (subTasks.length === 0) return null
  const done = subTasks.filter((s) =>
    isTerminalStatus(s.status, project?.columns_config ?? null)
  ).length
  return `${done}/${subTasks.length}`
}

/** The sub-tasks (drag to reorder) and "Add subtask". */
export function SubtasksList(): React.JSX.Element {
  const { project, canEdit, settings } = useTaskPageContext()
  const {
    statusOptions,
    subTasks,
    handleSubTaskDragEnd,
    handleUpdateSubTask,
    handleDeleteSubTask,
    createSubTask,
    onNavigateToTask
  } = settings
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const create = (): void => {
    const trimmed = title.trim()
    if (!trimmed) return
    createSubTask(trimmed)
      .then(() => {
        setTitle('')
        setAdding(false)
      })
      .catch((err: unknown) =>
        toast.error("Couldn't add the sub-task", {
          description: err instanceof Error ? err.message : String(err)
        })
      )
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleSubTaskDragEnd}
    >
      <SortableContext items={subTasks.map((s) => s.id)} strategy={verticalListSortingStrategy}>
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
          {adding ? (
            <div className="flex items-center gap-2 py-1 px-1">
              <Input
                ref={inputRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    create()
                  }
                  if (e.key === 'Escape') {
                    setAdding(false)
                    setTitle('')
                  }
                }}
                placeholder="Sub-task title..."
                className="h-6 text-xs"
                autoFocus
              />
            </div>
          ) : (
            canEdit && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="flex items-center gap-1.5 py-1 px-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 mt-1"
              >
                <Plus className="size-3" />
                Add subtask
              </button>
            )
          )}
        </div>
      </SortableContext>
    </DndContext>
  )
}

/** Task metadata, the working directory and the danger zone. */
export function DetailsBody(): React.JSX.Element {
  const { task, canEdit, effectiveRepoPath, handleTaskUpdate, updateTaskAndNotify, settings } =
    useTaskPageContext()
  const {
    tags,
    setTags,
    taskTagIds,
    handleTagsChange,
    taskPath,
    taskPathLocation,
    taskFolderLabel,
    baseDir,
    isArchived,
    handleUnarchive,
    setArchiveDialogOpen,
    setDeleteDialogOpen
  } = settings
  // Each Details shows its own picker (Settings and a Details panel may both be open).
  const [baseDirPickerOpen, setBaseDirPickerOpen] = useState(false)
  return (
    <fieldset disabled={!canEdit} className="contents" data-testid="task-details">
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
              title={effectiveRepoPath ?? taskPathLocation ?? taskFolderLabel}
            >
              {taskPath.state === 'loading' && hasOwnFolder(task)
                ? '…'
                : (effectiveRepoPath ?? taskPathLocation ?? taskFolderLabel)}
              {task.has_worktree && <span className="ml-1 text-[10px] opacity-60">(worktree)</span>}
              {!task.has_worktree && task.has_base_dir && (
                <span className="ml-1 text-[10px] opacity-60">(custom)</span>
              )}
            </div>
            <button
              className="shrink-0 h-7 w-7 flex items-center justify-center rounded hover:bg-muted"
              title="Change working directory"
              onClick={() => setBaseDirPickerOpen(true)}
            >
              <FileCode className="size-3.5 text-muted-foreground" />
            </button>
            {task.has_base_dir && (
              <button
                className="shrink-0 h-7 w-7 flex items-center justify-center rounded hover:bg-muted"
                title="Clear custom directory"
                onClick={() => {
                  // A refusal leaves the terminal running in the old folder.
                  updateTaskAndNotify({ id: task.id, baseDir: null }).catch((err: unknown) =>
                    toast.error("Couldn't change the working directory", {
                      description: err instanceof Error ? err.message : String(err)
                    })
                  )
                }}
              >
                <X className="size-3.5 text-muted-foreground" />
              </button>
            )}
            {/* Scoped to the TASK, so it browses the computer
                this task's agents spawn on — a cwd chosen on
                any other machine would not exist for them. */}
            <WorkspaceDirPicker
              open={baseDirPickerOpen}
              onOpenChange={setBaseDirPickerOpen}
              onSelect={(picked) => {
                // Judged by the task's computer first; a refusal leaves the
                // terminal running in the old folder.
                updateTaskAndNotify({ id: task.id, baseDir: picked }).catch((err: unknown) =>
                  toast.error("Couldn't use that folder", {
                    description: err instanceof Error ? err.message : String(err)
                  })
                )
              }}
              target={{ taskId: task.id }}
              title="Select working directory"
              defaultPath={baseDir ?? effectiveRepoPath ?? null}
            />
          </div>
          {task.has_worktree && (
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
          {task.has_worktree && task.has_base_dir && (
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
              onClick={isArchived ? handleUnarchive : () => setArchiveDialogOpen(true)}
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
    </fieldset>
  )
}
