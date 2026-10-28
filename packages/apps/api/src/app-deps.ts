// App-level dependencies that the routers need but cannot build themselves: the
// composition root injects the concrete instances at startup via the setters below.
// A server without one wired throws on the first call that reads it. (A domain that
// owns its router keeps that router's registry itself, e.g. terminal's
// `setPtyDeps`/`setChatDeps`.)

import type { TypedEmitter } from '@slayzone/platform/events'
import type { HubSwitches } from '@slayzone/platform'
import type { DiagnosticsConfig } from '@slayzone/diagnostics/shared'
import type { FindJoinTokenAccount } from './join-token-policy'
import type { HostCapabilities } from '@slayzone/host-capabilities/server'
import type { UsageHost } from '@slayzone/terminal/server'
import type { TaskBrowserHost } from '@slayzone/task-browser/server'
import type { FloatingAgentHost } from '@slayzone/agent-panels/server'

// Backup ops — the registry lives with the `app.backup` router that reads it.
export { setBackupOps, getBackupOps, type BackupOps } from '@slayzone/settings/server'

// Floating global agent panel state — lives with the `app.floatingAgent` router.
export type { FloatingAgentState } from '@slayzone/agent-panels/server'

// Notify event bus (`notify.*`) — lives with the `notify` router.
export {
  setNotifyEvents,
  getNotifyEvents,
  emitSettingsChanged,
  type NotifyEventMap,
  type SettingsChange
} from '@slayzone/notify/server'

// Menu / app-shortcut bus (`menu.*`) — lives with the `menu` router.
export {
  setMenuEvents,
  getMenuEvents,
  type MenuEventMap
} from '@slayzone/host-capabilities/server'

// Auth-callback bus (`app.auth.onCallback`) — lives with the `app.auth` router.
export {
  setAuthEvents,
  getAuthEvents,
  type AuthEventMap
} from '@slayzone/host-capabilities/server'

// Power-resume bus — Electron `powerMonitor.on('resume')` is host-only, but the
// AutomationEngine (which runs catchup on wake) lives in the side-car after the
// slice-9 cutover. The host fires `resume` on this emitter; the capability
// bridge forwards it to the side-car, which calls `automationEngine.runCatchup()`.
export type PowerResumeEventMap = {
  resume: []
}

let powerResumeEvents: TypedEmitter<PowerResumeEventMap> | null = null

export function setPowerResumeEvents(ev: TypedEmitter<PowerResumeEventMap>): void {
  powerResumeEvents = ev
}

export function getPowerResumeEvents(): TypedEmitter<PowerResumeEventMap> {
  if (!powerResumeEvents)
    throw new Error(
      'powerResumeEvents not initialized — call setPowerResumeEvents() in main host first'
    )
  return powerResumeEvents
}

