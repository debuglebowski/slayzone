import { createRoot } from 'react-dom/client'
import {
  TrpcProvider,
  electronBootstrap,
  initTrpcClient
} from '@slayzone/transport/client'
import { ThemeProvider } from '@slayzone/settings'
import { HomeView } from './HomeView'
import { TaskDetailsView } from './TaskDetailsView'
import { OverlayDialogApp } from './OverlayDialogApp'

// window.api shim is installed by the shell before this module evaluates
// (see @slayzone/chromium-shell src/main.tsx), so feature code imported here
// can read window.api safely.

// windowId in the WS query → server ctx.windowId. The fork is single-window so
// getWindowId returns a constant; kept in the URL for parity with the server's
// per-connection contract. Mirrors the app renderer's withWindowId helper.
function withWindowId(serverUrl: string, windowId: number | null | undefined): string {
  if (windowId == null) return serverUrl
  return `${serverUrl}${serverUrl.includes('?') ? '&' : '?'}windowId=${windowId}`
}

// Contract consumed by @slayzone/chromium-shell: a no-arg `mountApp()`.
export async function mountApp(): Promise<void> {
  const el = document.getElementById('root')
  if (!el) throw new Error('[renderer-app] #root element not found')
  const hash = typeof window !== 'undefined' ? window.location.hash : ''

  // cap-layout-p4 — overlay-dialog mode: SlayzoneOverlayManager loads this bundle
  // into the transparent native overlay surface. Mount ONLY the dialog app; never
  // bind tRPC / data here (dual-shell-instance contention).
  if (hash === '#overlay=dialog') {
    createRoot(el).render(<OverlayDialogApp />)
    return
  }
  // Layout/browser-panel skeleton demo, kept reachable for development.
  if (hash === '#task-demo') {
    createRoot(el).render(<TaskDetailsView />)
    return
  }

  // Home view — connects to the sidecar over tRPC-WS. Resolve the server URL
  // (baked-in default port unless overridden) + windowId before mounting so the
  // tRPC client singleton exists for module-scope callers (zustand stores) too.
  const [server, windowId] = await Promise.all([
    electronBootstrap.getServerUrl(),
    electronBootstrap.getWindowId()
  ])
  const trpcUrl = withWindowId(server.url, windowId)
  initTrpcClient(trpcUrl)

  createRoot(el).render(
    <TrpcProvider url={trpcUrl}>
      <ThemeProvider>
        <HomeView />
      </ThemeProvider>
    </TrpcProvider>
  )
}
