import './assets/main.css'

import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@slayzone/settings'
import { PtyProvider } from '@slayzone/terminal'
import { TelemetryProvider } from '@slayzone/telemetry/client'
import { UndoProvider } from '@slayzone/ui'
import App from './App'
import { getDiagnosticsContext } from './lib/diagnosticsClient'
import { ConvexAuthBootstrap } from './lib/convexAuth'

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

createRoot(document.getElementById('root')!).render(
  <ConvexAuthBootstrap>
    <PtyProvider>
      <ThemeProvider>
        <TelemetryProvider>
          <UndoProvider>
            <App />
          </UndoProvider>
        </TelemetryProvider>
      </ThemeProvider>
    </PtyProvider>
  </ConvexAuthBootstrap>
)
