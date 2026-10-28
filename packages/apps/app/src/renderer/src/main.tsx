import './assets/main.css'

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
  getTrpcClient,
  initTrpcClient,
  setHubConnectProbe,
  useHubRegistryStore
} from '@slayzone/transport/client'
import type { HubEntry } from '@slayzone/types'
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
import { FloatingGlobalAgentPanel } from '@slayzone/agent-panels'
import { RemoteConfigScreen } from './components/RemoteConfigScreen'
import { SecondaryTaskWindow } from './components/SecondaryTaskWindow'
import {
  getDiagnosticsContext,
  recordClientError,
  recordRendererEvent
} from './lib/diagnosticsClient'
import { startBootTimingsReport } from './lib/bootTimings'
import { ConvexAuthBootstrap } from './lib/convexAuth'
import { MaybeProfiler } from './lib/perfProfiler'

// Artifacts + git panels TaskDetailPage embeds (main + secondary task windows) —
// registered before any render.
registerTaskPanels(taskPanels)
// Agent-session history TerminalContainer shows (task owns agentSessions) —
// registered before any render.
registerTaskSessionsSource(taskSessionsSource)
// Settings' tag editor, integrations' tab and worktrees' repo detection
// ProjectSettingsDialog embeds — registered before any render.
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

window.addEventListener('error', (event) => {
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

// Floating global agent panel: minimal renderer — skip tab store, telemetry, convex, etc.
// Still needs TrpcProvider: ThemeProvider (and PtyProvider) now talk tRPC.
if (isFloatingGlobalAgentPanel) {
  Promise.all([electronBootstrap.getServerUrl(), electronBootstrap.getWindowId()]).then(
    ([server, windowId]) => {
      createRoot(document.getElementById('root')!).render(
        <TrpcProvider url={withWindowId(server.url, windowId)}>
          <PtyProvider>
            <ThemeProvider>
              <TooltipProvider delayDuration={0}>
                <FloatingGlobalAgentPanel />
              </TooltipProvider>
            </ThemeProvider>
          </PtyProvider>
        </TrpcProvider>
      )
    }
  )
} else if (taskWindowId) {
  // Secondary task window: full TaskDetailPage scoped to one task. No tab store / sidebar.
  // No RemoteConfigScreen fallback here — secondary windows can only be opened
  // from a main window that already has a working server connection.
  Promise.all([electronBootstrap.getServerUrl(), electronBootstrap.getWindowId()]).then(
    ([server, windowId]) => {
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
  // construct the WS URL passed to TrpcProvider.
  Promise.all([
    electronBootstrap.getServerUrl(),
    electronBootstrap.getWindowId(),
    electronBootstrap.getHubRegistry(),
    electronBootstrap.getHubTokens()
  ]).then(async ([server, windowId, registry, hubTokens]) => {
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
    initTrpcClient(trpcUrl)
    // Wire the shortcut store's persistence to tRPC (was the preload
    // global). @slayzone/ui has no transport dependency, so the host injects the
    // backend. Closures are lazy — they call getTrpcClient() only when invoked,
    // which is always after the init above.
    setShortcutBackend({
      get: (key) => getTrpcClient().settings.get.query({ key }),
      set: async (key, value) => {
        await getTrpcClient().settings.set.mutate({ key, value })
      },
      notifyChanged: () => {
        void getTrpcClient().app.shortcuts.changed.mutate()
      }
    })
    await loadTabStoreState()
    electronBootstrap.bootMark('tabStoreReady resolved')

    // Prefetch task details for open tabs — warms Suspense cache before React mounts.
    // Fire-and-forget: the cache's resolved-value tracking + notify ensures immediate
    // re-render when data arrives, eliminating the 250ms use() scheduling delay.
    // Keyed by hub exactly as TaskDetailDataLoader reads it (each tab sits in a
    // HubScope, default hub unless the task is known to live elsewhere — which is
    // not known yet here). Unkeyed, every entry missed and each tab fetched twice.
    for (const tab of useTabStore.getState().tabs) {
      if (tab.type === 'task') {
        void taskDetailCache.prefetch('taskDetail', tab.taskId, registry.defaultHubId)
      }
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
    }
    // Multi-hub federation registry. The DEFAULT hub is pinned to `server.url` —
    // the exact url boot's initTrpcClient() used — so its HubScope reuses that
    // one boot WS singleton (module-scope getTrpcClient() coherence) and the
    // single-hub tree stays byte-identical. windowId is appended per-hub via the
    // same withWindowId the singleton used. Remote/extra hubs (multi_hub on)
    // carry their own urls from the registry.
    const hubs: HubEntry[] = registry.hubs.map((h) =>
      h.id === registry.defaultHubId ? { ...h, url: server.url } : h
    )
    const decorateUrl = (url: string): string => withWindowId(url, windowId)
    // Seed the live hub registry once with the exact data that used to flow
    // directly into FederationProvider's props. A sign-in pushes fresh tokens
    // into this store post-boot (no relaunch needed) — FederatedRoot below is
    // the seam that turns a store update into an actual re-render.
    useHubRegistryStore.getState().seed(hubs, registry.defaultHubId, hubTokens)

    performance.mark('sz:reactMount')
    electronBootstrap.bootMark('reactMount')
    createRoot(document.getElementById('root')!).render(
      // FederatedRoot (registry) + HubScope (the default hub's client) must
      // be OUTERMOST: ConvexAuthBootstrap (and Pty/Theme/Telemetry providers) now
      // call tRPC hooks, so they need the tRPC context. With one hub this is
      // identical to the former single TrpcProvider.
      <FederatedRoot decorateUrl={decorateUrl}>
        <HubScope hubId={registry.defaultHubId}>
          <ConvexAuthBootstrap>
            <PtyProvider>
              <ThemeProvider>
                <TelemetryProvider>
                  <UndoProvider>
                    <MaybeProfiler>
                      <TooltipProvider delayDuration={0}>
                        <App />
                      </TooltipProvider>
                    </MaybeProfiler>
                  </UndoProvider>
                </TelemetryProvider>
              </ThemeProvider>
            </PtyProvider>
          </ConvexAuthBootstrap>
        </HubScope>
      </FederatedRoot>
    )
  })
}
