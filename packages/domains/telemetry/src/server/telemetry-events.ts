import type { TypedEmitter } from '@slayzone/platform/events'

// Telemetry IPC-event bus — the main-side `setIpcSuccessHook` fans instrumented
// IPC successes here. Backs the `telemetry.onIpcEvent` sub. Host-owned, injected
// so the router and the still-live `telemetry:ipc-event` send share one instance.
export type TelemetryEventMap = {
  'ipc-event': [event: string, props: Record<string, unknown>]
}

let telemetryEvents: TypedEmitter<TelemetryEventMap> | null = null

export function setTelemetryEvents(ev: TypedEmitter<TelemetryEventMap>): void {
  telemetryEvents = ev
}

export function getTelemetryEvents(): TypedEmitter<TelemetryEventMap> {
  if (!telemetryEvents)
    throw new Error(
      'telemetryEvents not initialized — call setTelemetryEvents() in main host first'
    )
  return telemetryEvents
}