// App-level ops — the grab-bag of main-process capabilities (backup, clipboard,
// screenshot, leaderboard, export/import, usage, …) that the `app` router wraps.
// Each is electron- or DB-coupled, so `import type` only here; the Electron-main
// host injects concrete impls via `setAppDeps()`. Same impls back the still-live
// IPC handlers (coexistence until slice 5). Signatures are Promise-typed because
// main's `SlayzoneDb` is async (worker_thread). A standalone server without these
// wired throws on the first app procedure call.
//
// The members the `app.*` routers wrap are declared by the package that owns each
// router (`HostCapabilities`, `UsageHost`, `TaskBrowserHost`, `FloatingAgentHost`),
// so router and host share one contract; this type is their union plus the members
// only api's own code reads. Member names are the capability bridge's wire contract
// (`capability-bridge.ts` forwards by name): never rename one.
export type AppDeps = HostCapabilities &
  UsageHost &
  TaskBrowserHost & {
    floatingAgent: FloatingAgentHost
  } & {
    /** Relaunch the desktop app. Used by backup restore, which overwrites the
     *  database file and must then restart everything pointing at it. */
    appRelaunch: () => void

    /**
     * Hand a saved diagnostics config to the desktop, which persists it to the
     * CLIENT store.
     *
     * Both processes record into the same machine-local diagnostics database but
     * hold separate copies of the config that gates it — the hub's in the shared
     * DB, the desktop's in the client store — and the Settings UI writes to the
     * hub. Without this the desktop keeps recording after the user turns
     * diagnostics off.
     */
    diagnosticsConfigChanged: (next: DiagnosticsConfig) => Promise<void>

    // Reveal + select an item in the OS file manager (Electron shell only) —
    // backs file-editor `showInFinder`. Forwarded over the capability bridge.
    shellShowItemInFolder: (absPath: string) => void

    // app metadata
    /**
     * OS downloads folder — the default directory for artifact save dialogs.
     * Async because the capability bridge forwards every call over the wire; a
     * sync signature here would type-check (the bridge proxy is cast to AppDeps)
     * and then hand callers a Promise at runtime.
     */
    appGetDownloadsDir: () => Promise<string>
    // Raise/show+focus the main window — the CLI/agent `tasks/open` foreground
    // path. Forwarded over the capability bridge so the side-car's REST route can
    // bring the Electron host window forward. No-op off-window (standalone).
    appRaiseMainWindow: () => void

    // Theme — Electron `nativeTheme`-backed (resolves 'system' against the OS), so
    // host-only. The `settings.*Theme` tRPC procedures resolve these (through
    // `settings-host-wiring.ts`; forwarded
    // over the capability bridge); the `theme:changed` event streams back on the
    // bridge's `theme` channel → the side-car's settingsEvents → onThemeChanged.
    themeGetEffective: () => 'dark' | 'light'
    themeGetSource: () => 'system' | 'light' | 'dark'
    themeSet: (pref: 'light' | 'dark' | 'system') => Promise<'dark' | 'light'>

    // Credential cipher — Electron `safeStorage`-backed, so host-only. The side-car
    // runs as ELECTRON_RUN_AS_NODE (no safeStorage), so its credential store
    // forwards encrypt/decrypt here over the bridge. Base64 strings on the wire
    // (superjson does not round-trip Buffer). Async — Electron's async safeStorage
    // API; `shouldReEncrypt` = OS key rotated, the side-car re-encrypts + persists.
    credentialCipher: {
      isEncryptionAvailable: () => Promise<boolean>
      encryptStringToB64: (secret: string) => Promise<string>
      decryptStringFromB64: (b64: string) => Promise<{ result: string; shouldReEncrypt: boolean }>
    }

    // Native save sheet, parented to the focused window host-side so the side-car
    // never needs a window handle. Backs every artifact download.
    dialogShowSaveDialog: (options: unknown) => Promise<{ canceled: boolean; filePath?: string }>

    // Artifact export — offscreen BrowserWindow rendering, unavailable off the
    // Electron host. HTML building lives here too (not side-car side) because
    // buildMermaidPdfHtml reads the mermaid bundle only the host's build ships and silently falls
    // back to plain-code rendering when it misses; from the side-car bundle it
    // would miss every time and quietly downgrade mermaid exports. The renderers
    // write straight to destPath so multi-MB buffers never cross the bridge.
    artifactBuildExportHtml: (content: string, mode: string, title: string) => Promise<string>
    artifactRenderPdfToFile: (
      content: string,
      mode: string,
      title: string,
      destPath: string
    ) => Promise<void>
    /** False when the mode has no PNG representation (buildPngHtml declined). */
    artifactRenderPngToFile: (
      content: string,
      mode: string,
      title: string,
      destPath: string
    ) => Promise<boolean>

    /**
     * The task/tab browser REGISTRY — distinct from `browser` below, which is the
     * view-id-keyed WebContentsView manager.
     *
     * Exists so the REST browser routes can run on the hub, where the
     * `tasks.browser_tabs` row they read and write lives. They used to be
     * reverse-proxied to the desktop wholesale, purely because the old
     * `BrowserAccess` handed back a live `WebContents` — which in turn forced the
     * desktop to keep its own connection to the shared database. A handle can't
     * cross the bridge; `(taskId, tabId)` can.
     *
     * `capturePageToFile` writes the PNG on the host so a full-page image never
     * travels as a buffer, matching the `artifactRender*ToFile` slots.
     */
    browserTabs: {
      getResolvedTabId: (taskId: string, tabId?: string) => Promise<string | null>
      listTabs: (taskId: string) => Promise<Array<{ tabId: string; active?: boolean }>>
      hasTab: (taskId: string, tabId?: string) => Promise<boolean>
      /** Resolves once a tab registers; rejects on timeout. */
      waitForRegistration: (
        taskId: string,
        opts: { tabId?: string; timeoutMs?: number }
      ) => Promise<void>
      execJs: (taskId: string, tabId: string | null, code: string) => Promise<unknown>
      loadUrl: (taskId: string, tabId: string | null, url: string) => Promise<void>
      getUrl: (taskId: string, tabId: string | null) => Promise<string | null>
      /** False when the captured image was empty. */
      capturePageToFile: (
        taskId: string,
        tabId: string | null,
        destPath: string
      ) => Promise<boolean>
    }
  }

let appDeps: AppDeps | null = null

export function setAppDeps(deps: AppDeps): void {
  appDeps = deps
}

export function getAppDeps(): AppDeps {
  if (!appDeps) throw new Error('appDeps not initialized — call setAppDeps() in main host first')
  return appDeps
}

