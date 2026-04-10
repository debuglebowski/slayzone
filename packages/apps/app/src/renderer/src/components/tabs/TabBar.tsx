import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { Home, X } from 'lucide-react'
import { cn, Tooltip, TooltipTrigger, TooltipContent, getTerminalStateStyle, projectColorBg, useShortcutDisplay } from '@slayzone/ui'
import type { TerminalState } from '@slayzone/terminal/shared'
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
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

export type Tab =
  | { type: 'home' }
  | { type: 'task'; taskId: string; title: string; terminalState?: TerminalState; isSubTask?: boolean; isTemporary?: boolean }

interface TabBarProps {
  tabs: Tab[]
  activeIndex: number
  activeView?: string
  terminalStates?: Map<string, TerminalState>
  projectColors?: Map<string, string>
  worktreeColors?: Map<string, string>
  onTabClick: (index: number) => void
  onTabClose: (index: number) => void
  onTabReorder: (fromIndex: number, toIndex: number) => void
  onTabRename?: (taskId: string, title: string) => void
  rightContent?: React.ReactNode
  leftContent?: React.ReactNode
}

interface TabContentProps {
  title: string
  isActive: boolean
  isDragging?: boolean
  onClose?: () => void
  terminalState?: TerminalState
  isSubTask?: boolean
  isTemporary?: boolean
  projectColor?: string
  isEditing?: boolean
  editValue?: string
  onEditChange?: (value: string) => void
  onEditSubmit?: () => void
  onEditCancel?: () => void
  inputRef?: React.RefObject<HTMLInputElement | null>
}

function getStateInfo(state: TerminalState | undefined) {
  return getTerminalStateStyle(state)
}

