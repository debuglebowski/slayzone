import './assets/main.css'

import { isDeviceSetting } from '@slayzone/settings-core/device-keys'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@slayzone/settings'
import { loadTabStoreState, stopViewStatePersistence, useTabStore } from '@slayzone/tabs-state'
import { PtyProvider, registerHibernatedSessionIdsSource } from '@slayzone/terminal'
import { hibernatedSessionIdsSource } from '@slayzone/task-terminals/hibernated-sessions'
import { TelemetryProvider } from '@slayzone/telemetry/client'
import {
  TrpcProvider,
  FederatedRoot,
  HubScope,
  electronBootstrap,
  setHubConnectProbe,
  setHubConnectAbortListener,
  getHubConnectTraces,
  setDirectLinkProbe,
  setDirectRtcPeerFactory,
  seedHubRegistry,
  deviceSettingsLink,
  clientHostShortcutBackend,
  getClientHost,
  loadClientSettings
} from '@slayzone/transport/client'
import { adoptShortcutsFromHub } from '@slayzone/shortcuts'
import { getHubClient, getTrpcClient, initTrpcClient } from './trpc'
import { setShortcutBackend, TooltipProvider, UndoProvider } from '@slayzone/ui'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import { registerTaskPanels } from '@slayzone/task/client/TaskPanels'
import { taskPanels } from './app-shell/taskPanels'
import {
  registerTaskSessionsSource,
  taskSessionsSource
} from '@slayzone/task/client/taskSessionsSource'
import { registerProjectSettingsTabs } from '@slayzone/projects/client/ProjectSettingsTabs'
import { TagsSettingsTab } from '@slayzone/settings/client/tabs/TagsSettingsTab'
import { integrationsProjectSettingsTabs } from '@slayzone/integrations/project-settings-tabs'
import { useDetectedRepos } from '@slayzone/worktrees/hooks'
import { registerArtifactUploader } from '@slayzone/editor/hooks'
import { useArtifactUploader } from '@slayzone/task-artifacts/artifact-uploader'
import App from './App'
import { bootFloatingGlobalAgentPanel } from './floatingGlobalAgentBoot'
import { RemoteConfigScreen } from './components/RemoteConfigScreen'
import { SecondaryTaskWindow } from './components/SecondaryTaskWindow'
import {
  getDiagnosticsContext,
  recordClientError,
  recordRendererEvent
} from './lib/diagnosticsClient'
import { isBenignWindowError } from './lib/benignWindowError'
import { startBootTimingsReport } from './lib/bootTimings'
import { ConvexAuthBootstrap } from './lib/convexAuth'
import { MaybeProfiler } from './lib/perfProfiler'

/**
 * Links of this window's own hub connection: device-only preferences (fonts, theme,
 * terminal rendering) are kept on this device (plans/settings-by-scope.md, phase 4).
 */
const deviceLinks = () => [
  deviceSettingsLink({ isDeviceKey: isDeviceSetting, storage: window.localStorage })
]

// Artifacts + git panels TaskDetailPage embeds (main + secondary task windows) —
// registered before any render.
registerTaskPanels(taskPanels)
// Agent-session history TerminalContainer shows (task owns agentSessions) —
// registered before any render.
registerTaskSessionsSource(taskSessionsSource)
// Settings' tag editor, integrations' tab and worktrees' repo detection
// ProjectSettingsPanel embeds — registered before any render.
registerProjectSettingsTabs({
  TagsSettingsTab,
  ...integrationsProjectSettingsTabs,
  useDetectedRepos
})
// Terminal-state store's persisted hibernated set (task-terminals owns it) —
// registered before any render (PtyProvider seeds from it on mount).
registerHibernatedSessionIdsSource(hibernatedSessionIdsSource)
// Artifact storage behind editor image paste/drop (task description + chat) —
// registered before any render.
registerArtifactUploader(useArtifactUploader)

