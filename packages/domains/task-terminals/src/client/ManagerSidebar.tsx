import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ListTree, Circle } from 'lucide-react'
import { cn, Switch, Label, getTaskStatusStyle, ProgressRing } from '@slayzone/ui'
import { PtyStateDot } from '@slayzone/terminal'
import type { TerminalMode } from '@slayzone/terminal/shared'

const WIDTH_STORAGE_KEY = 'slayzone:manager-sidebar-width'
const HIDE_COMPLETED_KEY = 'slayzone:manager-sidebar-hide-completed'
const MIN_WIDTH = 160
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 240
const COMPLETED_STATUSES = new Set(['done', 'canceled', 'completed', 'archived'])

function loadWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH
  const raw = window.localStorage?.getItem(WIDTH_STORAGE_KEY)
  const n = raw ? Number.parseInt(raw, 10) : NaN
  if (!Number.isFinite(n)) return DEFAULT_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))
}

// Minimal shape of a Task we use here. Avoid importing @slayzone/task/shared
// to prevent a circular package dep (task depends on task-terminals).
export interface ManagerTask {
  id: string
  parent_id: string | null
  title: string
  worktree_path: string | null
  base_dir: string | null
  terminal_mode: TerminalMode
  status: string
  progress: number
}

export interface ManagerSidebarProps {
  rootTaskId: string
  rootTitle: string
  rootStatus?: string
  rootProgress?: number
  selectedTaskId: string | null
  /** null = root (parent) selected; otherwise the selected subtask */
  onSelect: (task: ManagerTask | null) => void
  /** Click handler for the manager-mode toggle button rendered in the sidebar header. */
  onToggleOff?: () => void
}

interface TreeNode {
  task: ManagerTask
  children: TreeNode[]
  depth: number
  /**
   * Per-ancestor "branch continues below this row" flag, length = depth.
   * Index `a` = ancestor at depth `a` has later descendants rendered after this row
   * (i.e. its child-in-chain at depth `a+1` is not the last sibling).
   * Controls whether to draw the vertical guide line at that ancestor's column.
   */
  ancestorFlags: boolean[]
}

function buildTree(rows: ManagerTask[], rootId: string): TreeNode[] {
  const byParent = new Map<string, ManagerTask[]>()
  for (const t of rows) {
    const p = t.parent_id ?? ''
    const arr = byParent.get(p) ?? []
    arr.push(t)
    byParent.set(p, arr)
  }
  const walk = (parentId: string, depth: number, parentFlags: boolean[]): TreeNode[] => {
    const kids = byParent.get(parentId) ?? []
    return kids.map((task, i) => {
      const flags = [...parentFlags, i < kids.length - 1]
      return {
        task,
        depth,
        ancestorFlags: flags,
        children: walk(task.id, depth + 1, flags),
      }
    })
  }
  // Depth starts at 1 so root's direct children are one level indented; root occupies depth 0.
  return walk(rootId, 1, [])
}

// Tree layout constants.
const INDENT = 24
const ROW_HEIGHT = 28 // h-7
const CURVE_R = 6     // bezier corner radius
const ELBOW_END_OFFSET = INDENT / 2 // horizontal distance from guide line to curve end
const TEXT_GAP_AFTER_CURVE = 8      // extra spacing between curve end and title text
// Ancestor guide columns: root icon center = 16, each level adds INDENT.
function guideXForAncestor(ancestorDepth: number): number {
  return 16 + INDENT * ancestorDepth
}
function paddingLeftForDepth(depth: number): number {
  return guideXForAncestor(depth - 1) + ELBOW_END_OFFSET + TEXT_GAP_AFTER_CURVE
}

function ProgressDot({ sessionId, progress, isDone }: { sessionId: string; progress: number; isDone: boolean }): React.JSX.Element {
  const show = !isDone && progress > 0
  return (
    <span className="relative inline-flex items-center justify-center shrink-0 size-3.5">
      {show && <ProgressRing value={progress} size={14} strokeWidth={1.5} className="absolute inset-0" />}
      <PtyStateDot sessionId={sessionId} />
    </span>
  )
}

