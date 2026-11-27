import type { Tag } from '@slayzone/tags/shared'
import { useTabStore } from '@slayzone/tabs-state'
import { TaskRow, TG_ROW_HEIGHT, type TaskBranchCtx } from '../views/tree-view'
import { previewRowTask } from './mock-data'

const NOOP = (): void => {
  // Read-only preview: no action does anything.
}
const EMPTY: Set<string> = new Set()
const DENSE_ROW_HEIGHT = 24

const exampleTask = previewRowTask()
const doneTask = { ...exampleTask, id: 'mock-preview-done', title: 'Shipped task', status: 'done' }
const PREVIEW_TAG = { id: 'mock-tag', name: 'ui', color: '#7c6cf0', text_color: '#ffffff' } as Tag
const DONE_IDS = new Set([doneTask.id])
const BLOCKED_IDS = new Set([exampleTask.id])

/** "How rows look": two sample rows drawn by the tree's own row with the live settings. */
export function LensRowPreview(): React.JSX.Element {
  const treeShowStatus = useTabStore((s) => s.treeShowStatus)
  const treeShowPriority = useTabStore((s) => s.treeShowPriority)
  const treeShowWorktree = useTabStore((s) => s.treeShowWorktree)
  const treeShowTags = useTabStore((s) => s.treeShowTags)
  const treeShowBlockedBadge = useTabStore((s) => s.treeShowBlockedBadge)
  const treeCrossOutDone = useTabStore((s) => s.treeCrossOutDone)
  const dense = useTabStore((s) => s.treeLensGroup === 'project' && s.treeLensLook === 'dense')

  const ctx: TaskBranchCtx = {
    childrenByParent: new Map(),
    activeTaskId: null,
    openTabTaskIds: new Set([exampleTask.id]),
    doneTaskIds: DONE_IDS,
    pinnedSet: EMPTY,
    selectedTaskIds: EMPTY,
    selectedTaskIdArr: [],
    activeDragTaskId: null,
    treeShowStatus,
    treeShowPriority,
    treeShowWorktree,
    worktreeColors: new Map(),
    tagsByTaskId: treeShowTags ? new Map([[exampleTask.id, [PREVIEW_TAG]]]) : new Map(),
    blockedBadgeTaskIds: treeShowBlockedBadge ? BLOCKED_IDS : EMPTY,
    treeCrossOutDone,
    treeGroupBy: 'none',
    treeGroupPinned: false,
    treeGroupBlocked: false,
    onRowSelectClick: NOOP,
    dragEnabled: false,
    editingTaskId: null,
    onStartEdit: NOOP,
    onCommitEdit: NOOP,
    onCancelEdit: NOOP,
    tasksWithChildren: EMPTY,
    collapsedTaskIds: EMPTY,
    onToggleCollapse: NOOP,
    rowHeight: dense ? DENSE_ROW_HEIGHT : TG_ROW_HEIGHT
  }

  return (
    <div
      data-testid="lens-row-preview"
      className="pointer-events-none rounded-lg border border-border bg-sidebar py-1 pr-2"
      aria-hidden
    >
      <TaskRow task={exampleTask} depth={0} ancestorFlags={[]} inTempGroup ctx={ctx} />
      <TaskRow task={doneTask} depth={0} ancestorFlags={[]} inTempGroup ctx={ctx} />
    </div>
  )
}
