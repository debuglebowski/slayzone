import { Fragment, useEffect, useState } from 'react'
import type { PanelInstance, PanelSizes, TaskLayout } from '@slayzone/task-contracts'
import { ResizeHandle } from '../ResizeHandle'
import { applyBoundaryResize, minWidthFor, unstretchPx } from '../usePanelSizes'
import { LayoutColumn } from './LayoutColumn'
import { LayoutActionsContext, type LayoutActions } from './LayoutContext'
import { LayoutDnd } from './LayoutDnd'
import type { DragItem, DropTarget } from './layoutDnd'
import { PANEL_KIND_COMPONENTS } from '../panels/kinds'
import { PanelCellContext, PanelStripContext } from '../panels/PanelFrame'
import { TaskPageProvider, useTaskPageContext } from '../panels/TaskPageContext'
import { isRenderableKind } from './panelTabMeta'
import { PanelHosts, PanelNodePool, PanelNodePoolContext, PanelTarget } from './PanelHosts'
import {
  compactColumns,
  domOrderedColumns,
  placePanels,
  type LayoutStrip,
  type PanelPlacement
} from './strip'

/** The agent an explode-mode cell shows when the layout holds none (a disabled, hidden agent). */
const FALLBACK_COMPACT_AGENT: PanelInstance = { id: 'terminal', kind: 'agent', settings: {} }

/**
 * One placed panel: its kind's component (a kind this app cannot render shows
 * nothing). An inactive tab sees its task page as inactive — the keep-alive a task
 * tab in the background gets (PANEL_KINDS[kind].keepAlive): browser, web and the
 * agent stay mounted and park themselves; every other kind goes into
 * <Activity hidden> in its PanelFrame.
 */
function PlacedPanel({ placement }: { placement: PanelPlacement }): React.JSX.Element | null {
  const page = useTaskPageContext()
  const { instance, active, inCell, inStrip } = placement
  if (!isRenderableKind(instance.kind)) return null
  const Kind = PANEL_KIND_COMPONENTS[instance.kind]
  const value = active ? page : { ...page, isActive: false, shortcutActive: false }
  return (
    <TaskPageProvider value={value}>
      <PanelCellContext value={inCell}>
        <PanelStripContext value={inStrip}>
          <Kind panelId={instance.id} instance={instance} />
        </PanelStripContext>
      </PanelCellContext>
    </TaskPageProvider>
  )
}

const renderPlacedPanel = (placement: PanelPlacement): React.JSX.Element => (
  <PlacedPanel placement={placement} />
)

interface TaskLayoutViewProps {
  layout: TaskLayout
  /** `resolveLayoutStrip(layout, containerWidth)`: the page reads widths from it too. */
  strip: LayoutStrip
  /** Explode-mode cell: the agent alone, no handles, gap or empty state. */
  compact?: boolean
  containerWidth: number
  /** Configured web panel ids, in config order (their stable DOM order). */
  webPanelIds: readonly string[]
  /** No panel is shown: render the empty state. */
  empty: boolean
  /** Live column size overrides during a boundary drag. */
  onResize: (overrides: Partial<PanelSizes>) => void
  onResizeStart: () => void
  onResizeEnd: () => void
  /** Double-click on a handle: every column back to its default size. */
  onResetSizes: () => void
  /** Tab and group actions (strips, tab menus, slot dividers). */
  actions: Omit<LayoutActions, 'onResizeStart' | 'onResizeEnd'>
  /** A finished panel drag. */
  onDrop: (item: DragItem, target: DropTarget) => void
  /** A panel drag starts / has settled (native views hide meanwhile, like a resize). */
  onDraggingChange: (dragging: boolean) => void
}

/**
 * The task's panels as a horizontal strip of layout columns (the inside of
 * `#task-panels`). Columns are resolved like the legacy strip — px/pct/fr widths,
 * left and right clusters with the anchor gap between them, a resize handle at
 * every boundary that transfers width between its two neighbours — and laid out
 * by flex `order`, while the DOM keeps a stable order (see `domOrderedColumns`).
 * Compact mode renders the agent alone through the same element path, so
 * entering/leaving explode mode keeps its terminal mounted.
 */
