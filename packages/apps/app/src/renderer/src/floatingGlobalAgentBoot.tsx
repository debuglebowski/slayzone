import type { Root } from 'react-dom/client'
import { isDeviceSetting } from '@slayzone/settings-core/device-keys'
import { deviceSettingsLink } from '@slayzone/transport/client'
import { ThemeProvider } from '@slayzone/settings'
import { PtyProvider } from '@slayzone/terminal'
import { FederatedRoot, HubScope, seedHubRegistry } from '@slayzone/transport/client'
import { TooltipProvider } from '@slayzone/ui'
import { FloatingGlobalAgentPanel, GlobalAgentHubUnavailable } from '@slayzone/agent-panels'
import { initTrpcClient } from './trpc'

export interface FloatingGlobalAgentBootDeps {
  bootstrap: Parameters<typeof seedHubRegistry>[1] & {
    getServerUrl: () => Promise<{ url: string }>
    getWindowId: () => Promise<number | null | undefined>
    floatingAgentBootFailed: () => Promise<void>
  }
  withWindowId: (url: string, windowId: number | null | undefined) => string
  onError: (error: unknown) => void
}

/**
 * The floating global agent window: a minimal renderer — no tab store, telemetry or
 * convex. Still needs tRPC: ThemeProvider (and PtyProvider) talk to it. Federated
 * like the main window: the session it shows runs on the hub that owns its project,
 * which may not be this desktop's own (#183). The default hub reuses the boot client,
 * exactly as in the main window.
 *
 * Boot never leaves the window empty: if the server url, window id or hub registry
 * can't be read, it shows the hub as unreachable with a Retry (a reload, which
 * boots again), expands the window so that fits, and reports the cause.
 */
export function bootFloatingGlobalAgentPanel(
  root: Root,
  { bootstrap, withWindowId, onError }: FloatingGlobalAgentBootDeps
): Promise<void> {
  return Promise.all([bootstrap.getServerUrl(), bootstrap.getWindowId()])
    .then(async ([server, windowId]) => {
      const { defaultHubId } = await seedHubRegistry(server, bootstrap)
      // Device-only preferences stay on this device (plans/settings-by-scope.md, phase 4).
      initTrpcClient(withWindowId(server.url, windowId), {
        links: [deviceSettingsLink({ isDeviceKey: isDeviceSetting, storage: window.localStorage })]
      })
      root.render(
        <FederatedRoot decorateUrl={(url) => withWindowId(url, windowId)}>
          <HubScope
            hubId={defaultHubId}
            fallback={<GlobalAgentHubUnavailable hubId={defaultHubId} />}
          >
            <PtyProvider>
              <ThemeProvider>
                <TooltipProvider delayDuration={0}>
                  <FloatingGlobalAgentPanel />
                </TooltipProvider>
              </ThemeProvider>
            </PtyProvider>
          </HubScope>
        </FederatedRoot>
      )
    })
    .catch((error: unknown) => {
      onError(error)
      root.render(<GlobalAgentHubUnavailable />)
      // A collapsed widget can't fit the message: the host expands it. Best effort.
      return bootstrap.floatingAgentBootFailed().catch(onError)
    })
}
