import { createRoot } from 'react-dom/client'
import {
  TrpcProvider,
  electronBootstrap,
  initTrpcClient
} from '@slayzone/transport/client'
import { ThemeProvider, AppearanceProvider } from '@slayzone/settings'
import { PtyProvider } from '@slayzone/terminal'
import { TelemetryProvider } from '@slayzone/telemetry/client'
import { TooltipProvider, UndoProvider } from '@slayzone/ui'
import { ConvexAuthBootstrap } from '@slayzone/leaderboard'
import { browserMojoLink } from './browser-mojo-link'
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
    createRoot(el).render(
      <TooltipProvider delayDuration={0}>
        <OverlayDialogApp />
      </TooltipProvider>
    )
    return
  }
  // Layout/browser-panel skeleton demo, kept reachable for development.
  if (hash === '#task-demo') {
    createRoot(el).render(
      <TooltipProvider delayDuration={0}>
        <TaskDetailsView />
      </TooltipProvider>
    )
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
  // Resolve the browser panel's `app.browser.*` ops against the native mojo host
  // (window.api.browser) instead of the standalone sidecar, which stubs them.
  // FIRST initTrpcClient call wins the link stack; TrpcProvider reuses the singleton.
  initTrpcClient(trpcUrl, { links: [browserMojoLink()] })

  // Provider stack mirrors the Electron renderer (packages/apps/app/src/renderer/
  // src/main.tsx): TrpcProvider OUTERMOST (Pty/Appearance/Telemetry providers call
  // tRPC hooks), then ConvexAuthBootstrap (Convex + GitHub OAuth — needs the tRPC
  // context), then PtyProvider (TaskDetailPage's usePty/useLoopMode/useSlayNudge
  // throw without it), ThemeProvider, AppearanceProvider (useAppearance), and
  // TelemetryProvider (track() — no-ops with no analytics backend configured).
  // settingsRevision is a constant in the fork (no live settings-dialog revision).
  //
  // oauthDelivery="subscription": the fork can't catch the slayzone:// callback in
  // the renderer (it routes to the C++ shell → sidecar). ConvexAuthBootstrap opens
  // the browser via the sidecar and completes the code over app.auth.onCallback.
  // When VITE_CONVEX_URL is unset the bootstrap degrades to LEADERBOARD_AUTH_DISABLED.
  createRoot(el).render(
    <TrpcProvider url={trpcUrl}>
      <ConvexAuthBootstrap oauthDelivery="subscription">
        <PtyProvider>
          <ThemeProvider>
            <AppearanceProvider settingsRevision={0}>
              <TelemetryProvider>
                <UndoProvider>
                  <TooltipProvider delayDuration={0}>
                    <HomeView />
                  </TooltipProvider>
                </UndoProvider>
              </TelemetryProvider>
            </AppearanceProvider>
          </ThemeProvider>
        </PtyProvider>
      </ConvexAuthBootstrap>
    </TrpcProvider>
  )
}
