import { TypedEmitter } from '@slayzone/platform/events'
import type { MenuEventMap } from '@slayzone/transport/server'

/**
 * Host-owned bus for the one-way main→renderer menu / app-shortcut signals
 * (native menus, the `before-input-event` accelerator handler, the auto-updater,
 * the REST/MCP task-open routes). Source for the tRPC `menu.*` subscriptions
 * (slice-5 renderer consumes). Dual-emitted alongside the legacy `app:*` /
 * `browser:*` `webContents.send` broadcasts — both stay live until the renderer
 * drops IPC in slice 5. Injected into the transport package via `setMenuEvents()`
 * at boot so the `menuRouter` and the legacy broadcasts share one instance.
 */
export const menuEvents = new TypedEmitter<MenuEventMap>()
