import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppMetaMounts, AppWindowMounts, MenuMounts } from '@slayzone/host-capabilities/server'
import type { AppBrowserMounts, AppWebviewMounts } from '../server/router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers task-browser calls: its own `app.browser` and
 * `app.webview`, plus `app.meta`, `app.window` and `menu`.
 */
export const { useTRPC, useTRPCClient } = typedTrpc<
  AppBrowserMounts & AppWebviewMounts & AppMetaMounts & AppWindowMounts & MenuMounts
>()
