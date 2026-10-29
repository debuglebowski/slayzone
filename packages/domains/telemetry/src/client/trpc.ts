import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppMetaMounts } from '@slayzone/host-capabilities/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { TelemetryMounts } from '../server/telemetry-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers telemetry calls: its own `telemetry`, `settings` and
 * `app.meta`.
 */
export const { useTRPC, getTrpcClient } = typedTrpc<
  TelemetryMounts & SettingsMounts & AppMetaMounts
>()

/** The vanilla client of this view (`getTrpcClient()`). */
export type TelemetryTrpcClient = ReturnType<typeof getTrpcClient>
