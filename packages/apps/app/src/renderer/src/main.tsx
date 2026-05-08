import './assets/main.css'

import { createRoot } from 'react-dom/client'
import { ThemeProvider, tabStoreReady, useTabStore } from '@slayzone/settings'
import { PtyProvider } from '@slayzone/terminal'
import { TelemetryProvider } from '@slayzone/telemetry/client'
import { TrpcProvider, tryGetTrpcVanillaClient } from '@slayzone/transport/client'
import { UndoProvider } from '@slayzone/ui'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import App from './App'
import { FloatingAgentPanel } from './components/agent-panel/FloatingAgentPanel'
import { RemoteConfigScreen } from './components/RemoteConfigScreen'
import { SecondaryTaskWindow } from './components/SecondaryTaskWindow'
import { getDiagnosticsContext } from './lib/diagnosticsClient'
import { ConvexAuthBootstrap } from './lib/convexAuth'
import { MaybeProfiler } from './lib/perfProfiler'

const params = new URLSearchParams(window.location.search)
const isFloatingAgent = params.get('floating') === 'agent'
const taskWindowId = params.get('taskWindow')

window.addEventListener('error', (event) => {
  // tRPC may not be initialized for very-early errors (before TrpcProvider mounts).
  // Diagnostics is best-effort — drop if not ready.
  tryGetTrpcVanillaClient()?.diagnostics.recordClientError.mutate({
    type: 'window.error',
    message: event.message || 'Unknown window error',
    stack: event.error?.stack ?? null,
    url: event.filename ?? null,
    line: event.lineno ?? null,
    column: event.colno ?? null,
    snapshot: getDiagnosticsContext()
  }).catch(() => {})
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection')
  const stack = reason instanceof Error ? reason.stack : null
  tryGetTrpcVanillaClient()?.diagnostics.recordClientError.mutate({
    type: 'window.unhandledrejection',
    message,
    stack,
    snapshot: getDiagnosticsContext()
  }).catch(() => {})
})

// Floating agent panel: minimal renderer — skip tab store, telemetry, convex, etc.
if (isFloatingAgent) {
  createRoot(document.getElementById('root')!).render(
    <PtyProvider>
      <ThemeProvider>
        <FloatingAgentPanel />
      </ThemeProvider>
    </PtyProvider>
  )
} else if (taskWindowId) {
  // Secondary task window: full TaskDetailPage scoped to one task. No tab store / sidebar.
  createRoot(document.getElementById('root')!).render(
    <PtyProvider>
      <ThemeProvider>
        <UndoProvider>
          <SecondaryTaskWindow taskId={taskWindowId} />
        </UndoProvider>
      </ThemeProvider>
    </PtyProvider>
  )
} else {
  window.api.app.bootMark?.('renderer script entered')
  // Wait for tab store + server URL discovery before rendering. Tab store
  // hydrates from SQLite (prevents effect race wiping persisted tabs); server
  // URL drives the TrpcProvider WS connection (local: embedded port; remote:
  // user-configured URL).
  Promise.all([tabStoreReady, window.api.app.getServerUrl()]).then(([, server]) => {
    window.api.app.bootMark?.('tabStoreReady resolved')

    // Remote mode with no/empty URL → render config-recovery screen instead
    // of mounting TrpcProvider against a broken URL (would WS-loop forever).
    if (server.mode === 'remote' && !server.url) {
      createRoot(document.getElementById('root')!).render(
        <RemoteConfigScreen initialUrl="" />
      )
      return
    }

    // Prefetch task details for open tabs — warms Suspense cache before React mounts.
    // Fire-and-forget: the cache's resolved-value tracking + notify ensures immediate
    // re-render when data arrives, eliminating the 250ms use() scheduling delay.
    for (const tab of useTabStore.getState().tabs) {
      if (tab.type === 'task') taskDetailCache.prefetch('taskDetail', tab.taskId)
    }

    // Pass per-window id so server can scope panel ownership + primary-active
    // state. windowId is generated once per preload load (stable per window).
    const wid = window.api.app.windowId ?? ''
    const trpcUrl = wid
      ? `${server.url}${server.url.includes('?') ? '&' : '?'}windowId=${wid}`
      : server.url
    performance.mark('sz:reactMount')
    window.api.app.bootMark?.('reactMount')
    createRoot(document.getElementById('root')!).render(
      <ConvexAuthBootstrap>
        <TrpcProvider url={trpcUrl}>
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
        </TrpcProvider>
      </ConvexAuthBootstrap>
    )
  })
}
