import { TypedEmitter } from '@slayzone/platform/events'
import type { TelemetryEventMap } from '@slayzone/transport/server'

/**
 * Host-owned telemetry IPC-event bus. Dual-emitted alongside the legacy
 * `telemetry:ipc-event` webContents.send so the tRPC `telemetry.onIpcEvent`
 * subscription works while the renderer still consumes IPC (coexistence until
 * the bridge drops). Injected into the transport package via
 * `setTelemetryEvents()` at boot. `TelemetryEventMap` lives transport-side
 * (transport can't import from apps/app); the host conforms to it.
 */
export const telemetryEvents = new TypedEmitter<TelemetryEventMap>()
