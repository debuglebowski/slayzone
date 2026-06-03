import { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensors,
  useSensor,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type DragStartEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import {
  SidebarMenu,
  SidebarMenuItem,
  cn,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem
} from '@slayzone/ui'
import { useDialogStore } from '@slayzone/settings'
import type { Project } from '@slayzone/projects/shared'
import { ProjectItem } from '../ProjectItem'
import { ProjectFolderTile, FolderMiniGrid } from '../ProjectFolderTile'
import { ProjectAvatar } from '../ProjectAvatar'
import { buildTopLevelEntries, entriesToRefs } from './projectGrouping'
import {
  resolveProjectDrop,
  applyProjectDrop,
  pointerYFromEvent,
  dropModeFromPointer
} from './projectDrop'
import type { SidebarViewContext } from './types'

type DragKind = 'top-project' | 'group' | 'member'
type DragData = { kind: DragKind; projectId?: string; groupId?: string }
type DropMode = 'before' | 'after' | 'merge'

/**
 * Siblings DON'T move during a drag (Discord behavior) — the dragged tile keeps
 * its slot as a static placeholder. Returning null from the sort strategy
 * disables the auto-shift; the drop position is instead shown by an insertion
 * line / merge ring driven by `indicator`. This keeps the layout stable so the
 * over-rect geometry that decides merge-vs-reorder never flickers.
 */
const noShift = () => null


export function ProjectsRailView({
  projects,
  projectGroups,
  selectedProjectId,
  onSelectProject,
  onProjectSettings,
  onCreateProjectGroup,
  onCreateFolderWithProjects,
  onDeleteProjectGroup,
  onSetGroupCollapsed,
  onReorderTopLevel,
  onMoveProjectToGroup,
  onReorderProjectsInGroup,
  idleByProject
}: SidebarViewContext) {
  'use no memo' // React Compiler froze the per-item insertion-line render
  // (drag state read via a closure wasn't tracked) — opt out so the indicator
  // re-renders live during a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const entries = useMemo(
    () => buildTopLevelEntries(projects, projectGroups),
    [projects, projectGroups]
  )

  const [activeDrag, setActiveDrag] = useState<{
    kind: DragKind
    projectId?: string
    project?: Project
    members?: Project[]
  } | null>(null)
  // Drop indicator: the over sortable id + which mode (line above/below, or merge).
  const [indicator, setIndicator] = useState<{ overId: string; mode: DropMode } | null>(null)

  const topLevelDroppableIds = useMemo(
    () =>
      new Set(entries.map((e) => (e.kind === 'group' ? `group:${e.id}` : `top-project:${e.id}`))),
    [entries]
  )

  // Folder (group) drags reorder among top-level slots only — restrict targets
  // so a folder can't be dropped inside another folder (no nesting). Project /
  // member drags prefer pointerWithin (precise, no jitter) → closestCenter for
  // gaps so reorder lines still resolve.
  const collisionDetection = useMemo<CollisionDetection>(() => {
    // closestCenter measures from the ACTIVE item's collision rect, which never
    // moves under the noShift strategy → it always "collides" with itself, so
    // `over` becomes the dragged item and the indicator nulls. When the pointer
    // is in empty space (above the first item, below the last, or in a gap),
    // pick the droppable whose center is nearest the POINTER, excluding the
    // active one. This is what makes the top/bottom insertion line resolve.
    const closestToPointer: CollisionDetection = (args) => {
      const p = args.pointerCoordinates
      if (!p) return closestCenter(args)
      let best: { id: string | number } | null = null
      let bestDist = Infinity
      for (const c of args.droppableContainers) {
        if (c.id === args.active.id) continue
        const r = args.droppableRects.get(c.id)
        if (!r) continue
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const dist = (cx - p.x) ** 2 + (cy - p.y) ** 2
        if (dist < bestDist) {
          bestDist = dist
          best = { id: c.id }
        }
      }
      return best ? [best] : []
    }
    return (args) => {
      const kind = (args.active.data.current as DragData | undefined)?.kind
      if (kind === 'group') {
        return closestToPointer({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) =>
            topLevelDroppableIds.has(String(c.id))
          )
        })
      }
      const within = pointerWithin(args)
      return within.length > 0 ? within : closestToPointer(args)
    }
  }, [topLevelDroppableIds])

  const groupMembers = (groupId: string): Project[] => {
    const entry = entries.find((e) => e.kind === 'group' && e.id === groupId)
    return entry && entry.kind === 'group' ? entry.projects : []
  }

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragData | undefined
    if (!data) return
    if (data.kind === 'group') {
      setActiveDrag({ kind: 'group', members: groupMembers(data.groupId!) })
    } else {
      const project = projects.find((p) => p.id === data.projectId)
      setActiveDrag({ kind: data.kind, projectId: data.projectId, project })
    }
  }

  const computeMode = (event: DragMoveEvent | DragOverEvent | DragEndEvent): DropMode => {
    const aKind = (event.active.data.current as DragData | undefined)?.kind
    const oKind = (event.over?.data.current as DragData | undefined)?.kind
    const py = pointerYFromEvent(event)
    const rect = event.over?.rect
    const raw = dropModeFromPointer(py, rect)
    const overId = String(event.over?.id ?? '')
    const idx = entries.findIndex(
      (e) => (e.kind === 'group' ? `group:${e.id}` : `top-project:${e.id}`) === overId
    )
    const half = rect ? rect.top + rect.height / 2 : 0
    let result: DropMode
    if (aKind === 'group') {
      // A dragged FOLDER never merges → reorder line only.
      result = raw === 'merge' ? 'before' : raw
    } else if (py != null && rect && idx === 0 && py < half) {
      result = 'before'
    } else if (py != null && rect && idx === entries.length - 1 && py >= half) {
      result = 'after'
    } else if (oKind === 'group') {
      result = 'merge'
    } else {
      result = raw
    }
    return result
  }

  // Driven by onDragMove (fires every pointer move) — NOT onDragOver, which only
  // fires when the `over` target changes. With the static-placeholder layout the
  // pointer can travel a long way inside one `over` (e.g. past the last folder)
  // without `over` changing; onDragOver would freeze the mode (stuck on 'merge')
  // so the bottom/top insertion line was unreachable. onDragMove recomputes the
  // mode continuously as the cursor moves within the same target.
  const handleDragMove = (event: DragMoveEvent | DragOverEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) {
      setIndicator(null)
      return
    }
    setIndicator({ overId: String(over.id), mode: computeMode(event) })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    const a = active.data.current as DragData | undefined
    const o = over?.data.current as DragData | undefined
    const mode = over ? computeMode(event) : 'merge'
    setActiveDrag(null)
    setIndicator(null)
    if (!over || !a || !o || active.id === over.id) return

    // Normalize this view's drag/drop geometry, then defer the membership /
    // reorder decision to the shared resolver (unit-tested, shared with tree).
    const action = resolveProjectDrop({
      active: {
        id: a.kind === 'group' ? a.groupId! : a.projectId!,
        group: a.kind === 'member' ? a.groupId! : null,
        isGroup: a.kind === 'group'
      },
      over:
        o.kind === 'group'
          ? { kind: 'group', id: o.groupId!, group: null }
          : { kind: 'project', id: o.projectId!, group: o.kind === 'member' ? o.groupId! : null },
      mode,
      topLevel: entriesToRefs(entries),
      members: (gid) => groupMembers(gid).map((p) => p.id)
    })
    applyProjectDrop(action, {
      onCreateFolderWithProjects,
      onMoveProjectToGroup,
      onReorderProjectsInGroup,
      onReorderTopLevel
    })
  }

  const handleDragCancel = () => {
    setActiveDrag(null)
    setIndicator(null)
  }

  const sortableIds = entries.map((e) =>
    e.kind === 'group' ? `group:${e.id}` : `top-project:${e.id}`
  )

  return (
    <SidebarMenu className="flex flex-col items-center gap-2">
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragOver={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={sortableIds} strategy={noShift}>
          {entries.map((entry) => {
            const sid = entry.kind === 'group' ? `group:${entry.id}` : `top-project:${entry.id}`
            // Read `indicator` DIRECTLY here (not via a closure) so the compiler
            // tracks it and the line re-renders during a drag.
            const line: DropMode | null =
              indicator && indicator.overId === sid ? indicator.mode : null
            return (
              <SidebarMenuItem key={sid}>
                <div className="relative">
                  {/* gap is 8px (gap-2) → center pinned 4px into it. Line is
                      WIDER than the 40px tile (-left-2 -right-2) so it sticks out
                      past the drag chip and stays visible at the cursor. */}
                  {line === 'before' && (
                    <span
                      style={{ top: -4 }}
                      className="pointer-events-none absolute -left-2 -right-2 z-20 h-1 -translate-y-1/2 rounded-full bg-foreground"
                    />
                  )}
                  {line === 'after' && (
                    <span
                      style={{ bottom: -4 }}
                      className="pointer-events-none absolute -left-2 -right-2 z-20 h-1 translate-y-1/2 rounded-full bg-foreground"
                    />
                  )}
                  {entry.kind === 'project' ? (
                    <ProjectItem
                      project={entry.project}
                      selected={selectedProjectId === entry.id}
                      onClick={() => onSelectProject(entry.id)}
                      onSettings={() => onProjectSettings(entry.project)}
                      onDelete={() => useDialogStore.getState().openDeleteProject(entry.project)}
                      idleCount={idleByProject?.get(entry.id) ?? 0}
                      sortableId={sid}
                      dragData={{ kind: 'top-project', projectId: entry.id }}
                      mergeHighlight={line === 'merge'}
                    />
                  ) : (
                    <ProjectFolderTile
                      group={entry.group}
                      members={entry.projects}
                      collapsed={entry.group.collapsed !== 0}
                      selectedProjectId={selectedProjectId}
                      idleByProject={idleByProject}
                      mergeHighlight={line === 'merge'}
                      onToggle={() =>
                        onSetGroupCollapsed?.(entry.id, !(entry.group.collapsed !== 0))
                      }
                      onSelectProject={onSelectProject}
                      onProjectSettings={onProjectSettings}
                      onDeleteProject={(p) => useDialogStore.getState().openDeleteProject(p)}
                      onSettings={() => useDialogStore.getState().openGroupSettings(entry.group)}
                      onDelete={() => onDeleteProjectGroup?.(entry.id)}
                      onRemoveProjectFromGroup={(pid) => onMoveProjectToGroup?.(pid, null, 0)}
                    />
                  )}
                </div>
              </SidebarMenuItem>
            )
          })}
        </SortableContext>
        {/* Translucent preview — the cursor sits on the merge target's center,
            so an opaque chip would hide the merge fill/icon beneath it. */}
        {/* Offset the chip down-right of the cursor so it never covers the
            insertion line (the overlay is a high-z layer the line can't beat —
            without this, the line at the cursor's drop point is hidden, esp. at
            the list's top/bottom edges). */}
        <DragOverlay dropAnimation={null}>
          {activeDrag ? (
            <div style={{ transform: 'translate(16px, 16px)' }}>
              {activeDrag.kind === 'group' ? (
                <div className="w-12 h-12 opacity-60">
                  <FolderMiniGrid members={activeDrag.members ?? []} />
                </div>
              ) : activeDrag.project ? (
                <ProjectAvatar
                  project={activeDrag.project}
                  className="w-10 h-10 rounded-lg opacity-60"
                />
              ) : null}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <SidebarMenuItem>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              onClick={() => useDialogStore.getState().openCreateProject()}
              className={cn(
                'w-10 h-10 rounded-lg flex items-center justify-center',
                'text-lg text-muted-foreground border-2 border-dashed',
                'hover:border-primary hover:text-primary transition-colors'
              )}
              title="Add project (right-click for folder)"
            >
              +
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => useDialogStore.getState().openCreateProject()}>
              New project
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onCreateProjectGroup?.()}>New folder</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
