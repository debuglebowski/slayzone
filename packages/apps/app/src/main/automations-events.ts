import { TypedEmitter } from '@slayzone/platform/events'
import type { AutomationsEventMap } from '@slayzone/transport/server'

/**
 * Host-owned automations-changed bus. Dual-emitted alongside the legacy
 * `automations:changed` webContents.send so the tRPC `automations.onChanged`
 * subscription works while the renderer still consumes IPC (coexistence until
 * the bridge drops). Injected into the transport package via
 * `setAutomationsEvents()` at boot. `AutomationsEventMap` lives transport-side
 * (transport can't import from apps/app); the host conforms to it.
 */
export const automationsEvents = new TypedEmitter<AutomationsEventMap>()
