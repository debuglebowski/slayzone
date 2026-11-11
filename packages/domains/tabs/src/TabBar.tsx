import { memo, useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Home, X } from 'lucide-react'
import {
  cn,
  TerminalProgressDot,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  projectColorBg,
  useShortcutDisplay,
  useStableCallback,
  withShortcut
} from '@slayzone/ui'
import { useSessionBackgroundJobs, useSessionStateRaw } from '@slayzone/terminal'
import type { TerminalState } from '@slayzone/terminal-contracts'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

export type Tab =
  | { type: 'home' }
  | {
      type: 'task'
      taskId: string
      title: string
      terminalState?: TerminalState
      isSubTask?: boolean
      isTemporary?: boolean
    }

interface TabBarProps {
  tabs: Tab[]
  activeIndex: number
  activeView?: string
  projectColors?: Map<string, string>
  worktreeColors?: ReadonlyMap<string, string>
  taskProgress?: Map<string, number>
  doneTaskIds?: Set<string>
  attentionTaskIds?: Set<string>
  onTabClick: (index: number) => void
  onTabClose: (index: number) => void
  onTabReorder: (fromIndex: number, toIndex: number) => void
  onTabRename?: (taskId: string, title: string) => void
  rightContent?: React.ReactNode
  leftContent?: React.ReactNode
  hideTabs?: boolean
}

interface TabContentProps {
  title: string
  isActive: boolean
  isDragging?: boolean
  onClose?: () => void
  taskId: string
  needsAttention?: boolean
  isSubTask?: boolean
  isTemporary?: boolean
  projectColor?: string
  progress?: number
  isDone?: boolean
  isEditing?: boolean
  editValue?: string
  onEditChange?: (value: string) => void
  onEditSubmit?: () => void
  onEditCancel?: () => void
  inputRef?: React.RefObject<HTMLInputElement | null>
}

