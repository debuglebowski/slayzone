import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskDetailsView } from './TaskDetailsView'
import { OverlayDialogApp } from './OverlayDialogApp'

// window.api shim is installed by the shell before this module evaluates
// (see @slayzone/chromium-shell src/main.tsx), so feature code imported here
// can read window.api safely.
//
// cap-layout-p4 — overlay-dialog mode: when SlayzoneOverlayManager loads this
// bundle into the transparent native overlay surface (#overlay=dialog), mount
// ONLY the dialog app. Critically, this instance must never bind the layout
// store / embedded-tab host (the dual-shell-instance contention class).
// Fragment (not query): the shell's chrome:// data source serves the bundle
// for the root path only — a query string yields an empty document.
export function mountApp(): void {
  const el = document.getElementById('root')
  if (!el) throw new Error('[renderer-app] #root element not found')
  const overlayMode = typeof window !== 'undefined' && window.location.hash === '#overlay=dialog'
  createRoot(el).render(
    <StrictMode>{overlayMode ? <OverlayDialogApp /> : <TaskDetailsView />}</StrictMode>
  )
}
