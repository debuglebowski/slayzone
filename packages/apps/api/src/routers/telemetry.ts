import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '../trpc'
import { getTelemetryEvents } from '../app-deps'

// Telemetry IPC-event stream — the main-side `setIpcSuccessHook` fans
// instrumented IPC successes here. Mirrors the legacy `telemetry:ipc-event`
// send; the renderer forwards each to PostHog. Host-owned emitter (dual-emit).
export const telemetryRouter = router({
  onIpcEvent: publicProcedure.subscription(() =>
    observable<{ event: string; props: Record<string, unknown> }>((emit) => {
      const handler = (event: string, props: Record<string, unknown>): void =>
        emit.next({ event, props })
      const ev = getTelemetryEvents()
      ev.on('ipc-event', handler)
      return () => ev.off('ipc-event', handler)
    })
  )
})