// Computers / computer deps — the hub/computer-split surface the `computersRouter` needs
// that transport cannot own itself: the live computer gateway (computer-WS connection
// status) plus the value `mintJoinToken` bakes into a join token (the computer WS URL
// a computer dials). Both are exposed as GETTERS, not snapshots: the gateway is built
// asynchronously (auth migrations) and the URL is only known after the server binds
// its port, so the registry must read the live refs each call.
//
// Populated once composeServer + the server host wire it (always, barring init failure); when
// the computer init failed it is not set and `getComputersDeps()` throws — the router's
// computer-dependent procedures fail cleanly and nothing calls them (the UI is
// wave 3). The pure computer-binding mutations (setTaskComputer / … / revokeComputer)
// go straight through `ctx.db` and never touch this registry, so they work
// regardless. `getComputersDepsOrNull()` lets `list` degrade gracefully (store rows
// with no live status) instead of throwing when the gateway isn't wired.

/** Structural slice of the computer gateway the computers router reads — connection
 *  status only. Kept structural (not the full `HubComputerGateway`) so transport
 *  stays decoupled from `@slayzone/computer-transport`.
 *
 *  NOTE: structural mirrors of a real interface drift silently (that class of bug
 *  cost four wire-contract fixes in the computer handlers). Keep this a strict
 *  SUBSET of `HubComputerGateway`'s member names/shapes so the real gateway is
 *  always assignable to it. */
export type ComputerGateway = {
  /** Socket-open computers. Says nothing about liveness. */
  listComputers: () => ReadonlyArray<{
    computerId: string
    connectedAt: number
    lastSeenAt: number
  }>
  /** Computers that can actually take work now (open + inside the heartbeat window).
   *  This is what a dispatch decision should read; `listComputers` is for display. */
  listUsableComputers: () => ReadonlyArray<{
    computerId: string
    connectedAt: number
    lastSeenAt: number
  }>
}

export type ComputersDeps = {
  /**
   * Push connection changes to subscribers. Wired in `composition.ts`, where the
   * real gateway and its typed event map are in scope — a structural mirror of a
   * generic `TypedEventEmitter` would have to lie about its types, which is the
   * drift the ComputerGateway note above warns about. Absent = no live updates,
   * which is the fork sidecar's honest state.
   */
  subscribeComputerStatus?: (
    listener: (change: { computerId: string; connected: boolean }) => void
  ) => () => void
  /** Live computer gateway, or null until the async computer init resolves. */
  getGateway: () => ComputerGateway | null
  /** ws(s)://host:port/computers URL a join token embeds for the computer to dial.
   *  Null until the computer listener's port is bound. */
  getHubUrl: () => string | null
  /**
   * The person a join token is minted FOR, by account id or email (T-20,
   * `join-token-policy.ts`). Wired by the hub over hub-auth; consulted only on a hub
   * with login, where a mint without it fails rather than guessing an owner.
   */
  findAccount?: FindJoinTokenAccount
}

let computersDeps: ComputersDeps | null = null

export function setComputersDeps(deps: ComputersDeps): void {
  computersDeps = deps
}

export function getComputersDeps(): ComputersDeps {
  if (!computersDeps)
    throw new Error(
      'computersDeps not initialized — composeServer/server host have not wired it yet'
    )
  return computersDeps
}

/** Non-throwing read for the `list` procedure, which must still return store
 *  rows (with no live connection status) when the gateway isn't wired. */
export function getComputersDepsOrNull(): ComputersDeps | null {
  return computersDeps
}

/**
 * Multi-hub federation: the intrinsic facts a hub reports to a connecting client
 * via `hub.describe`. Both getters degrade to a safe default (login not required,
 * the desktop app's default switches) so the `hub.describe` query works with
 * multi-hub OFF. Deliberately separate from `ComputersDeps` (the computer-facing
 * `/computers` axis) — this is the client-facing `/trpc` axis.
 */
export type HubDescribeDeps = {
  /** Whether this hub enforces bearer auth on `/trpc` connections — the
   *  `SLAYZONE_HUB_REQUIRE_LOGIN` switch. */
  getAuthRequired: () => boolean
  /** Every per-hub switch (`REQUIRE_LOGIN`, `ENABLE_PASSWORD`, `ENABLE_SSO`,
   *  `ENABLE_PROCESSES`, `ENABLE_INTEGRATIONS`), so a client can show or hide what
   *  this hub does not offer. */
  getSwitches: () => HubSwitches
}

let hubDescribeDeps: HubDescribeDeps | null = null

export function setHubDescribeDeps(deps: HubDescribeDeps): void {
  hubDescribeDeps = deps
}

/** Non-throwing read — `hub.describe` returns sane defaults when unwired. */
export function getHubDescribeDepsOrNull(): HubDescribeDeps | null {
  return hubDescribeDeps
}

// The multi-hub auth gate (`setAuthGate` / `getAuthGate`) lives in `@slayzone/trpc-server`
// (`auth-gate.ts`): every gate in the procedure chain reads it.
