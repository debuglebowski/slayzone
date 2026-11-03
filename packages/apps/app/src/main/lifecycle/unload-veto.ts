/**
 * No page in this app can veto its own unload.
 *
 * A `beforeunload` handler that cancels (`preventDefault()` / `returnValue`) asks the
 * browser for a "leave this page?" dialog. Electron has no such dialog: unless the
 * `will-prevent-unload` event is overridden, the veto silently wins. For a window's
 * close that means the window stays open, and when the close was part of an app quit
 * Electron cancels the whole quit — `will-quit` never fires and only the quit watchdog
 * ends the process (exit 1, an unclean shutdown on the next boot).
 *
 * The app's own windows hit this through the Convex client, whose default handler
 * vetoes while one of its requests has no reply (packaged pilot 2026-11-03: every
 * normal quit hit the watchdog). Third-party pages in browser tabs and extension
 * popups can do the same. Nothing here can show the user that choice, so every
 * webContents ignores the veto — the behavior browser tabs already had.
 */

/** The slice of Electron's WebContents this needs (a test double satisfies it). */
export type UnloadVetoContents = {
  getType: () => string
  on: (
    event: 'will-prevent-unload',
    listener: (event: { preventDefault: () => void }) => void
  ) => unknown
}

export type UnloadVetoOverride = {
  /** The webContents' Electron type and whether an app quit was under way. No URL. */
  contentsType: string
  duringQuit: boolean
}

export function overrideUnloadVetoes(
  contents: UnloadVetoContents,
  deps: {
    isQuitting: () => boolean
    /** Diagnostics; must not be able to keep the veto in force. */
    record: (override: UnloadVetoOverride) => void
  }
): void {
  contents.on('will-prevent-unload', (event) => {
    event.preventDefault()
    try {
      deps.record({ contentsType: contents.getType(), duringQuit: deps.isQuitting() })
    } catch {
      // Diagnostics never escalate; the unload already proceeds.
    }
  })
}