function TabContent({ title, isActive, isDragging, onClose, terminalState, isSubTask, isTemporary, projectColor, isEditing, editValue, onEditChange, onEditSubmit, onEditCancel, inputRef }: TabContentProps): React.JSX.Element {
  const stateInfo = getStateInfo(terminalState)

  return (
    <div
      className={cn(
        'group relative flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer transition-colors select-none flex-shrink-0',
        !projectColor && !isActive && 'bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200/80 dark:hover:bg-neutral-700/50',
        !isActive && 'text-neutral-500 dark:text-neutral-400',
        isTemporary && 'border border-dashed border-neutral-400 dark:border-neutral-500',
        'max-w-[300px]',
        isDragging && 'shadow-lg'
      )}
      style={{
        backgroundColor: isActive
          ? (projectColor ? projectColor + '80' : 'var(--sidebar-accent)')
          : projectColorBg(projectColor, 'tab'),
        ...(isActive && {
          boxShadow: '0 0 0 1px var(--sidebar-border), 0 1px 4px rgba(0,0,0,0.2)',
        })
      }}
    >
      {projectColor && <div className="pointer-events-none absolute inset-0 rounded-md opacity-0 transition-opacity group-hover:opacity-100 bg-black/10 dark:bg-white/10" />}
      {stateInfo && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn('w-2 h-2 rounded-full flex-shrink-0', stateInfo.color)} />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {stateInfo.label}
          </TooltipContent>
        </Tooltip>
      )}
      {isSubTask && <span className="text-[10px] text-muted-foreground/60 shrink-0">SUB</span>}
      {isEditing ? (
        <input
          ref={inputRef}
          className="bg-transparent border-none outline-none text-sm w-28 min-w-0"
          value={editValue}
          onChange={(e) => onEditChange?.(e.target.value)}
          onBlur={() => onEditSubmit?.()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onEditSubmit?.() }
            if (e.key === 'Escape') { e.preventDefault(); onEditCancel?.() }
            e.stopPropagation()
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className={cn('truncate text-sm', isTemporary && 'italic text-muted-foreground')}>{title}</span>
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

type GroupPosition = 'solo' | 'first' | 'middle' | 'last'

interface SortableTabProps {
  tab: Tab & { type: 'task' }
  index: number
  isActive: boolean
  onTabClick: (index: number) => void
  onTabClose: (index: number) => void
  terminalState?: TerminalState
  projectColor?: string
  worktreeColor?: string
  groupPosition?: GroupPosition
  isEditing?: boolean
  editValue?: string
  onEditChange?: (value: string) => void
  onEditSubmit?: () => void
  onEditCancel?: () => void
  onDoubleClick?: () => void
  inputRef?: React.RefObject<HTMLInputElement | null>
}

function SortableTab({
  tab,
  index,
  isActive,
  onTabClick,
  onTabClose,
  terminalState,
  projectColor,
  worktreeColor,
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
    id: tab.taskId
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
      groupPosition === 'solo' ? 8 :
      groupPosition === 'first' ? '8px 0 0 8px' :
      groupPosition === 'last' ? '0 8px 8px 0' : 0
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
      onClick={() => !isEditing && onTabClick(index)}
      onDoubleClick={onDoubleClick}
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
        terminalState={terminalState}
        isSubTask={tab.isSubTask}
        isTemporary={tab.isTemporary}
        projectColor={projectColor}
        isEditing={isEditing}
        editValue={editValue}
        onEditChange={onEditChange}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
        inputRef={inputRef}
      />
    </div>
  )
}

export function TabBar({
  tabs,
  activeIndex,
  activeView,
  terminalStates,
  projectColors,
  worktreeColors,
  onTabClick,
  onTabClose,
  onTabReorder,
  onTabRename,
  rightContent,
  leftContent
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

  const handleDoubleClick = useCallback((tab: Tab & { type: 'task' }) => {
    if (!onTabRename) return
    setEditingTaskId(tab.taskId)
    setEditValue(tab.title)
  }, [onTabRename])

  const handleEditSubmit = useCallback(() => {
    if (editCancelledRef.current) { editCancelledRef.current = false; setEditingTaskId(null); return }
    if (editingTaskId && editValue.trim()) {
      onTabRename?.(editingTaskId, editValue.trim())
    }
    setEditingTaskId(null)
  }, [editingTaskId, editValue, onTabRename])

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

  const taskTabs = tabs.filter((t): t is Tab & { type: 'task' } => t.type === 'task')
  const taskIds = taskTabs.map((t) => t.taskId)
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
        <Tooltip><TooltipTrigger asChild>
          <div
            className={cn(
              'ml-1 flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer transition-colors select-none flex-shrink-0 window-no-drag',
              'hover:bg-neutral-200/80 dark:hover:bg-neutral-700/50',
              'border',
              activeIndex === homeIndex && activeView !== 'context'
                ? 'bg-neutral-200 dark:bg-neutral-700 border-neutral-300 dark:border-neutral-600'
                : 'border-transparent text-neutral-500 dark:text-neutral-400'
            )}
            onClick={() => onTabClick(homeIndex)}
          >
            <Home className="h-4 w-4" />
          </div>
        </TooltipTrigger><TooltipContent side="bottom" className="text-xs">Home ({goHomeShortcut})</TooltipContent></Tooltip>
        {leftContent && (
          <div className="flex items-center self-center window-no-drag">{leftContent}</div>
        )}
      </div>

      {/* Scrollable task tabs area */}
      <div className="flex items-center overflow-x-auto scrollbar-hide flex-1 min-w-0">
        {/* Task tabs - sortable, flat DOM for dnd-kit compatibility */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={taskIds} strategy={horizontalListSortingStrategy}>
            {taskTabs.map((tab) => {
              const index = tabs.findIndex((t) => t.type === 'task' && t.taskId === tab.taskId)
              return (
                <SortableTab
                  key={tab.taskId}
                  tab={tab}
                  index={index}
                  isActive={index === activeIndex && activeView === 'tabs'}
                  onTabClick={onTabClick}
                  onTabClose={onTabClose}
                  terminalState={terminalStates?.get(tab.taskId)}
                  projectColor={projectColors?.get(tab.taskId)}
                  worktreeColor={worktreeColors?.get(tab.taskId)}
                  groupPosition={groupPositions.get(tab.taskId)}
                  isEditing={editingTaskId === tab.taskId}
                  editValue={editValue}
                  onEditChange={setEditValue}
                  onEditSubmit={handleEditSubmit}
                  onEditCancel={handleEditCancel}
                  onDoubleClick={() => handleDoubleClick(tab)}
                  inputRef={editInputRef}
                />
              )
            })}
          </SortableContext>
          <DragOverlay>
            {activeTab && (
              <TabContent
                title={activeTab.title}
                isActive={tabs.findIndex((t) => t.type === 'task' && t.taskId === activeTab.taskId) === activeIndex}
                isDragging
                terminalState={terminalStates?.get(activeTab.taskId)}
                isTemporary={activeTab.isTemporary}
                projectColor={projectColors?.get(activeTab.taskId)}
              />
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Fixed right content */}
      {rightContent && (
        <div className="flex items-center flex-shrink-0 self-center window-no-drag">{rightContent}</div>
      )}
    </div>
  )
}