export function TaskLayoutView({
  layout,
  strip,
  compact = false,
  containerWidth,
  webPanelIds,
  empty,
  onResize,
  onResizeStart,
  onResizeEnd,
  onResetSizes,
  actions,
  onDrop,
  onDraggingChange
}: TaskLayoutViewProps): React.JSX.Element {
  const { resolved, plan, layouts } = strip
  const compactAgent = compact ? compactColumns(layout) : null
  const columns = compact
    ? (compactAgent ?? [])
    : domOrderedColumns(layout, strip.columns, webPanelIds)
  // Every panel renders once, keyed by instance id, into its target in the tree
  // below (PanelHosts): moving a tab between groups never remounts its panel.
  const [pool] = useState(() => new PanelNodePool())
  const placements = placePanels(layout, columns, compact)
  if (compact && compactAgent === null)
    placements.push({
      instance: FALLBACK_COMPACT_AGENT,
      active: true,
      inCell: false,
      inStrip: false
    })
  const placedKey = placements.map((p) => p.instance.id).join(' ')
  useEffect(() => {
    pool.retain(new Set(placedKey.split(' ')))
  }, [pool, placedKey])
  const layoutActions: LayoutActions = {
    ...actions,
    onResizeStart,
    onResizeEnd
  }

  // The divider before `columnId`: dragging it moves the boundary with its
  // same-cluster left neighbour, each column keeping its unit (fr stays fr).
  const renderHandle = (columnId: string): React.ReactNode => {
    const leftId = compact ? undefined : plan.leftNeighbor[columnId]
    if (!leftId) return null
    return (
      <ResizeHandle
        leftWidth={resolved.widths[leftId] ?? 200}
        rightWidth={resolved.widths[columnId] ?? 200}
        leftMinWidth={resolved.minPx[leftId] ?? minWidthFor(leftId)}
        rightMinWidth={resolved.minPx[columnId] ?? minWidthFor(columnId)}
        leftMaxWidth={resolved.maxPx[leftId]}
        rightMaxWidth={resolved.maxPx[columnId]}
        onResize={(lw, rw) =>
          onResize(
            applyBoundaryResize(
              layouts[leftId],
              layouts[columnId],
              leftId,
              columnId,
              unstretchPx(resolved, leftId, lw),
              unstretchPx(resolved, columnId, rw),
              containerWidth
            )
          )
        }
        onDragStart={onResizeStart}
        onDragEnd={onResizeEnd}
        onReset={onResetSizes}
        style={{ order: plan.order[columnId] ?? 0 }}
      />
    )
  }

  return (
    <>
      {!compact && empty && (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-xl min-h-52 rounded-lg border border-border bg-surface-3 px-5 py-7 text-center flex flex-col items-center justify-center">
            <p className="text-2xl font-semibold">No panel tab is shown</p>
            <p className="mt-3 text-base text-muted-foreground">
              Use the panel tabs in the header to open one.
            </p>
          </div>
        </div>
      )}

      {/* Anchor gap: leftover space pushing right-aligned columns to the right edge */}
      {!compact && resolved.rightKeys.length > 0 && (
        <div
          aria-hidden
          data-testid="panel-gap"
          className="shrink-0"
          style={{ width: resolved.gapPx, order: plan.spacerOrder ?? 0 }}
        />
      )}

      <PanelNodePoolContext value={pool}>
        {compact && compactAgent === null && (
          // No agent in the layout (a disabled, hidden agent): the cell still shows it.
          <PanelTarget instanceId={FALLBACK_COMPACT_AGENT.id} />
        )}
        <LayoutActionsContext value={layoutActions}>
          <LayoutDnd layout={layout} onDrop={onDrop} onDraggingChange={onDraggingChange}>
            {columns.map((column) => (
              <Fragment key={column.id}>
                {renderHandle(column.id)}
                <LayoutColumn
                  layout={layout}
                  column={column}
                  width={resolved.widths[column.id]}
                  order={plan.order[column.id] ?? 0}
                  compact={compact}
                />
              </Fragment>
            ))}
          </LayoutDnd>
        </LayoutActionsContext>
        {/* After the tree: its targets adopt the host nodes before the panels' layout effects run. */}
        <PanelHosts placements={placements} pool={pool} render={renderPlacedPanel} />
      </PanelNodePoolContext>
    </>
  )
}