function TabContent({
  title,
  isActive,
  isDragging,
  onClose,
  taskId,
  needsAttention,
  isSubTask,
  isTemporary,
  projectColor,
  progress,
  isDone,
  isEditing,
  editValue,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  inputRef
}: TabContentProps): React.JSX.Element {
  // RAW: a task with no session is "no session", not "starting" — the tab's
  // starting spinner must only mean an agent really is starting.
  const terminalState = useSessionStateRaw(`${taskId}:${taskId}`)
  const backgroundJobs = useSessionBackgroundJobs(`${taskId}:${taskId}`)
  return (
    <div
      className={cn(
        'group relative flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer transition-colors select-none flex-shrink-0',
        !projectColor &&
          !isActive &&
          'bg-surface-2 dark:bg-surface-2/50 hover:bg-accent/80 dark:hover:bg-accent/50',
        !isActive && 'text-muted-foreground dark:text-muted-foreground',
        isTemporary && 'border border-dashed border-muted-foreground dark:border-border',
        'max-w-[300px]',
        isDragging && 'shadow-lg'
      )}
      style={{
        backgroundColor: isActive
          ? projectColor
            ? projectColor + '80'
            : 'var(--sidebar-accent)'
          : projectColorBg(projectColor, 'tab'),
        ...(isActive && {
          boxShadow: '0 0 0 1px var(--sidebar-border), 0 1px 4px rgba(0,0,0,0.2)'
        })
      }}
    >
      {projectColor && (
        <div className="pointer-events-none absolute inset-0 rounded-md opacity-0 transition-opacity group-hover:opacity-100 bg-black/10 dark:bg-white/10" />
      )}
      <TerminalProgressDot
        state={terminalState}
        progress={progress}
        isDone={isDone}
        needsAttention={needsAttention}
        backgroundJobs={backgroundJobs}
        alwaysShow
        tooltipSide="bottom"
        size={10}
      />
      {isSubTask && <span className="text-[10px] text-muted-foreground/60 shrink-0">SUB</span>}
      {isEditing ? (
        <input
          ref={inputRef}
          className="bg-transparent border-none outline-none text-sm w-28 min-w-0"
          value={editValue}
          onChange={(e) => onEditChange?.(e.target.value)}
          onBlur={() => onEditSubmit?.()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onEditSubmit?.()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              onEditCancel?.()
            }
            e.stopPropagation()
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className={cn('truncate text-sm', isTemporary && 'italic text-muted-foreground')}>
          {title}
        </span>
      )}
      {onClose && (
        <button
          className="h-4 w-4 rounded hover:bg-muted-foreground/20 flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

/** Edge fade + arrow shown over the task-tab strip when tabs are hidden on that side. */
function StripScrollButton({
  side,
  onClick
}: {
  side: 'left' | 'right'
  onClick: () => void
}): React.JSX.Element {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-y-0 flex items-center w-12',
        side === 'left'
          ? 'left-0 justify-start bg-gradient-to-r from-sidebar from-40% to-transparent'
          : 'right-0 justify-end bg-gradient-to-l from-sidebar from-40% to-transparent'
      )}
    >
      <button
        type="button"
        data-testid={`task-tab-strip-scroll-${side}`}
        aria-label={side === 'left' ? 'Scroll tabs left' : 'Scroll tabs right'}
        className="pointer-events-auto window-no-drag h-7 w-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/80 dark:hover:bg-accent/50"
        onClick={onClick}
      >
        <Icon className="size-4" />
      </button>
    </div>
  )
}

/** Pixels per wheel delta unit (WheelEvent.deltaMode): pixel, line, page. */
function wheelDeltaPx(e: WheelEvent, pageWidth: number): number {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * 16
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * pageWidth
  return e.deltaY
}

type GroupPosition = 'solo' | 'first' | 'middle' | 'last'

interface SortableTabProps {
  tab: Tab & { type: 'task' }
  index: number
  isActive: boolean
  onTabClick: (index: number) => void
  onTabClose: (index: number) => void
  needsAttention?: boolean
  projectColor?: string
  worktreeColor?: string
  progress?: number
  isDone?: boolean
  groupPosition?: GroupPosition
  isEditing?: boolean
  editValue?: string
  onEditChange?: (value: string) => void
  onEditSubmit?: () => void
  onEditCancel?: () => void
  onDoubleClick?: (tab: Tab & { type: 'task' }) => void
  inputRef?: React.RefObject<HTMLInputElement | null>
}

// Memoized: a tab switch changes `isActive` on two tabs; the rest must not render.
const SortableTab = memo(function SortableTab({
  tab,
  index,
  isActive,
  onTabClick,
  onTabClose,
  needsAttention,
  projectColor,
  worktreeColor,
  progress,
  isDone,
  groupPosition,
  isEditing,
  editValue,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onDoubleClick,
  inputRef
}: SortableTabProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.taskId,
    disabled: isEditing
  })

  const inGroup = groupPosition === 'middle' || groupPosition === 'last'

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.5 : 1,
    marginLeft: inGroup ? 0 : 4
  }

  if (worktreeColor && groupPosition) {
    const bw = 1.5
    style.borderColor = worktreeColor
    style.borderStyle = 'solid'
    style.borderTopWidth = bw
    style.borderBottomWidth = bw
    style.borderLeftWidth = groupPosition === 'first' || groupPosition === 'solo' ? bw : 0
    style.borderRightWidth = groupPosition === 'last' || groupPosition === 'solo' ? bw : 0
    style.borderRadius =
      groupPosition === 'solo'
        ? 8
        : groupPosition === 'first'
          ? '8px 0 0 8px'
          : groupPosition === 'last'
            ? '0 8px 8px 0'
            : 0
    style.paddingTop = 2
    style.paddingBottom = 2
    style.paddingLeft = groupPosition === 'first' || groupPosition === 'solo' ? 4 : 0
    style.paddingRight = groupPosition === 'last' || groupPosition === 'solo' ? 4 : 0
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="window-no-drag"
      data-tab-active={isActive || undefined}
      onClick={() => !isEditing && onTabClick(index)}
      onDoubleClick={onDoubleClick && (() => onDoubleClick(tab))}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onTabClose(index)
        }
      }}
      {...attributes}
      {...listeners}
    >
      <TabContent
        title={tab.title}
        isActive={isActive}
        onClose={() => onTabClose(index)}
        taskId={tab.taskId}
        needsAttention={needsAttention}
        isSubTask={tab.isSubTask}
        isTemporary={tab.isTemporary}
        projectColor={projectColor}
        progress={progress}
        isDone={isDone}
        isEditing={isEditing}
        editValue={editValue}
        onEditChange={onEditChange}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
        inputRef={inputRef}
      />
    </div>
  )
})

