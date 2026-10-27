import { createContext, useContext, useMemo, type ReactNode } from 'react'

/**
 * DOM slots a context-manager shell lends to the section it renders, for
 * `createPortal`:
 *  - `headerActions` — the shell header's action area (every shell);
 *  - `editorPanel` / `resizeHandle` — the skill editor side panel and its drag
 *    handle (ContextManagerShell only).
 *
 * Each shell provides its OWN elements, so a section always portals into the shell
 * that renders it — also when two shells are mounted at once (the Context Manager
 * page behind the project settings dialog's AI-config tab). A shell stores each
 * element via a callback ref (`ref={setHeaderActions}` on a `useState` setter), so a
 * section receives it as a value right after the shell commits it; nobody looks the
 * element up in the DOM. `null` = not mounted yet, or no such slot in this shell.
 */
export interface ContextManagerSlots {
  headerActions: HTMLElement | null
  editorPanel: HTMLElement | null
  resizeHandle: HTMLElement | null
}

const NO_SLOTS: ContextManagerSlots = { headerActions: null, editorPanel: null, resizeHandle: null }

const ContextManagerSlotsContext = createContext<ContextManagerSlots>(NO_SLOTS)

export function ContextManagerSlotsProvider({
  headerActions = null,
  editorPanel = null,
  resizeHandle = null,
  children
}: Partial<ContextManagerSlots> & { children: ReactNode }) {
  const slots = useMemo(
    () => ({ headerActions, editorPanel, resizeHandle }),
    [headerActions, editorPanel, resizeHandle]
  )
  return <ContextManagerSlotsContext value={slots}>{children}</ContextManagerSlotsContext>
}

/** The slots of the shell this section is rendered in (all null outside a shell). */
export function useContextManagerSlots(): ContextManagerSlots {
  return useContext(ContextManagerSlotsContext)
}