function TreeGuides({ depth, ancestorFlags }: { depth: number; ancestorFlags: boolean[] }): React.JSX.Element | null {
  if (depth <= 0) return null
  const parentX = guideXForAncestor(depth - 1)
  const mid = ROW_HEIGHT / 2
  const r = CURVE_R
  const endX = parentX + ELBOW_END_OFFSET
  const isLast = !ancestorFlags[depth - 1]

  // Immediate-parent connector: vertical down to curve start, quadratic-bezier corner, then horizontal into elbow endpoint.
  // If NOT last sibling, also emit a second sub-path continuing the vertical line to the row bottom.
  const connector =
    `M ${parentX} 0 V ${mid - r} Q ${parentX} ${mid} ${parentX + r} ${mid} H ${endX}` +
    (isLast ? '' : ` M ${parentX} ${mid - r} V ${ROW_HEIGHT}`)

  const svgWidth = endX + 2
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute top-0 left-0"
      width={svgWidth}
      height={ROW_HEIGHT}
    >
      {/* Deeper-ancestor vertical lines (a < depth-1). Drawn only if that ancestor branch continues below this row. */}
      {ancestorFlags.slice(0, -1).map((flag, a) =>
        flag ? (
          <line
            key={a}
            x1={guideXForAncestor(a)}
            x2={guideXForAncestor(a)}
            y1={0}
            y2={ROW_HEIGHT}
            stroke="var(--border)"
            strokeWidth={1}
          />
        ) : null
      )}
      <path d={connector} fill="none" stroke="var(--border)" strokeWidth={1} />
    </svg>
  )
}

