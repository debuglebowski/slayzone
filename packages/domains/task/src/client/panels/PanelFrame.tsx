import { Activity, Suspense, createContext, use } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@slayzone/ui'
import { PanelOwnerStub } from '../PanelOwnerStub'
import { PanelLoadingSkeleton } from '../PanelLoadingSkeleton'
import { PANEL_KINDS, type PanelKind } from './registry'
import { useTaskPageContext } from './TaskPageContext'

/**
 * True inside a layout cell — a group stacked in a column with others, or a tab
 * group with a strip: the frame fills its cell instead of taking the width and
 * flex order the strip resolved for the column named like the panel.
 */
export const PanelCellContext = createContext(false)

/**
 * True when the panel's group shows a tab strip: its tab carries the kind's
 * accessory (an agent's provider picker), so the panel's own header leaves it out.
 */
export const PanelStripContext = createContext(false)

const FOCUS_GLOW = 'shadow-[0_0_18px_rgba(255,255,255,0.25)]'

interface PanelFrameProps {
  kind: PanelKind
  panelId: string
  /** Owner-stub label; defaults to the kind's (a web panel passes its own name). */
  label?: string
  /** The kind's body layout (overflow, flex, padding) on top of the shared chrome. */
  className?: string
  /** Rounded border + surface + focus glow. Off for the compact agent pane. */
  chrome?: boolean
  /** Width + flex order; defaults to the strip's resolved width and order for `panelId`. */
  style?: CSSProperties
  testId?: string
  /** Shown instead of everything else (the agent pane of a task you may only view). */
  replacement?: ReactNode
  /** Inside the Suspense boundary but outside <Activity> (dialogs the panel opens). */
  suspendedSiblings?: ReactNode
  children: ReactNode
}

/**
 * The frame every task panel renders in: the bordered surface, the focus glow, the
 * `data-panel-id` the focus tracker and e2e read, the stub shown while another
 * window owns the panel, and the kind's Suspense and keep-alive wrappers
 * (PANEL_KINDS[kind].suspense / .keepAlive).
 */
export function PanelFrame({
  kind,
  panelId,
  label,
  className,
  chrome = true,
  style,
  testId,
  replacement,
  suspendedSiblings,
  children
}: PanelFrameProps): React.JSX.Element {
  const { isActive, panels } = useTaskPageContext()
  const { ownership, focusedPanel, multipleVisiblePanels, resolvedWidths, panelOrderIdx } = panels
  const def = PANEL_KINDS[kind]
  const inCell = use(PanelCellContext)

  let body: ReactNode = children
  if (def.keepAlive === 'activity') {
    body = <Activity mode={isActive ? 'visible' : 'hidden'}>{body}</Activity>
  }
  if (def.suspense) {
    body = (
      <Suspense fallback={<PanelLoadingSkeleton />}>
        {body}
        {suspendedSiblings}
      </Suspense>
    )
  } else if (suspendedSiblings) {
    body = (
      <>
        {body}
        {suspendedSiblings}
      </>
    )
  }

  return (
    <div
      data-panel-id={panelId}
      data-testid={testId}
      className={cn(
        'shrink-0 transition-shadow duration-200',
        chrome && 'rounded-md bg-surface-1 border border-border',
        inCell && 'flex-1 min-w-0 min-h-0',
        className,
        chrome && multipleVisiblePanels && focusedPanel === panelId && FOCUS_GLOW
      )}
      style={
        inCell
          ? undefined
          : (style ?? { width: resolvedWidths[panelId], order: panelOrderIdx[panelId] ?? 0 })
      }
    >
      {replacement ??
        (ownership.hasOtherOwner(panelId) ? (
          <PanelOwnerStub
            panelLabel={label ?? def.label}
            icon={def.icon}
            activeElsewhere
            onActivate={() => ownership.claim(panelId)}
            onActivateAndClose={() => ownership.claimAndCloseOther(panelId)}
          />
        ) : (
          body
        ))}
    </div>
  )
}
