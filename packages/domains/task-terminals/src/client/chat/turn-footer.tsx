import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@slayzone/ui'

/**
 * A turn's footer: its button row (Activities, Files, Threads, Message details)
 * under a finished answer, or under a running turn's progress. The row stays in
 * view while any of its block is on screen — pinned to the scroller's bottom
 * while content above it scrolls past, to its top while the panels below it do.
 *
 * What the buttons expand must not stick with the row (a tall list pinned to an
 * edge would cover the chat), so inside a footer each expanded part renders
 * through `TurnFooterPanel` into a non-sticky slot below the row.
 *
 * A sticky box only travels within its parent: render the footer as a direct
 * child of the block it should follow through.
 *
 * The slot carries the row's height as `--turn-footer-row-height`, so a header
 * inside a panel (the live "Message" preview) can stick right under the row.
 */
export function TurnFooter({
  className,
  panelsClassName,
  testId,
  children
}: {
  className?: string
  panelsClassName?: string
  testId?: string
  children: ReactNode
}) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const panels = useMemo(() => ({ slot }), [slot])
  const [row, setRow] = useState<HTMLDivElement | null>(null)
  const [rowHeight, setRowHeight] = useState(0)
  useEffect(() => {
    if (!row || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setRowHeight(row.offsetHeight))
    observer.observe(row)
    return () => observer.disconnect()
  }, [row])
  return (
    <TurnFooterPanelContext.Provider value={panels}>
      <div
        ref={setRow}
        className={cn(
          // Opaque so content scrolls under it; ::before re-applies the turn
          // block's hover/focus tint (turnBlockClass).
          'sticky top-0 bottom-0 z-[5] flex min-w-0 flex-wrap bg-background empty:hidden',
          'before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:transition-colors group-hover/turn:before:bg-muted/50 group-focus-within/turn:before:bg-muted/50',
          className
        )}
        data-testid={testId}
      >
        {children}
      </div>
      <div
        ref={setSlot}
        className={cn('flex min-w-0 flex-wrap empty:hidden', panelsClassName)}
        style={{ '--turn-footer-row-height': `${rowHeight}px` } as CSSProperties}
        data-testid={testId && `${testId}-panels`}
      />
    </TurnFooterPanelContext.Provider>
  )
}

/**
 * `undefined` = not in a footer: render inline. `{ slot: null }` = footer whose
 * slot is not mounted yet: render nothing for that one commit.
 */
const TurnFooterPanelContext = createContext<{ slot: HTMLElement | null } | undefined>(undefined)

/** An expanded part of a footer button: below the footer's row when in one, else inline. */
export function TurnFooterPanel({ children }: { children: ReactNode }) {
  const target = useContext(TurnFooterPanelContext)
  if (!target) return children
  if (!target.slot) return null
  // Panels nested in a panel (e.g. recorded edits inside workspace changes) stay inline.
  return createPortal(
    <TurnFooterPanelContext.Provider value={undefined}>{children}</TurnFooterPanelContext.Provider>,
    target.slot
  )
}
