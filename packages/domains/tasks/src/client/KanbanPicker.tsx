import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  cn,
  buildStatusOptions,
  getColumnStatusStyle
} from '@slayzone/ui'
import type { PickerState } from './useKanbanKeyboard'
import { PRIORITY_LABELS } from './kanban'

interface KanbanPickerProps {
  pickerState: PickerState | null
  onClose: () => void
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  tasks: Task[]
  columns?: ColumnConfig[] | null
  cardRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
}

export function KanbanPicker({
  pickerState,
  onClose,
  onUpdateTask,
  tasks,
  columns,
  // Ref-suffixed local name: lets the React Compiler see this is a ref, so the
  // DOM measurement below (rect -> anchor state) is recognised as ref-derived.
  cardRefs: cardElementsRef
}: KanbanPickerProps): React.JSX.Element | null {
  const [anchorStyle, setAnchorStyle] = useState<React.CSSProperties>({})
  const statusOptions = buildStatusOptions(columns)

  useEffect(() => {
    if (!pickerState) return
    const el = cardElementsRef.current.get(pickerState.taskId)
    if (!el) return
    const rect = el.getBoundingClientRect()
    setAnchorStyle({
      position: 'fixed',
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      pointerEvents: 'none' as const
    })
  }, [pickerState, cardElementsRef])

  if (!pickerState) return null

  const task = tasks.find((t) => t.id === pickerState.taskId)
  if (!task) return null

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <div style={anchorStyle} />
      </PopoverAnchor>
      <PopoverContent side="right" align="start" sideOffset={8} className="w-44 p-1">
        {pickerState.type === 'status' ? (
          <PickerList
            items={statusOptions.map((s) => {
              const style = getColumnStatusStyle(s.value, columns)
              return {
                key: s.value,
                label: s.label,
                icon: style ? <style.icon className={cn('size-4', style.iconClass)} /> : null,
                isCurrent: task.status === s.value
              }
            })}
            initialIndex={statusOptions.findIndex((s) => s.value === task.status)}
            onSelect={(index) => {
              onUpdateTask(task.id, { status: statusOptions[index].value as Task['status'] })
              onClose()
            }}
            onClose={onClose}
          />
        ) : (
          <PickerList
            items={Object.entries(PRIORITY_LABELS).map(([value, label]) => ({
              key: value,
              label,
              icon: null,
              isCurrent: task.priority === Number(value)
            }))}
            initialIndex={task.priority - 1}
            onSelect={(index) => {
              const value = Number(Object.keys(PRIORITY_LABELS)[index])
              onUpdateTask(task.id, { priority: value })
              onClose()
            }}
            onClose={onClose}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

interface PickerItem {
  key: string
  label: string
  icon: React.ReactNode
  isCurrent: boolean
}

function PickerList({
  items,
  initialIndex,
  onSelect,
  onClose
}: {
  items: PickerItem[]
  initialIndex: number
  onSelect: (index: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(Math.max(0, initialIndex))
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-focus the container so it receives keyboard events
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Number keys 1-9 for direct selection
      const num = parseInt(e.key, 10)
      if (num >= 1 && num <= items.length) {
        e.preventDefault()
        onSelect(num - 1)
        return
      }

      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault()
          setActiveIndex((i) => Math.min(items.length - 1, i + 1))
          break
        case 'ArrowUp':
        case 'k':
          e.preventDefault()
          setActiveIndex((i) => Math.max(0, i - 1))
          break
        case 'Enter':
          e.preventDefault()
          onSelect(activeIndex)
          break
        case 'Escape':
          e.preventDefault()
          e.stopPropagation() // prevent useHotkeys from also seeing Escape
          onClose()
          break
      }
    },
    [items.length, activeIndex, onSelect, onClose]
  )

  return (
    <div ref={containerRef} tabIndex={-1} onKeyDown={handleKeyDown} className="outline-none">
      {items.map((item, i) => (
        <button
          key={item.key}
          className={cn(
            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
            i === activeIndex && 'bg-accent text-accent-foreground',
            item.isCurrent && i !== activeIndex && 'text-muted-foreground'
          )}
          onMouseEnter={() => setActiveIndex(i)}
          onClick={() => onSelect(i)}
        >
          <span className="text-xs text-muted-foreground w-3">{i + 1}</span>
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}
