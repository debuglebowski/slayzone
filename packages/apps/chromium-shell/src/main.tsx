// Shell entry. Install the window.api shim BEFORE the renderer module graph
// evaluates, then mount.
//
// The real renderer-app requires a *dynamic* import so that @slayzone/settings'
// module-eval read of `window.api` happens after the assignment below (static
// ESM would hoist the renderer graph above it). The current renderer-app is a
// stub with no such coupling, so a static import + synchronous mount is used —
// which is correct here and also avoids a headless virtual-time quirk where a
// dynamic import() continuation does not run before --screenshot/--dump-dom.
// Restore the dynamic import (see main.tsx history) when settings-coupled
// features are imported into renderer-app.
import { setupWindowApi } from '@slayzone/window-api-shim'
import { mountApp } from '@slayzone/renderer-app'

;(window as unknown as { api: ReturnType<typeof setupWindowApi> }).api = setupWindowApi()

mountApp()
