import { Folder, FolderPlus } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@slayzone/ui'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Tooltip,
  TooltipTrigger,
  TooltipContent
} from '@slayzone/ui'
import type { Project, ProjectGroup } from '@slayzone/projects/shared'
import { ProjectAvatar } from './ProjectAvatar'
import { ProjectItem } from './ProjectItem'

/** Up-to-4 mini-avatar grid shown on a collapsed folder (and the drag preview). */
export function FolderMiniGrid({
  members,
  className
}: {
  members: Project[]
  className?: string
}) {
  const shown = members.slice(0, 4)
  return (
    <div
      className={cn(
        // bg matches the OPEN folder card. The 2x2 cluster is content-sized
        // (fixed size-4 minis + small gap) and CENTERED, so growing the
        // container just adds padding around it — the miniatures don't scale.
        'flex w-full h-full items-center justify-center rounded-lg bg-surface-3',
        className
      )}
    >
      <div className="grid grid-cols-2 grid-rows-2 gap-[2px]">
        {shown.map((m) => (
          <ProjectAvatar
            key={m.id}
            project={m}
            className="size-4 rounded-[3px]"
            lettersClassName="text-[6px]"
          />
        ))}
        {Array.from({ length: Math.max(0, 4 - shown.length) }).map((_, i) => (
          <div key={`empty-${i}`} className="size-4 rounded-[3px] bg-surface-2" />
        ))}
      </div>
    </div>
  )
}

interface ProjectFolderTileProps {
  group: ProjectGroup
  members: Project[]
  collapsed: boolean
  selectedProjectId: string
  idleByProject?: Map<string, number>
  /** Ring the tile while a project hovers it (will drop into the group). */
  mergeHighlight?: boolean
  onToggle: () => void
  onSelectProject: (id: string) => void
  onProjectSettings: (project: Project) => void
  onDeleteProject: (project: Project) => void
  onSettings: () => void
  onDelete: () => void
  onRemoveProjectFromGroup: (projectId: string) => void
}

export function ProjectFolderTile({
  group,
  members,
  collapsed,
  selectedProjectId,
  idleByProject,
  mergeHighlight,
  onToggle,
  onSelectProject,
  onProjectSettings,
  onDeleteProject,
  onSettings,
  onDelete,
  onRemoveProjectFromGroup
}: ProjectFolderTileProps) {
  // The group is a top-level sortable (reorder among projects/folders) AND a
  // droppable (drop a project onto it → join the group).
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `group:${group.id}`,
    data: { kind: 'group', groupId: group.id }
  })
  const style = {
    // Stay put while dragging — DragOverlay shows the moving copy and the
    // original slot renders an explicit placeholder below.
    transform: isDragging
      ? undefined
      : transform
        ? CSS.Transform.toString({ ...transform, x: 0 })
        : undefined,
    transition
  }
  const label = group.name.trim() || 'Folder'
  const idleTotal = members.reduce((n, m) => n + (idleByProject?.get(m.id) ?? 0), 0)

  if (isDragging) {
    return (
      <div ref={setNodeRef} style={style} className="relative">
        <div className="w-10 h-10 rounded-lg border-2 border-dashed border-primary/50 bg-primary/5" />
      </div>
    )
  }

  const header = (
    <Tooltip>
      <ContextMenu>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <button
              onClick={onToggle}
              aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
              className={cn(
                'relative rounded-lg transition-all',
                // Collapsed folder is a touch larger than a project tile; the
                // expanded header keeps the regular 40px footprint.
                collapsed ? 'w-12 h-12' : 'w-10 h-10',
                mergeHighlight && 'ring-2 ring-primary'
              )}
              {...attributes}
              {...listeners}
            >
              {collapsed ? (
                <FolderMiniGrid members={members} />
              ) : (
                <div className="flex w-full h-full items-center justify-center rounded-lg text-muted-foreground">
                  <Folder className="size-5" />
                </div>
              )}
              {mergeHighlight && (
                <>
                  <span className="absolute inset-0 rounded-lg bg-primary/40" />
                  <span className="absolute -top-1.5 -right-1.5 z-50 flex items-center justify-center rounded-full bg-primary p-1 text-primary-foreground ring-2 ring-background">
                    <FolderPlus className="size-3" />
                  </span>
                </>
              )}
            </button>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onToggle}>{collapsed ? 'Expand' : 'Collapse'}</ContextMenuItem>
          <ContextMenuItem onSelect={onSettings}>Settings</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onDelete} className="text-destructive">
            Delete folder
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )

  const memberList = (
    <SortableContext
      items={members.map((m) => `member:${m.id}`)}
      strategy={verticalListSortingStrategy}
    >
      {members.map((m) => (
        <ProjectItem
          key={m.id}
          project={m}
          selected={selectedProjectId === m.id}
          onClick={() => onSelectProject(m.id)}
          onSettings={() => onProjectSettings(m)}
          onDelete={() => onDeleteProject(m)}
          idleCount={idleByProject?.get(m.id) ?? 0}
          sortableId={`member:${m.id}`}
          dragData={{ kind: 'member', projectId: m.id, groupId: group.id }}
          onRemoveFromGroup={() => onRemoveProjectFromGroup(m.id)}
        />
      ))}
    </SortableContext>
  )

  return (
    <div ref={setNodeRef} style={style} className="relative flex flex-col items-center">
      {collapsed ? (
        header
      ) : (
        // Open folder = borderless card wrapping the header + its members.
        // bg-surface-3 (not surface-2 — that's identical to the sidebar bg, so
        // the card was invisible and didn't read as enclosing the members).
        <div className="flex w-full flex-col items-center gap-2 rounded-xl bg-surface-3 p-1.5">
          {header}
          {memberList}
        </div>
      )}
      {collapsed && idleTotal > 0 && (
        <span
          aria-label={`${idleTotal} idle agent${idleTotal === 1 ? '' : 's'}`}
          className="absolute -top-1.5 -right-1.5 z-50 min-w-4 rounded-full bg-primary border-2 border-background px-1 text-[10px] font-semibold leading-4 text-center text-primary-foreground pointer-events-none"
        >
          {idleTotal}
        </span>
      )}
    </div>
  )
}
