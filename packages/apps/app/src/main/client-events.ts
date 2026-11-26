import { TypedEmitter } from '@slayzone/platform/events'
import type { ClientEventMap } from '@slayzone/platform/client-host'

/**
 * Main's bus for THIS device's client events (`ClientHostEvents`): the native
 * menus, the `before-input-event` accelerator handler, browser-view key forwarding,
 * the auto-updater, app zoom and `slayzone://task/…` deep links emit here, and the
 * client host (client-host-ipc.ts) pushes each to this device's renderers directly —
 * never through a hub.
 */
export const clientEvents = new TypedEmitter<ClientEventMap>()