const params = new URLSearchParams(window.location.search)
const isFloatingGlobalAgentPanel = params.get('floating') === 'global-agent-panel'
const taskWindowId = params.get('taskWindow')

// windowId in the WS query → server ctx.windowId (= webContents.id). Required
// by claimSession + panel-ownership procs; without it they throw "windowId
// required". The base URL comes from getServerUrl (local: embedded port;
// remote: user-configured — which may already carry a query).
function withWindowId(serverUrl: string, windowId: number | null | undefined): string {
  if (windowId == null) return serverUrl
  return `${serverUrl}${serverUrl.includes('?') ? '&' : '?'}windowId=${windowId}`
}

// While a hub is unreachable, ask main's GET /health before opening another
// socket outside the reconnect schedule. Failed WebSocket connects are counted
// per renderer process by Chromium and throttle EVERY later socket — a dead
// federated hub was delaying the default hub's handshake on reload by ~2.4s.
// Main-side probes don't touch that counter. See transport connectPacing.ts.
setHubConnectProbe(async (url) => (await electronBootstrap.probeServerHealth(url)).ok)
// A hub socket stuck in its handshake and given up (transport connectHandshake.ts) is
// recorded: "the hub was up but the app could not reach it" leaves this trail.
setHubConnectAbortListener(({ url, reason, waitedMs }) =>
  recordRendererEvent(
    'hub.connect.abort',
    `Gave up a hub connection stuck in its handshake (${reason}, ${waitedMs}ms)`,
    { url, reason, waitedMs }
  )
)

// Direct links to computers (docs/direct-link.md): main checks this document's CSP
// and probes the computer over HTTP, so a socket that would fail is never opened —
// a failed WebSocket here would also slow the hub's (see above).
setDirectLinkProbe(
  async (address, hubId) => (await electronBootstrap.prepareDirectLink(address, hubId)).ok
)
// A computer with no listener this window can dial (a remote one, behind NAT) is
// reached over WebRTC, brokered by the hub. A failed WebRTC connect is not a failed
// WebSocket, so it cannot slow the hub's socket either.
setDirectRtcPeerFactory((config) => new RTCPeerConnection(config))

