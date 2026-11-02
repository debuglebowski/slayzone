import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * An answer's footer is a sticky button row (Activities, Files, Threads, Message
 * details). What those buttons expand must not stick with it — a tall list pinned
 * to the scroller's bottom would cover the answer. So inside an answer footer the
 * expanded parts render into a non-sticky slot below the row.
 *
 * `undefined` = no answer footer: render inline. `{ slot: null }` = footer whose
 * slot is not mounted yet: render nothing for that one commit.
 */
const AnswerFooterPanelContext = createContext<{ slot: HTMLElement | null } | undefined>(undefined)

export const AnswerFooterPanelProvider = AnswerFooterPanelContext.Provider

export function AnswerFooterPanel({ children }: { children: ReactNode }) {
  const target = useContext(AnswerFooterPanelContext)
  if (!target) return children
  if (!target.slot) return null
  // Panels nested in a panel (e.g. recorded edits inside workspace changes) stay inline.
  return createPortal(
    <AnswerFooterPanelContext.Provider value={undefined}>
      {children}
    </AnswerFooterPanelContext.Provider>,
    target.slot
  )
}
