import './assets/main.css'

import { createRoot } from 'react-dom/client'
import { ThemeProvider, tabStoreReady, useTabStore } from '@slayzone/settings'
import { PtyProvider } from '@slayzone/terminal'
import { TelemetryProvider } from '@slayzone/telemetry/client'
import { TrpcProvider, initTrpcClient } from '@slayzone/transport/client'
import { UndoProvider } from '@slayzone/ui'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import App from './App'
import { FloatingGlobalAgentPanel } from './components/global-agent-panel/FloatingGlobalAgentPanel'
import { SecondaryTaskWindow } from './components/SecondaryTaskWindow'
import { getDiagnosticsContext } from './lib/diagnosticsClient'
import { ConvexAuthBootstrap } from './lib/convexAuth'
import { MaybeProfiler } from './lib/perfProfiler'

const params = new URLSearchParams(window.location.search)
const isFloatingGlobalAgentPanel = params.get('floating') === 'global-agent-panel'
const taskWindowId = params.get('taskWindow')

window.addEventListener('error', (event) => {
  window.api.diagnostics.recordClientError({
    type: 'window.error',
    message: event.message || 'Unknown window error',
    stack: event.error?.stack ?? null,
    url: event.filename ?? null,
    line: event.lineno ?? null,
    column: event.colno ?? null,
    snapshot: getDiagnosticsContext()
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection')
  const stack = reason instanceof Error ? reason.stack : null
  window.api.diagnostics.recordClientError({
    type: 'window.unhandledrejection',
    message,
    stack,
    snapshot: getDiagnosticsContext()
  })
})

// Floating global agent panel: minimal renderer — skip tab store, telemetry, convex, etc.
// Still needs TrpcProvider: ThemeProvider (and PtyProvider) now talk tRPC.
if (isFloatingGlobalAgentPanel) {
  Promise.all([window.api.app.getTrpcPort(), window.api.panels.getWindowId()]).then(
    ([trpcPort, windowId]) => {
      createRoot(document.getElementById('root')!).render(
        <TrpcProvider url={`ws://127.0.0.1:${trpcPort}/trpc?windowId=${windowId}`}>
          <PtyProvider>
            <ThemeProvider>
              <FloatingGlobalAgentPanel />
            </ThemeProvider>
          </PtyProvider>
        </TrpcProvider>
      )
    }
  )
} else if (taskWindowId) {
  // Secondary task window: full TaskDetailPage scoped to one task. No tab store / sidebar.
  Promise.all([window.api.app.getTrpcPort(), window.api.panels.getWindowId()]).then(
    ([trpcPort, windowId]) => {
      createRoot(document.getElementById('root')!).render(
        <TrpcProvider url={`ws://127.0.0.1:${trpcPort}/trpc?windowId=${windowId}`}>
          <PtyProvider>
            <ThemeProvider>
              <UndoProvider>
                <SecondaryTaskWindow taskId={taskWindowId} />
              </UndoProvider>
            </ThemeProvider>
          </PtyProvider>
        </TrpcProvider>
      )
    }
  )
} else {
  window.api.app.bootMark?.('renderer script entered')
  // Wait for tab store + tRPC port discovery before rendering. Tab store
  // hydrates from SQLite (prevents effect race wiping persisted tabs); tRPC
  // port is needed to construct the WS URL passed to TrpcProvider.
  Promise.all([
    tabStoreReady,
    window.api.app.getTrpcPort(),
    window.api.panels.getWindowId()
  ]).then(([, trpcPort, windowId]) => {
    window.api.app.bootMark?.('tabStoreReady resolved')

    // windowId in the WS query → server ctx.windowId (= webContents.id). Required
    // by claimSession + panel-ownership procs; without it they throw "windowId required".
    const trpcUrl = `ws://127.0.0.1:${trpcPort}/trpc?windowId=${windowId}`
    // Initialize the tRPC client singleton NOW (before prefetch / React mount) so
    // module-scope callers — incl. taskDetailCache.prefetch below and getTrpcClient()
    // in stores — work. TrpcProvider reuses this same client (one WS connection).
    initTrpcClient(trpcUrl)

    // Prefetch task details for open tabs — warms Suspense cache before React mounts.
    // Fire-and-forget: the cache's resolved-value tracking + notify ensures immediate
    // re-render when data arrives, eliminating the 250ms use() scheduling delay.
    for (const tab of useTabStore.getState().tabs) {
      if (tab.type === 'task') taskDetailCache.prefetch('taskDetail', tab.taskId)
    }

    // E2E: expose the vanilla tRPC client so specs can call
    // page.evaluate(() => window.getTrpcVanillaClient().task.getAll.query()).
    if (window.api.app.isPlaywright) {
      ;(
        window as typeof window & {
          getTrpcVanillaClient?: () => ReturnType<typeof initTrpcClient>['client']
        }
      ).getTrpcVanillaClient = () => initTrpcClient(trpcUrl).client
    }
    performance.mark('sz:reactMount')
    window.api.app.bootMark?.('reactMount')
    createRoot(document.getElementById('root')!).render(
      // TrpcProvider must be OUTERMOST: ConvexAuthBootstrap (and Pty/Theme/
      // Telemetry providers) now call tRPC hooks, so they need the tRPC context.
      <TrpcProvider url={trpcUrl}>
        <ConvexAuthBootstrap>
          <PtyProvider>
            <ThemeProvider>
              <TelemetryProvider>
                <UndoProvider>
                  <MaybeProfiler>
                    <App />
                  </MaybeProfiler>
                </UndoProvider>
              </TelemetryProvider>
            </ThemeProvider>
          </PtyProvider>
        </ConvexAuthBootstrap>
      </TrpcProvider>
    )
  })
}
