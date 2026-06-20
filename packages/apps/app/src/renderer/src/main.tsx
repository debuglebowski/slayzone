import './assets/main.css'

import { createRoot } from 'react-dom/client'
import { ThemeProvider, loadTabStoreState, useTabStore } from '@slayzone/settings'
import { PtyProvider } from '@slayzone/terminal'
import { TelemetryProvider } from '@slayzone/telemetry/client'
import {
  TrpcProvider,
  electronBootstrap,
  getTrpcClient,
  initTrpcClient
} from '@slayzone/transport/client'
import { setShortcutBackend, TooltipProvider, UndoProvider } from '@slayzone/ui'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import App from './App'
import { FloatingGlobalAgentPanel } from '@slayzone/agent-panels'
import { RemoteConfigScreen } from './components/RemoteConfigScreen'
import { SecondaryTaskWindow } from './components/SecondaryTaskWindow'
import { getDiagnosticsContext, recordClientError } from './lib/diagnosticsClient'
import { ConvexAuthBootstrap } from './lib/convexAuth'
import { MaybeProfiler } from './lib/perfProfiler'

const params = new URLSearchParams(window.location.search)
const isFloatingGlobalAgentPanel = params.get('floating') === 'global-agent-panel'
const taskWindowId = params.get('taskWindow')

// windowId in the WS query → server ctx.windowId (= webContents.id). Required
// by claimSession + panel-ownership procs; without it they throw "windowId
// required". The base URL comes from getServerUrl (local: embedded port;
// remote: user-configured — which may already carry a query).
function withWindowId(serverUrl: string, windowId: number | null | undefined): string {
  if (windowId == null) return serverUrl
  return `${serverUrl}${serverUrl.includes('?') ? '&' : '?'}windowId=${windowId}`
}

window.addEventListener('error', (event) => {
  recordClientError({
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
  recordClientError({
    type: 'window.unhandledrejection',
    message,
    stack,
    snapshot: getDiagnosticsContext()
  })
})

// Floating global agent panel: minimal renderer — skip tab store, telemetry, convex, etc.
// Still needs TrpcProvider: ThemeProvider (and PtyProvider) now talk tRPC.
if (isFloatingGlobalAgentPanel) {
  Promise.all([electronBootstrap.getServerUrl(), electronBootstrap.getWindowId()]).then(
    ([server, windowId]) => {
      createRoot(document.getElementById('root')!).render(
        <TrpcProvider url={withWindowId(server.url, windowId)}>
          <PtyProvider>
            <ThemeProvider>
              <TooltipProvider delayDuration={0}>
                <FloatingGlobalAgentPanel />
              </TooltipProvider>
            </ThemeProvider>
          </PtyProvider>
        </TrpcProvider>
      )
    }
  )
} else if (taskWindowId) {
  // Secondary task window: full TaskDetailPage scoped to one task. No tab store / sidebar.
  // No RemoteConfigScreen fallback here — secondary windows can only be opened
  // from a main window that already has a working server connection.
  Promise.all([electronBootstrap.getServerUrl(), electronBootstrap.getWindowId()]).then(
    ([server, windowId]) => {
      createRoot(document.getElementById('root')!).render(
        <TrpcProvider url={withWindowId(server.url, windowId)}>
          <PtyProvider>
            <ThemeProvider>
              <UndoProvider>
                <TooltipProvider delayDuration={0}>
                  <SecondaryTaskWindow taskId={taskWindowId} />
                </TooltipProvider>
              </UndoProvider>
            </ThemeProvider>
          </PtyProvider>
        </TrpcProvider>
      )
    }
  )
} else {
  electronBootstrap.bootMark('renderer script entered')
  // Wait for tab store + server URL discovery before rendering. Tab store
  // hydrates from SQLite (prevents effect race wiping persisted tabs); the
  // server URL (local: embedded port; remote: configured host) is needed to
  // construct the WS URL passed to TrpcProvider.
  Promise.all([electronBootstrap.getServerUrl(), electronBootstrap.getWindowId()]).then(async ([server, windowId]) => {

    // Remote mode with a missing/unreachable server → render the recovery
    // screen instead of mounting TrpcProvider against a dead URL (it would
    // WS-reconnect-loop forever behind a blank window). Probe runs main-side.
    if (server.mode === 'remote') {
      const reachable = server.url
        ? (await electronBootstrap.probeServerHealth(server.url)).ok
        : false
      if (!reachable) {
        createRoot(document.getElementById('root')!).render(
          <RemoteConfigScreen initialUrl={server.url} />
        )
        return
      }
    }

    const trpcUrl = withWindowId(server.url, windowId)
    // Initialize the tRPC client singleton NOW (before prefetch / React mount) so
    // module-scope callers — incl. taskDetailCache.prefetch below and getTrpcClient()
    // in stores — work. TrpcProvider reuses this same client (one WS connection).
    initTrpcClient(trpcUrl)
    // Wire the shortcut store's persistence to tRPC (was the preload
    // global). @slayzone/ui has no transport dependency, so the host injects the
    // backend. Closures are lazy — they call getTrpcClient() only when invoked,
    // which is always after the init above.
    setShortcutBackend({
      get: (key) => getTrpcClient().settings.get.query({ key }),
      set: async (key, value) => {
        await getTrpcClient().settings.set.mutate({ key, value })
      },
      notifyChanged: () => {
        void getTrpcClient().app.shortcuts.changed.mutate()
      }
    })
    await loadTabStoreState()
    electronBootstrap.bootMark('tabStoreReady resolved')

    // Prefetch task details for open tabs — warms Suspense cache before React mounts.
    // Fire-and-forget: the cache's resolved-value tracking + notify ensures immediate
    // re-render when data arrives, eliminating the 250ms use() scheduling delay.
    for (const tab of useTabStore.getState().tabs) {
      if (tab.type === 'task') taskDetailCache.prefetch('taskDetail', tab.taskId)
    }

    // E2E: expose the vanilla tRPC client so specs can call
    // page.evaluate(() => window.getTrpcVanillaClient().task.getAll.query()).
    if (electronBootstrap.isPlaywright()) {
      ;(
        window as typeof window & {
          getTrpcVanillaClient?: () => ReturnType<typeof initTrpcClient>['client']
        }
      ).getTrpcVanillaClient = () => initTrpcClient(trpcUrl).client
    }
    performance.mark('sz:reactMount')
    electronBootstrap.bootMark('reactMount')
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
                    <TooltipProvider delayDuration={0}>
                      <App />
                    </TooltipProvider>
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
