// Shell entry. Install the window.api shim BEFORE the renderer module graph
// evaluates, then mount.
//
// The renderer-app is loaded via a *dynamic* import so @slayzone/settings'
// module-eval read of `window.api` happens after the assignment below — static
// ESM would hoist the renderer graph (and its window.api reads) above it. The
// Home-view slice imports @slayzone/settings (ThemeProvider) + @slayzone/tasks,
// which is exactly the settings-coupling the prior stub note warned about, so
// the dynamic import is now required. Trade-off: a dynamic-import continuation
// does not run before headless --screenshot/--dump-dom (virtual-time quirk) —
// verify paint in a real window, not a headless probe.
import './main.css'
import { setNativeOverlay, setupWindowApi } from '@slayzone/window-api-shim'

;(window as unknown as { api: ReturnType<typeof setupWindowApi> }).api = setupWindowApi()

// cap-layout-p4 — native overlay control for the renderer. Feature-detected by
// renderer-app (absent under electron → DOM-portal dialogs). show('dialog')
// raises the shell-rendered dialog surface above the live embedded tab;
// close() clears it.
;(window as unknown as { __slayzoneNativeOverlay?: unknown }).__slayzoneNativeOverlay = {
  show: (id: string) => setNativeOverlay(id),
  close: () => setNativeOverlay('')
}

void import('@slayzone/renderer-app').then(({ mountApp }) => mountApp())
