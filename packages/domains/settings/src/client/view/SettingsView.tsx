import { useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { closeSettings, useSettingsViewStore } from '../settings-view-store'
import { SettingsNav } from './SettingsNav'
import { SettingsPage, type SettingsPagesProps } from './SettingsPages'

/**
 * A Radix dialog, menu, select or popover is open: Esc belongs to it, not to the
 * view. A tooltip (also a popper) does not count — it must not swallow the key.
 */
function overlayOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], ' +
      '[data-radix-popper-content-wrapper]:has([role="menu"], [role="listbox"], [role="dialog"])'
  )
}

/**
 * The full-window Settings view (plans/settings-by-scope.md). Covers the sidebar and
 * the tab bar; the app underneath stays mounted (terminals and chats keep running).
 * Mounted by each shell inside a `relative` container while the store says open;
 * the shell also installs `installSettingsEventBridge` (always, so events open it).
 * Esc or "Back to app" closes.
 */
export function SettingsView(pageProps: SettingsPagesProps) {
  const open = useSettingsViewStore((s) => s.open)
  const route = useSettingsViewStore((s) => s.route)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Like the dialog it replaces: Esc closes from anywhere, a focused field
      // included, unless an OPEN dialog/menu/popover owns the key. Decided from the
      // DOM in the capture phase, before Radix's own (document) listener runs: a
      // dialog that just closed stays mounted while it animates out and still
      // `preventDefault`s Esc, which must not keep Settings open.
      if (e.key !== 'Escape' || overlayOpen()) return
      closeSettings()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open])

  if (!open) return null
  return (
    <div
      role="region"
      aria-label="Settings"
      data-testid="settings-view"
      className="absolute inset-0 z-30 flex bg-background text-foreground"
    >
      <aside className="flex w-72 shrink-0 flex-col bg-sidebar">
        {/* Clears the window's traffic lights and keeps the strip draggable. */}
        <div className="window-drag-region h-11 shrink-0" />
        <div className="px-3">
          <button
            type="button"
            onClick={closeSettings}
            data-testid="settings-back"
            className="window-no-drag flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to app
            <kbd className="ml-auto rounded border px-1.5 text-[10px] text-muted-foreground">
              esc
            </kbd>
          </button>
        </div>
        <SettingsNav />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="window-drag-region h-11" />
        <div className="mx-auto w-full max-w-4xl space-y-8 px-10 pb-12">
          <SettingsPage key={JSON.stringify(route)} route={route} {...pageProps} />
        </div>
      </main>
    </div>
  )
}
