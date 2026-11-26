import { Suspense } from 'react'
import {
  Archive,
  ChevronRight,
  Expand,
  FileCode,
  GitBranch,
  Info,
  MoveVertical,
  Paperclip,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import { DndContext, PointerSensor, useSensors, useSensor, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { isTerminalStatus } from '@slayzone/projects-contracts'
import {
  getExtensionFromTitle,
  getEffectiveRenderMode,
  RENDER_MODE_INFO
} from '@slayzone/task-contracts'
import {
  Button,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  IconButton,
  Input,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
import { hasOwnFolder } from '../../../shared/main-terminal'
import { TaskMetadataSidebar } from '../../TaskMetadataSidebar'
import { TaskSettingsPanel } from '../../TaskSettingsPanel'
import { RichTextEditor } from '../../task-detail/lazyPanels'
import { SortableSubTask } from '../../task-detail/TaskOverviewRow'
import { getTaskPanels } from '../registry'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/**
 * The task's settings (`settings`): external sync links, the Description /
 * Sub-tasks / Artifacts cards and Details (metadata, working directory, danger zone).
 */
export function SettingsKind({ panelId }: PanelKindProps): React.JSX.Element {
  const {
    task,
    project,
    canEdit,
    effectiveRepoPath,
    handleTaskUpdate,
    updateTaskAndNotify,
    settings
  } = useTaskPageContext()
  const {
    tags,
    setTags,
    taskTagIds,
    handleTagsChange,
    taskPath,
    taskPathLocation,
    taskFolderLabel,
    baseDir,
    baseDirPickerOpen,
    setBaseDirPickerOpen,
    isArchived,
    handleUnarchive,
    setArchiveDialogOpen,
    setDeleteDialogOpen,
    settingsCardsGridRef,
    settingsCols,
    descFullHeight,
    descriptionOpen,
    setDescriptionOpen,
    descriptionExpanded,
    setDescriptionExpanded,
    subTasksOpen,
    setSubTasksOpen,
    artifactsOpen,
    setArtifactsOpen,
    detailsOpen,
    setDetailsOpen,
    setDescriptionFullscreen,
    descriptionValue,
    setDescriptionValue,
    descriptionDirty,
    handleDescriptionSave,
    handleUploadImages,
    handleDescriptionOpenLink,
    notes,
    statusOptions,
    subTasks,
    handleSubTaskDragEnd,
    handleUpdateSubTask,
    handleDeleteSubTask,
    addingSubTask,
    setAddingSubTask,
    subTaskTitle,
    setSubTaskTitle,
    subTaskInputRef,
    handleCreateSubTask,
    onNavigateToTask,
    artifacts,
    selectArtifactInPanel,
    createArtifactInPanel
  } = settings
  const {
    fontFamily: notesFontFamily,
    checkedHighlight: notesCheckedHighlight,
    showToolbar: notesShowToolbar,
    spellcheck: notesSpellcheck,
    themeColors: notesThemeColors
  } = notes
  const { ExternalSyncCard } = getTaskPanels()
  const subTaskSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  // Built OUTSIDE the frame's JSX, so the compiler memoizes it on its own inputs:
  // the frame re-renders on every tab switch (`isActive`), this panel must not.
  const taskSettingsPanel = (
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
                    {task.has_worktree && (
                      <span className="ml-1 text-[10px] opacity-60">(worktree)</span>
                    )}
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
        // Layout tier from the panel's resolved width: 1 column (stacked, as
        // before), 2 (Description | cards + Details), 3 (Description | cards |
        // Details). Multi-column gives Description its own full-height column.
        const descriptionCard = (
          <Collapsible
            data-testid="settings-description-card"
            data-card
            data-card-open={descriptionOpen}
            open={descriptionOpen}
            onOpenChange={setDescriptionOpen}
            className={cn(
              'flex flex-col rounded-md border border-border overflow-hidden min-h-0',
              settingsCols > 1 && descriptionOpen && 'flex-1'
            )}
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
                {/* Multi-column: Description already owns a full-height column */}
                {settingsCols === 1 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <IconButton
                        type="button"
                        variant="ghost"
                        aria-label={descriptionExpanded ? 'Default height' : 'Full height'}
                        className={cn(
                          'size-5 hover:text-foreground',
                          descriptionExpanded ? 'text-foreground bg-muted' : 'text-muted-foreground'
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
                        <MoveVertical size={12} />
                      </IconButton>
                    </TooltipTrigger>
                    <TooltipContent>
                      {descriptionExpanded ? 'Default height' : 'Full height'}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton
                      type="button"
                      variant="ghost"
                      aria-label="Fullscreen"
                      className="size-5 text-muted-foreground hover:text-foreground"
                      onClick={() => setDescriptionFullscreen(true)}
                    >
                      <Expand size={12} />
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
                    placeholder={canEdit ? 'Add description...' : ''}
                    readOnly={!canEdit}
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
                      type: RENDER_MODE_INFO[getEffectiveRenderMode(a.title, a.render_mode)].label
                    }))}
                    onArtifactClick={selectArtifactInPanel}
                    onUploadImages={handleUploadImages}
                    onOpenLink={handleDescriptionOpenLink}
                  />
                </Suspense>
              </div>
            )}
          </Collapsible>
        )
        const cardsGrid = (
          <div
            ref={settingsCardsGridRef}
            data-testid="settings-cards-grid"
            className="flex-1 min-h-0 overflow-hidden grid gap-4 content-start"
          >
            {settingsCols === 1 && descriptionCard}
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
                        canEdit && (
                          <button
                            type="button"
                            onClick={() => setAddingSubTask(true)}
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
                      onClick={() => selectArtifactInPanel(artifact.id)}
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
                    onClick={createArtifactInPanel}
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
            {descFullHeight && (
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
                  <div data-card-scroll className="flex-1 min-h-0 overflow-y-auto p-2.5">
                    {detailsBody}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )
        return (
          <>
            {/* External sync links — pinned above the cards */}
            <ExternalSyncCard taskId={task.id} onUpdate={handleTaskUpdate} />

            {settingsCols === 1 ? (
              <>
                {/* Cards grid: flex-1 min-h-0 → height is the spare space
                  between ExternalSync and the pinned Details (definite, so
                  the water-level caps resolve). useSharedCardHeights also sets
                  a min-height = floored content, so a short window scrolls the
                  PANEL (keeping cards usable) instead of crushing them; the
                  grid itself never overflows. content-start → short cards leave
                  the leftover as empty space above the pinned meta. */}
                {cardsGrid}

                {/* Details — normal mode: pinned at the bottom of the panel,
                  always visible, never shrinks. */}
                {!descFullHeight && (
                  <div data-testid="settings-details-pinned" className="shrink-0 mt-auto">
                    {detailsBody}
                  </div>
                )}
              </>
            ) : (
              <div
                data-testid="settings-columns"
                data-columns={settingsCols}
                className="flex-1 min-h-0 flex gap-4"
              >
                <div className="flex-1 min-w-0 min-h-0 flex flex-col">{descriptionCard}</div>
                <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-4">
                  {cardsGrid}
                  {settingsCols === 2 && (
                    <div data-testid="settings-details-pinned" className="shrink-0 mt-auto">
                      {detailsBody}
                    </div>
                  )}
                </div>
                {settingsCols === 3 && (
                  <div
                    data-testid="settings-details-column"
                    className="flex-1 min-w-0 min-h-0 overflow-y-auto"
                  >
                    {detailsBody}
                  </div>
                )}
              </div>
            )}
          </>
        )
      }}
    />
  )

  return (
    <PanelFrame
      kind="settings"
      panelId={panelId}
      testId="task-settings-panel"
      className="p-3 flex flex-col gap-4 overflow-y-auto"
    >
      {taskSettingsPanel}
    </PanelFrame>
  )
}
