// Telemetry server half (pure Node, Electron-free): the `telemetry.*` tRPC router
// and the host-injected IPC-event bus it streams. Composed by `@slayzone/api`.
export { telemetryRouter } from './telemetry-router'
export { setTelemetryEvents, getTelemetryEvents, type TelemetryEventMap } from './telemetry-events'