window.addEventListener('error', (event) => {
  if (isBenignWindowError(event)) return
  recordClientError({
    type: 'window.error',
    message: event.message || 'Unknown window error',
    stack: event.error?.stack ?? null,
    url: event.filename ?? null,
    line: event.lineno ?? null,
    column: event.colno ?? null,
    snapshot: getDiagnosticsContext()
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection')
  const stack = reason instanceof Error ? reason.stack : null
  recordClientError({
    type: 'window.unhandledrejection',
    message,
    stack,
    snapshot: getDiagnosticsContext()
  })
})

// Floating global agent panel: its own minimal boot (floatingGlobalAgentBoot.tsx).
if (isFloatingGlobalAgentPanel) {
  void bootFloatingGlobalAgentPanel(createRoot(document.getElementById('root')!), {
    bootstrap: electronBootstrap,
    withWindowId,
    // Diagnostics go through the tRPC client, which this boot had not created yet.
    onError: (error) => console.error('[floating-global-agent] boot failed', error)
  })
} else if (taskWindowId) {
  // Secondary task window: full TaskDetailPage scoped to one task. No tab store / sidebar.
  // No RemoteConfigScreen fallback here — secondary windows can only be opened
  // from a main window that already has a working server connection.
  Promise.all([electronBootstrap.getServerUrl(), electronBootstrap.getWindowId()]).then(
    async ([server, windowId]) => {
      // Same hub registry as the main window: without it every "is this hub local?"
      // check (local agents' file:, the camera button, the browser's cookie jar) read
      // the desktop's own hub as remote in a task window.
      await seedHubRegistry(server, electronBootstrap)
      createRoot(document.getElementById('root')!).render(
        <TrpcProvider url={withWindowId(server.url, windowId)}>
          <PtyProvider>
            <ThemeProvider>
              <UndoProvider>
                <TooltipProvider delayDuration={0}>
                  <SecondaryTaskWindow taskId={taskWindowId} />
                </TooltipProvider>
              </UndoProvider>
            </ThemeProvider>
          </PtyProvider>
        </TrpcProvider>
      )
    }
  )
} else {
  electronBootstrap.bootMark('renderer script entered')
  // One `renderer.boot.timings` diagnostics row per boot (sends ~10s in).
  startBootTimingsReport((payload) =>
    recordRendererEvent(
      'renderer.boot.timings',
      `renderer boot: active tab ${payload.marks.activeTabDetail ?? '-'}ms, ` +
        `${payload.longTasks.n} long tasks / ${payload.longTasks.totalMs}ms in 10s`,
      { ...payload }
    )
  )
  // Wait for tab store + server URL discovery before rendering. Tab store
  // hydrates from SQLite (prevents effect race wiping persisted tabs); the
  // server URL (local: embedded port; remote: configured host) is needed to
  // construct the WS URL passed to TrpcProvider. Boot config carries the Convex
  // deployment main decided (the one its hub was handed too).
  Promise.all([
    electronBootstrap.getServerUrl(),
    electronBootstrap.getWindowId(),
    electronBootstrap.getHubRegistry(),
    electronBootstrap.getHubTokens(),
    electronBootstrap.getBootConfig()
  ]).then(async ([server, windowId, registry, hubTokens, bootConfig]) => {
    // Remote mode with a missing/unreachable server → render the recovery
    // screen instead of mounting TrpcProvider against a dead URL (it would
    // WS-reconnect-loop forever behind a blank window). Probe runs main-side.
    if (server.mode === 'remote') {
      const reachable = server.url
        ? (await electronBootstrap.probeServerHealth(server.url)).ok
        : false
      if (!reachable) {
        createRoot(document.getElementById('root')!).render(
          <RemoteConfigScreen initialUrl={server.url} />
        )
        return
      }
    }

    const trpcUrl = withWindowId(server.url, windowId)
    // Initialize the tRPC client singleton NOW (before prefetch / React mount) so
    // module-scope callers — incl. taskDetailCache.prefetch below and getTrpcClient()
    // in stores — work. TrpcProvider reuses this same client (one WS connection).
    initTrpcClient(trpcUrl, { links: deviceLinks() })
    // Shortcut overrides are this device's own (client.config.json, which main also
    // builds the native menu and key matcher from): the store reads and writes them
    // through the client host, and mirrors each save to the default hub as best
    // effort (older app versions, a new device's adoption). The first boot after the
    // move copies the hub's map over the file once (D1) — before the store loads.
    const shortcutsAdopted = loadClientSettings().then((client) =>
      adoptShortcutsFromHub({
        alreadyAdopted: client.shortcutsOwnedByDevice,
        readHub: () => getTrpcClient().settings.get.query({ key: 'custom_shortcuts' }),
        write: (overrides) =>
          getClientHost().call('shortcuts.set', overrides, { adoptedFromHub: true })
      })
    )
    setShortcutBackend(
      clientHostShortcutBackend({
        ready: shortcutsAdopted,
        mirror: (json) =>
          getTrpcClient().settings.set.mutate({ key: 'custom_shortcuts', value: json })
      })
    )
    await loadTabStoreState()
    electronBootstrap.bootMark('tabStoreReady resolved')

    // Prefetch the ACTIVE tab's task detail — warms its Suspense cache before React
    // mounts. Fire-and-forget: the cache's resolved-value tracking + notify ensures
    // immediate re-render when data arrives, eliminating the 250ms use() scheduling
    // delay. Keyed by hub exactly as TaskDetailDataLoader reads it (each tab sits in
    // a HubScope, default hub unless the task is known to live elsewhere — which is
    // not known yet here). Unkeyed, every entry missed and each tab fetched twice.
    //
    // Only the active one: hidden tabs load through the pane hydrator's queue (a few
    // at a time, likeliest-to-open first). Prefetching every restored tab here put
    // ~50 detail loads in front of the visible tab's, all at once, on a hub that
    // answers one request at a time — on a busy hub, enough to time out every tab.
    const { tabs, activeTabIndex } = useTabStore.getState()
    const activeTab = tabs[activeTabIndex]
    if (activeTab?.type === 'task') {
      void taskDetailCache.prefetch('taskDetail', activeTab.taskId, registry.defaultHubId)
    }

    // E2E: expose the vanilla tRPC client so specs can call
    // page.evaluate(() => window.getTrpcVanillaClient().task.getAll.query()).
    if (electronBootstrap.isPlaywright()) {
      ;(
        window as typeof window & {
          getTrpcVanillaClient?: () => ReturnType<typeof initTrpcClient>['client']
        }
      ).getTrpcVanillaClient = () => initTrpcClient(trpcUrl).client
      ;(
        window as typeof window & { __slayzone_stopViewStatePersistence?: () => Promise<void> }
      ).__slayzone_stopViewStatePersistence = stopViewStatePersistence
      // A federated hub's OWN client (null until something resolved it), so specs can
      // drive what a pane scoped to that hub sends — incl. host-path forwarding.
      ;(
        window as typeof window & {
          __slayzone_hubClientForTest?: (
            hubId: string
          ) => ReturnType<typeof initTrpcClient>['client'] | null
        }
      ).__slayzone_hubClientForTest = (hubId) => getHubClient(hubId)?.client ?? null
      // Every hub's recent connect attempts (transport connectTrace.ts), for failure dumps.
      ;(
        window as typeof window & {
          __slayzone_hubConnectTraces?: typeof getHubConnectTraces
        }
      ).__slayzone_hubConnectTraces = getHubConnectTraces
    }
    // Multi-hub federation registry. The DEFAULT hub is pinned to `server.url` —
    // the exact url boot's initTrpcClient() used — so its HubScope reuses that
    // one boot WS singleton (module-scope getTrpcClient() coherence) and the
    // single-hub tree stays byte-identical. windowId is appended per-hub via the
    // same withWindowId the singleton used. Remote/extra hubs (multi_hub on)
    // carry their own urls from the registry.
    const decorateUrl = (url: string): string => withWindowId(url, windowId)
    // Seed the live hub registry once with the exact data that used to flow
    // directly into FederationProvider's props. A sign-in pushes fresh tokens
    // into this store post-boot (no relaunch needed) — FederatedRoot below is
    // the seam that turns a store update into an actual re-render.
    await seedHubRegistry(server, {
      getHubRegistry: async () => registry,
      getHubTokens: async () => hubTokens
    })

    performance.mark('sz:reactMount')
    electronBootstrap.bootMark('reactMount')
    createRoot(document.getElementById('root')!).render(
      // FederatedRoot (registry) + HubScope (the default hub's client) must
      // be OUTERMOST: ConvexAuthBootstrap (and Pty/Theme/Telemetry providers) now
      // call tRPC hooks, so they need the tRPC context. With one hub this is
      // identical to the former single TrpcProvider. TelemetryProvider sits above
      // ConvexAuthBootstrap: Convex starts only when it says third-party services
      // are allowed (tier not `off`, the default hub not with telemetry off).
      <FederatedRoot decorateUrl={decorateUrl}>
        <HubScope hubId={registry.defaultHubId}>
          <TelemetryProvider>
            <ConvexAuthBootstrap convexUrl={bootConfig.convexUrl}>
              <PtyProvider>
                <ThemeProvider>
                  <UndoProvider>
                    <MaybeProfiler>
                      <TooltipProvider delayDuration={0}>
                        <App />
                      </TooltipProvider>
                    </MaybeProfiler>
                  </UndoProvider>
                </ThemeProvider>
              </PtyProvider>
            </ConvexAuthBootstrap>
          </TelemetryProvider>
        </HubScope>
      </FederatedRoot>
    )
  })
}
