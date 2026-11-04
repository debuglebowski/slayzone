import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppMetaMounts, AppWindowMounts, MenuMounts } from '@slayzone/host-capabilities/server'
import type { AppBrowserRelayMounts } from '../server/relay-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers task-browser calls: its own `app.browserRelay`, plus
 * `app.meta`, `app.window` and `menu`. Live web views are NOT here — the panel drives
 * them on this device's browser host (`./browser-host.ts`).
 */
export const { useTRPC, useTRPCClient } = typedTrpc<
  AppBrowserRelayMounts & AppMetaMounts & AppWindowMounts & MenuMounts
>()