export function TabBar({
  tabs,
  activeIndex,
  activeView,
  projectColors,
  worktreeColors,
  taskProgress,
  doneTaskIds,
  attentionTaskIds,
  onTabClick,
  onTabClose,
  onTabReorder,
  onTabRename,
  rightContent,
  leftContent,
  hideTabs = false
}: TabBarProps): React.JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const editCancelledRef = useRef(false)

  useEffect(() => {
    if (editingTaskId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingTaskId])

  // Handlers reach every (memoized) tab: stable identities, latest props/state.
  const handleTabClick = useStableCallback(onTabClick)
  const handleTabClose = useStableCallback(onTabClose)

  const handleDoubleClick = useStableCallback((tab: Tab & { type: 'task' }) => {
    if (!onTabRename) return
    setEditingTaskId(tab.taskId)
    setEditValue(tab.title)
  })

  const handleEditSubmit = useStableCallback(() => {
    if (editCancelledRef.current) {
      editCancelledRef.current = false
      setEditingTaskId(null)
      return
    }
    if (editingTaskId && editValue.trim()) {
      onTabRename?.(editingTaskId, editValue.trim())
    }
    setEditingTaskId(null)
  })

  const handleEditCancel = useCallback(() => {
    editCancelledRef.current = true
    setEditingTaskId(null)
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5
      }
    })
  )

  const taskTabs = useMemo(
    () => tabs.filter((t): t is Tab & { type: 'task' } => t.type === 'task'),
    [tabs]
  )
  // Stable unless the tabs change: SortableContext's value (which every tab reads)
  // is keyed on this array, so a fresh one would re-render every tab.
  const taskIds = useMemo(() => taskTabs.map((t) => t.taskId), [taskTabs])
  const activeTab = activeId ? taskTabs.find((t) => t.taskId === activeId) : null
  const homeIndex = tabs.findIndex((t) => t.type === 'home')
  const goHomeShortcut = useShortcutDisplay('go-home')

  // Compute group position for each task tab based on consecutive worktree colors
  const groupPositions = useMemo(() => {
    const positions = new Map<string, GroupPosition>()
    if (!worktreeColors || worktreeColors.size === 0) return positions
    const tt = tabs.filter((t): t is Tab & { type: 'task' } => t.type === 'task')
    for (let i = 0; i < tt.length; i++) {
      const tab = tt[i]
      const color = worktreeColors.get(tab.taskId)
      if (!color) continue
      const prevColor = i > 0 ? worktreeColors.get(tt[i - 1].taskId) : undefined
      const nextColor = i < tt.length - 1 ? worktreeColors.get(tt[i + 1].taskId) : undefined
      const sameAsPrev = color === prevColor
      const sameAsNext = color === nextColor
      if (!sameAsPrev && !sameAsNext) positions.set(tab.taskId, 'solo')
      else if (!sameAsPrev && sameAsNext) positions.set(tab.taskId, 'first')
      else if (sameAsPrev && sameAsNext) positions.set(tab.taskId, 'middle')
      else positions.set(tab.taskId, 'last')
    }
    return positions
  }, [tabs, worktreeColors])

  // --- Strip overflow (#180) ---
  const stripRef = useRef<HTMLDivElement>(null)
  const stripContentRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })

  const updateOverflow = useCallback(() => {
    const el = stripRef.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  // Re-measure when the strip resizes (window) or its content does (tabs opened,
  // closed, renamed).
  useEffect(() => {
    const strip = stripRef.current
    const content = stripContentRef.current
    if (!strip || !content) return
    const ro = new ResizeObserver(updateOverflow)
    ro.observe(strip)
    ro.observe(content)
    updateOverflow()
    return () => ro.disconnect()
  }, [updateOverflow])

  // A mouse wheel only emits vertical deltas; the strip scrolls only horizontally,
  // so map vertical → horizontal. Horizontal deltas (trackpads) scroll natively.
  // Native non-passive listener: React's onWheel is passive, can't preventDefault.
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaX !== 0 || e.deltaY === 0 || e.ctrlKey) return
      const max = el.scrollWidth - el.clientWidth
      if (max <= 0) return
      const next = Math.max(0, Math.min(max, el.scrollLeft + wheelDeltaPx(e, el.clientWidth)))
      if (next === el.scrollLeft) return
      e.preventDefault()
      el.scrollLeft = next
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Keep the active tab visible: switching to an off-screen tab (shortcut, click
  // elsewhere, opening a task) scrolls it in.
  const activeTaskId =
    activeView === 'tabs' && tabs[activeIndex]?.type === 'task'
      ? (tabs[activeIndex] as Tab & { type: 'task' }).taskId
      : null
  useEffect(() => {
    if (!activeTaskId) return
    const tab = stripRef.current?.querySelector('[data-tab-active]')
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTaskId])

  const scrollStripByPage = (direction: 1 | -1): void => {
    const el = stripRef.current
    if (!el) return
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' })
  }

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(event.active.id as string)
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActiveId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = tabs.findIndex((t) => t.type === 'task' && t.taskId === active.id)
    const newIndex = tabs.findIndex((t) => t.type === 'task' && t.taskId === over.id)

    if (oldIndex !== -1 && newIndex !== -1) {
      onTabReorder(oldIndex, newIndex)
    }
  }

  return (
    /* window-drag-region: all interactive children MUST have window-no-drag */
    <div className="flex items-center h-11 pr-2 gap-1 bg-sidebar window-drag-region">
      {/* Fixed static tabs (Home + Context Manager) — not affected by scroll */}
      <div className="flex items-center flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'ml-1 flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer transition-colors select-none flex-shrink-0 window-no-drag',
                'hover:bg-accent/80 dark:hover:bg-accent/50',
                'border',
                activeIndex === homeIndex && activeView !== 'context'
                  ? 'bg-tab-active border-border'
                  : 'border-transparent text-muted-foreground dark:text-muted-foreground'
              )}
              onClick={() => onTabClick(homeIndex)}
            >
              <Home className="size-3.5" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {withShortcut('Home', goHomeShortcut)}
          </TooltipContent>
        </Tooltip>
        {leftContent && (
          <div className="flex items-center self-center window-no-drag">{leftContent}</div>
        )}
      </div>

      {/* Scrollable task tabs area. Edge arrows + fades overlay it (no layout shift);
          scroll-px keeps a revealed tab clear of them. */}
      <div className="relative flex items-center flex-1 min-w-0 self-stretch">
        <div
          ref={stripRef}
          data-testid="task-tab-strip"
          className="flex items-center overflow-x-auto scrollbar-hide scroll-px-10 w-full h-full"
          onScroll={updateOverflow}
        >
          <div ref={stripContentRef} className="flex items-center flex-shrink-0">
            {!hideTabs && (
              /* Task tabs - sortable, flat DOM for dnd-kit compatibility */
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={taskIds} strategy={horizontalListSortingStrategy}>
                  {taskTabs.map((tab) => {
                    const index = tabs.findIndex(
                      (t) => t.type === 'task' && t.taskId === tab.taskId
                    )
                    const isEditing = editingTaskId === tab.taskId
                    return (
                      <SortableTab
                        key={tab.taskId}
                        tab={tab}
                        index={index}
                        isActive={index === activeIndex && activeView === 'tabs'}
                        onTabClick={handleTabClick}
                        onTabClose={handleTabClose}
                        needsAttention={attentionTaskIds?.has(tab.taskId)}
                        projectColor={projectColors?.get(tab.taskId)}
                        worktreeColor={worktreeColors?.get(tab.taskId)}
                        progress={taskProgress?.get(tab.taskId)}
                        isDone={doneTaskIds?.has(tab.taskId)}
                        groupPosition={groupPositions.get(tab.taskId)}
                        isEditing={isEditing}
                        editValue={isEditing ? editValue : undefined}
                        onEditChange={setEditValue}
                        onEditSubmit={handleEditSubmit}
                        onEditCancel={handleEditCancel}
                        onDoubleClick={handleDoubleClick}
                        inputRef={editInputRef}
                      />
                    )
                  })}
                </SortableContext>
                <DragOverlay>
                  {activeTab && (
                    <TabContent
                      title={activeTab.title}
                      isActive={
                        tabs.findIndex(
                          (t) => t.type === 'task' && t.taskId === activeTab.taskId
                        ) === activeIndex
                      }
                      isDragging
                      taskId={activeTab.taskId}
                      needsAttention={attentionTaskIds?.has(activeTab.taskId)}
                      isTemporary={activeTab.isTemporary}
                      projectColor={projectColors?.get(activeTab.taskId)}
                      progress={taskProgress?.get(activeTab.taskId)}
                      isDone={doneTaskIds?.has(activeTab.taskId)}
                    />
                  )}
                </DragOverlay>
              </DndContext>
            )}
          </div>
        </div>
        {overflow.left && <StripScrollButton side="left" onClick={() => scrollStripByPage(-1)} />}
        {overflow.right && <StripScrollButton side="right" onClick={() => scrollStripByPage(1)} />}
      </div>

      {/* Fixed right content */}
      {rightContent && (
        <div className="flex items-center flex-shrink-0 self-center window-no-drag">
          {rightContent}
        </div>
      )}
    </div>
  )
}