function NodeRow({
  node,
  selectedTaskId,
  onSelect,
}: {
  node: TreeNode
  selectedTaskId: string | null
  onSelect: (task: ManagerTask) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const sessionId = `${node.task.id}:${node.task.id}`
  const hasChildren = node.children.length > 0
  const isSelected = selectedTaskId === node.task.id
  const isCompleted = COMPLETED_STATUSES.has(node.task.status)
  const statusStyle = getTaskStatusStyle(node.task.status)
  const StatusIcon = statusStyle?.icon ?? Circle

  return (
    <>
      <button
        type="button"
        data-testid={`manager-node-${node.task.id}`}
        onClick={() => onSelect(node.task)}
        className={cn(
          'group relative w-full flex items-center gap-1.5 h-7 pr-2 rounded-md text-left text-sm shrink-0 transition-colors',
          isSelected
            ? 'bg-tab-active text-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        )}
        style={{ paddingLeft: paddingLeftForDepth(node.depth) }}
      >
        <TreeGuides depth={node.depth} ancestorFlags={node.ancestorFlags} />
        <span className={cn('truncate flex-1', isCompleted && 'line-through opacity-60')}>{node.task.title || 'Untitled'}</span>
        <span className="shrink-0 flex items-center justify-center size-4">
          {hasChildren && (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((v) => !v)
              }}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              className="flex items-center justify-center size-4 rounded hover:bg-accent/40"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
            </span>
          )}
        </span>
        <StatusIcon className={cn('shrink-0 size-3.5', statusStyle?.iconClass)} aria-label={statusStyle?.label} />
        <ProgressDot sessionId={sessionId} progress={node.task.progress} isDone={isCompleted} />
      </button>
      {expanded &&
        node.children.map((child) => (
          <NodeRow
            key={child.task.id}
            node={child}
            selectedTaskId={selectedTaskId}
            onSelect={onSelect}
          />
        ))}
    </>
  )
}

export function ManagerSidebar({
  rootTaskId,
  rootTitle,
  rootStatus,
  rootProgress,
  selectedTaskId,
  onSelect,
  onToggleOff,
}: ManagerSidebarProps): React.JSX.Element {
  const [descendants, setDescendants] = useState<ManagerTask[]>([])

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      window.api.db
        .getSubTasksRecursive(rootTaskId)
        .then((rows) => {
          if (!cancelled) setDescendants(rows as unknown as ManagerTask[])
        })
        .catch(() => {})
    }
    refresh()
    const cleanup = window.api?.app?.onTasksChanged?.(refresh)
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [rootTaskId])

  const [hideCompleted, setHideCompleted] = useState<boolean>(() => {
    try { return window.localStorage?.getItem(HIDE_COMPLETED_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { window.localStorage?.setItem(HIDE_COMPLETED_KEY, hideCompleted ? '1' : '0') } catch { /* ignore */ }
  }, [hideCompleted])

  const visibleDescendants = useMemo(
    () => hideCompleted ? descendants.filter(t => !COMPLETED_STATUSES.has(t.status)) : descendants,
    [descendants, hideCompleted]
  )
  const tree = useMemo(() => buildTree(visibleDescendants, rootTaskId), [visibleDescendants, rootTaskId])
  const rootSessionId = `${rootTaskId}:${rootTaskId}`
  const isRootSelected = selectedTaskId === null || selectedTaskId === rootTaskId
  const rootCompleted = rootStatus ? COMPLETED_STATUSES.has(rootStatus) : false
  const rootStatusStyle = getTaskStatusStyle(rootStatus)
  const RootStatusIcon = rootStatusStyle?.icon ?? Circle

  const [width, setWidth] = useState<number>(loadWidth)
  const dragStartRef = useRef<{ x: number; startWidth: number } | null>(null)

  useEffect(() => {
    try { window.localStorage?.setItem(WIDTH_STORAGE_KEY, String(width)) } catch { /* ignore */ }
  }, [width])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartRef.current = { x: e.clientX, startWidth: width }
    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, start.startWidth + (ev.clientX - start.x)))
      setWidth(next)
    }
    const onUp = () => {
      dragStartRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  return (
    <div
      data-testid="manager-sidebar"
      style={{ width }}
      className="relative shrink-0 h-full"
    >
      <div className="h-full bg-surface-1 border-r border-border flex flex-col">
        <div className="flex items-center h-10 pl-3 pr-2 gap-2 border-b border-border shrink-0">
          <span className="text-sm font-medium truncate flex-1">Agent overview</span>
          {onToggleOff && (
            <button
              type="button"
              data-testid="terminal-manager-toggle"
              className={cn(
                'flex items-center justify-center h-7 w-7 rounded-md shrink-0 cursor-pointer transition-all select-none',
                'bg-surface-2 dark:bg-surface-2/50 hover:bg-accent/80 dark:hover:bg-accent/50 text-muted-foreground'
              )}
              onClick={onToggleOff}
              title="Manager mode"
              aria-pressed="true"
            >
              <ListTree className="size-4" />
            </button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-1">
          <button
            type="button"
            data-testid="manager-node-root"
            onClick={() => onSelect(null)}
            className={cn(
              'w-full flex items-center gap-2 h-9 px-2 rounded-md text-left text-base shrink-0 transition-colors',
              isRootSelected
                ? 'bg-tab-active text-foreground'
                : 'text-foreground hover:bg-accent/50'
            )}
          >
            <RootStatusIcon className={cn('shrink-0 size-4', rootStatusStyle?.iconClass)} aria-label={rootStatusStyle?.label} />
            <span className={cn('truncate flex-1 font-semibold', rootCompleted && 'line-through opacity-60')}>{rootTitle || 'Main'}</span>
            <ProgressDot sessionId={rootSessionId} progress={rootProgress ?? 0} isDone={rootCompleted} />
          </button>
          {tree.map((node) => (
            <NodeRow
              key={node.task.id}
              node={node}
              selectedTaskId={selectedTaskId}
              onSelect={onSelect}
            />
          ))}
        </div>
        <div className="shrink-0 border-t border-border px-3 py-2 flex items-center justify-between gap-2">
          <Label htmlFor="manager-hide-completed" className="text-xs text-muted-foreground cursor-pointer">Hide completed tasks</Label>
          <Switch
            id="manager-hide-completed"
            data-testid="manager-hide-completed"
            checked={hideCompleted}
            onCheckedChange={setHideCompleted}
          />
        </div>
      </div>
      <div
        data-testid="manager-sidebar-resize"
        onMouseDown={handleResizeStart}
        className="absolute top-0 right-0 h-full w-1 -mr-0.5 cursor-col-resize hover:bg-ring/60 active:bg-ring z-10"
        role="separator"
        aria-orientation="vertical"
      />
    </div>
  )
}
