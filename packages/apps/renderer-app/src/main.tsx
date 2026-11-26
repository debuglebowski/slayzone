import { createRoot } from 'react-dom/client'
import {
  clientHostShortcutBackend,
  deviceSettingsLink,
  getClientHost,
  loadClientSettings
} from '@slayzone/transport/client'
import { adoptShortcutsFromHub } from '@slayzone/shortcuts'
import { isDeviceSetting } from '@slayzone/settings-core/device-keys'
import { TrpcProvider, electronBootstrap } from '@slayzone/transport/client'
import { initTrpcClient } from './trpc'
import { ThemeProvider, AppearanceProvider } from '@slayzone/settings'
import { PtyProvider, registerHibernatedSessionIdsSource } from '@slayzone/terminal'
import { hibernatedSessionIdsSource } from '@slayzone/task-terminals/hibernated-sessions'
import { TelemetryProvider } from '@slayzone/telemetry/client'
import { setShortcutBackend, TooltipProvider, UndoProvider } from '@slayzone/ui'
import { ConvexAuthBootstrap } from '@slayzone/leaderboard'
import { HomeView } from './HomeView'
import { TaskDetailsView } from './TaskDetailsView'
import { registerTaskPanels } from '@slayzone/task/client/TaskPanels'
import { taskPanels } from './taskPanels'
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

// Artifacts + git panels TaskDetailPage embeds — registered before any render.
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
import { OverlayDialogApp } from './OverlayDialogApp'

// window.api shim is installed by the shell before this module evaluates
// (see @slayzone/chromium-shell src/main.tsx), so feature code imported here
// can read window.api safely.

// windowId in the WS query → server ctx.windowId. The fork is single-window so
// getWindowId returns a constant; kept in the URL for parity with the server's
// per-connection contract. Mirrors the app renderer's withWindowId helper.
function withWindowId(serverUrl: string, windowId: number | null | undefined): string {
  if (windowId == null) return serverUrl
  return `${serverUrl}${serverUrl.includes('?') ? '&' : '?'}windowId=${windowId}`
}

/** What the mounting shell turns on. Every field defaults to the desktop (fork) app. */
export interface MountAppOptions {
  /** First-run onboarding: the onboarding dialog, its follow-up CLI-install prompt and
   *  the sidebar's Getting Started checklist. The web shell has none: off. Default on. */
  onboarding?: boolean
}

// Contract consumed by @slayzone/chromium-shell (`mountApp()`, every default) and
// @slayzone/web-shell (`mountApp({ onboarding: false })`).
export async function mountApp({ onboarding = true }: MountAppOptions = {}): Promise<void> {
  const el = document.getElementById('root')
  if (!el) throw new Error('[renderer-app] #root element not found')
  const hash = typeof window !== 'undefined' ? window.location.hash : ''

  // cap-layout-p4 — overlay-dialog mode: SlayzoneOverlayManager loads this bundle
  // into the transparent native overlay surface. Mount ONLY the dialog app; never
  // bind tRPC / data here (dual-shell-instance contention).
  if (hash === '#overlay=dialog') {
    createRoot(el).render(
      <TooltipProvider delayDuration={0}>
        <OverlayDialogApp />
      </TooltipProvider>
    )
    return
  }
  // Layout/browser-panel skeleton demo, kept reachable for development.
  if (hash === '#task-demo') {
    createRoot(el).render(
      <TooltipProvider delayDuration={0}>
        <TaskDetailsView />
      </TooltipProvider>
    )
    return
  }

  // Home view — connects to the sidecar over tRPC-WS. Resolve the server URL
  // (baked-in default port unless overridden) + windowId before mounting so the
  // tRPC client singleton exists for module-scope callers (zustand stores) too.
  const [server, windowId] = await Promise.all([
    electronBootstrap.getServerUrl(),
    electronBootstrap.getWindowId()
  ])
  const trpcUrl = withWindowId(server.url, windowId)
  // The browser panel drives the native mojo host directly through
  // `window.api.browserHost` (window-api-shim) — nothing about it rides tRPC.
  // FIRST initTrpcClient call wins; TrpcProvider reuses the singleton.
  // Device-only preferences stay on this device (plans/settings-by-scope.md, phase 4).
  const { client: hubClient } = initTrpcClient(trpcUrl, {
    links: [deviceSettingsLink({ isDeviceKey: isDeviceSetting, storage: window.localStorage })]
  })
  // Shortcut overrides are this browser's own (the shell's client host store, D3),
  // mirrored to the hub as best effort, after a one-time copy of the hub's map (D1) —
  // same as the desktop.
  setShortcutBackend(
    clientHostShortcutBackend({
      ready: loadClientSettings().then((client) =>
        adoptShortcutsFromHub({
          alreadyAdopted: client.shortcutsAdoptedFromHub,
          readHub: () => hubClient.settings.get.query({ key: 'custom_shortcuts' }),
          write: (overrides) =>
            getClientHost().call('shortcuts.set', overrides, { adoptedFromHub: true })
        })
      ),
      mirror: (json) => hubClient.settings.set.mutate({ key: 'custom_shortcuts', value: json })
    })
  )

  // Provider stack mirrors the Electron renderer (packages/apps/app/src/renderer/
  // src/main.tsx): TrpcProvider OUTERMOST (Pty/Appearance/Telemetry providers call
  // tRPC hooks), then TelemetryProvider (track() — no-ops with no analytics backend
  // configured; it also decides whether third-party services may start: tier not
  // `off`, and the hub's `SLAYZONE_HUB_ENABLE_TELEMETRY`), then ConvexAuthBootstrap
  // (Convex + GitHub OAuth — needs the tRPC context and that decision), then
  // PtyProvider (TaskDetailPage's usePty/useLoopMode/useSlayNudge throw without it),
  // ThemeProvider and AppearanceProvider (useAppearance).
  // settingsRevision is a constant in the fork (no live settings-dialog revision).
  //
  // oauthDelivery="subscription": the fork can't catch the slayzone:// callback in
  // the renderer (it routes to the C++ shell → sidecar). ConvexAuthBootstrap opens
  // the browser via the sidecar and completes the code over app.auth.onCallback.
  // When VITE_CONVEX_URL is unset the bootstrap degrades to LEADERBOARD_AUTH_DISABLED.
  createRoot(el).render(
    <TrpcProvider url={trpcUrl}>
      <TelemetryProvider>
        <ConvexAuthBootstrap oauthDelivery="subscription">
          <PtyProvider>
            <ThemeProvider>
              <AppearanceProvider settingsRevision={0}>
                <UndoProvider>
                  <TooltipProvider delayDuration={0}>
                    <HomeView onboarding={onboarding} />
                  </TooltipProvider>
                </UndoProvider>
              </AppearanceProvider>
            </ThemeProvider>
          </PtyProvider>
        </ConvexAuthBootstrap>
      </TelemetryProvider>
    </TrpcProvider>
  )
}
