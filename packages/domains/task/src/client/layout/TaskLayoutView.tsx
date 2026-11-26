import { Fragment } from 'react'
import type { PanelSizes, TaskLayout } from '@slayzone/task-contracts'
import { ResizeHandle } from '../ResizeHandle'
import { applyBoundaryResize, minWidthFor, unstretchPx } from '../usePanelSizes'
import { LayoutColumn } from './LayoutColumn'
import { PanelInstanceView } from './TabGroup'
import { compactColumns, domOrderedColumns, type LayoutStrip } from './strip'

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
  onActivateTab?: (instanceId: string) => void
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
  onActivateTab
}: TaskLayoutViewProps): React.JSX.Element {
  const { resolved, plan, layouts } = strip
  const compactAgent = compact ? compactColumns(layout) : null

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

      {compact && compactAgent === null && (
        // No agent in the layout (a disabled, hidden agent): the cell still shows it.
        <PanelInstanceView instance={{ id: 'terminal', kind: 'agent', settings: {} }} />
      )}
      {(compact ? (compactAgent ?? []) : domOrderedColumns(layout, strip.columns, webPanelIds)).map(
        (column) => (
          <Fragment key={column.id}>
            {renderHandle(column.id)}
            <LayoutColumn
              layout={layout}
              column={column}
              width={resolved.widths[column.id]}
              order={plan.order[column.id] ?? 0}
              onActivateTab={onActivateTab}
            />
          </Fragment>
        )
      )}
    </>
  )
}
