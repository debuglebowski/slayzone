import type { ElectronClientHost } from './client-host'
import type { DeviceViewport } from './preview-devices'
/**
 * The bootstrap-only `window.api` preload contract: the few calls the renderer
 * needs before (or outside) the tRPC connection. Domain/backend calls go over
 * tRPC, never here.
 *
 * Single source of truth: `@slayzone/types`' `ElectronAPI` composes these
 * interfaces (the preload implements it), and `@slayzone/transport`'s
 * `electronBootstrap` reads `window.api` through them — so both sides check
 * against exactly the same signatures without transport depending on the
 * domain-aggregating `@slayzone/types`.
 *
 * Lives in platform: it is a two-sided host contract (the preload implements it,
 * transport consumes it), so it sits in the base package both sides depend on.
 *
 * Type-only and dependency-free beyond sibling platform types: the lean
 * `@slayzone/platform/electron-bootstrap-contract` subpath, safe to import
 * from renderer bundles.
 */
import type { HubEntry } from './hub-registry'
import type { LocalComputerHubs, LocalComputerStatus } from './local-computer-status'

/** One artifact export, rendered by the host the user is on (see `exportArtifact`). */
export interface ArtifactExportRequest {
  format: 'pdf' | 'png' | 'html'
  /** The artifact's text, already read by the client. */
  content: string
  /** Its effective render mode (`getEffectiveRenderMode`). */
  mode: string
  title: string
}

/** Saving on this device. `canceled`: the person dismissed the dialog — not an error. */
export type HostSaveResult =
  | { ok: true }
  | { ok: false; canceled: true }
  | { ok: false; error: string }

export type ArtifactExportResult = HostSaveResult

/**
 * Where a download is saved on THIS device, written in pieces (see `saveTargetOpen`):
 * a download streams through, so its size never has to fit in one message or in
 * memory.
 *  - `file`: one file, under a name the person confirms.
 *  - `directory`: a tree of files, inside a directory the person picks (the web shell,
 *    which cannot write into a folder, saves it as `<folderName>.zip`).
 *  - `zip`: one archive of the files written.
 */
export type SaveTargetRequest =
  | { kind: 'file'; fileName: string; title: string; reveal?: boolean }
  | { kind: 'directory'; folderName: string; title: string }
  | { kind: 'zip'; fileName: string; title: string; reveal?: boolean }

export type SaveTargetOpenResult =
  | { ok: true; targetId: string }
  | { ok: false; canceled: true }
  | { ok: false; error: string }

export interface ElectronBootstrapApp {
  getServerUrl: () => Promise<{ mode: 'local' | 'remote'; url: string }>
  /** Pre-boot config the renderer can't get from the settings DB (multi-hub), plus
   *  `convexUrl`: the Convex deployment the host decided at boot for this renderer
   *  ('' = Convex off). Absent = the host decides none; the renderer uses its own
   *  build-time `VITE_CONVEX_URL`. */
  getBootConfig: () => Promise<{ multiHub: boolean; convexUrl?: string }>
  /** Resolved multi-hub registry (local always first + present when multiHub on;
   *  the local hub's `url` is injected from the live sidecar port). */
  getHubRegistry: () => Promise<{ hubs: HubEntry[]; defaultHubId: string }>
  /** Per-hub bearer tokens (hubId → token), safeStorage-decrypted in main.
   *  Threaded into the tRPC client's connectionParams for authed remote hubs. */
  getHubTokens: () => Promise<Record<string, string>>
  /**
   * Whether the bearer stored for a remote hub still signs in there: `expired` = the
   * hub refused it (sign in again), `unreachable` = no answer, `none` = no bearer.
   */
  checkHubSession: (payload: { hubId: string; url: string }) => Promise<HubSessionState>
  /** Persist (or clear, empty token) a hub's bearer token, safeStorage-encrypted. */
  setHubToken: (payload: { hubId: string; token: string }) => Promise<{ ok: true }>
  /** Sign in to a remote hub (email+password) main-side; stores the bearer token. */
  hubLogin: (payload: {
    hubId: string
    url: string
    email: string
    password: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Entra hub (T-14): ask for a device code and open the hub's approval page in the
   *  system browser (`opened` false = the page is not on the hub's host; show it). */
  hubDeviceLoginStart: (payload: {
    hubId: string
    url: string
  }) => Promise<
    | { ok: true; flowId: string; userCode: string; verificationUri: string; opened: boolean }
    | { ok: false; error: string }
  >
  /** Poll until approved in the browser; stores the bearer token for that hub. */
  hubDeviceLoginWait: (payload: {
    flowId: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Stop waiting (the dialog was closed). */
  hubDeviceLoginCancel: (payload: { flowId: string }) => Promise<{ ok: true }>
  getWindowId: () => Promise<number | null>
  /** App icon badge (dock / taskbar overlay / launcher count). text '' = clear.
   *  overlayPng: PNG data URL drawn by the renderer for the Windows overlay. */
  setAppBadge: (badge: { text: string; count: number; overlayPng: string | null }) => Promise<void>
  /** Work quitting would interrupt (a task moving to another hub): quitting asks first,
   *  naming `message`. null = nothing to guard. */
  setQuitGuard: (guard: { message: string } | null) => Promise<void>
  relaunch: () => Promise<void>
  setBootSettings: (payload: {
    server_mode?: 'local' | 'remote'
    remote_server_url?: string
    multi_hub?: boolean
    hubs?: HubEntry[]
    default_hub_id?: string
  }) => Promise<{ ok: true }>
  probeServerHealth: (url: string) => Promise<{
    ok: boolean
    normalizedUrl?: string
    error?: string
    /** Whether the probed hub gates its client API on a bearer token.
     *  Undefined = the hub is too old to report it (treat as unknown). */
    authRequired?: boolean
    /** How the hub signs people in (`/health` switches). Undefined on an older hub. */
    signIn?: { sso: boolean; password: boolean }
  }>
  /**
   * Direct link (docs/direct-link.md): may this document open a socket to a
   * computer's listener at `address`, issued by hub `hubId`, now — confirmed by
   * that hub, allowed by the document's CSP, and reached by the main process's HTTP
   * probe? `hubId` is a registry id, or `DIRECT_LINK_DEFAULT_HUB_ID`
   * (`@slayzone/platform/direct-link`) outside a hub scope. Optional: an older or
   * non-Electron host has none.
   */
  /**
   * The floating global agent window could not boot (no server url / hub list): the
   * host expands it, if collapsed, so the failure it shows fits. Optional: only the
   * desktop app has that window.
   */
  floatingAgentBootFailed?: () => Promise<void>
  prepareDirectLink?: (
    address: string,
    hubId: string
  ) => Promise<
    { ok: true } | { ok: false; reason: 'invalid' | 'not-issued' | 'csp' | 'unreachable' }
  >
  /**
   * Render an artifact to PDF/PNG/HTML and save it where the person picks — on THIS
   * device, never the hub's, so it works the same against a local or a remote hub.
   * Desktop renders in an offscreen window; the web shell prints through the browser.
   * Optional: a host without it reports export as unsupported.
   */
  exportArtifact?: (request: ArtifactExportRequest) => Promise<ArtifactExportResult>
  /** Emulate a device on a guest owned by this window, then load its HTML artifact. */
  configureArtifactDevicePreview?: (
    webContentsId: number,
    url: string,
    viewport: DeviceViewport
  ) => Promise<boolean>
  /**
   * Save a download on THIS device in pieces: open (asks where), then write each
   * file's bytes in order, then close. Optional, like `exportArtifact`.
   */
  saveTargetOpen?: (request: SaveTargetRequest) => Promise<SaveTargetOpenResult>
  /**
   * Append `data` to the file at `path` (`/`-separated, relative; `''` for a `file`
   * target). Writing a new path finishes the previous file and starts this one.
   * `size`: the file's TOTAL byte length, the same on every write of the file; read
   * when the file starts. A zip lays the entry out by it before its first byte (4 GiB
   * or more: zip64 from the local header on). Undefined = unknown: the host lays the
   * entry out for any size.
   */
  saveTargetWrite?: (
    targetId: string,
    path: string,
    data: Uint8Array,
    size?: number
  ) => Promise<void>
  /** Create a (possibly empty) folder at `path`. */
  saveTargetMkdir?: (targetId: string, path: string) => Promise<void>
  /** Finish: everything written is saved (and revealed, when asked). */
  saveTargetClose?: (targetId: string) => Promise<HostSaveResult>
  /** Give up: nothing partial is left behind. */
  saveTargetAbort?: (targetId: string) => Promise<void>
  restartSidecar: () => Promise<{ ok: boolean; error?: string }>
  /** Cycle the co-located computer, or start it if it never came up. Stops every
   *  agent pty on this machine — they are all children of that process. */
  restartLocalComputer: () => Promise<{ ok: boolean; error?: string }>
  /** Null when this host supervises no local computer (remote mode). */
  getLocalComputerStatus: () => Promise<LocalComputerStatus | null>
  /** Where this app's own computer stands on each remote hub (it joins all of them). */
  getLocalComputerHubs: () => Promise<LocalComputerHubs>
  isPlaywright: boolean
  dataReady: () => void
  bootMark: (label: string) => void
}

/** {@link ElectronBootstrapAPI.checkHubSession}'s answer. */
export type HubSessionState =
  | { state: 'valid'; email: string | null }
  | { state: 'expired' }
  | { state: 'unreachable' }
  | { state: 'none' }

export interface ElectronBootstrapFiles {
  getDropPaths: () => string[]
  getPastePaths: () => string[]
}

/**
 * The client-local browser host — the process on THIS device that owns the browser
 * panel's web views (Electron main). A client-local host capability, not a domain
 * API: the panel drives its own device's views and never asks the hub.
 *
 * Deliberately generic: `@slayzone/task-browser/shared`'s `BrowserHostMethods` /
 * `BrowserHostEvents` are the typed contract both ends check against.
 */
export interface ElectronBrowserHost {
  /** One `BrowserHostMethods` call. */
  invoke: (method: string, args: unknown[]) => Promise<unknown>
  /** Every host event. The first listener subscribes this renderer; it then gets one
   *  `event` (`state-snapshot`) per live view before live events. */
  on: (listener: (event: string, payload: unknown) => void) => () => void
}

/** The whole `window.api` surface. `@slayzone/types`' `ElectronAPI` extends it. */
export interface ElectronBootstrapAPI {
  app: ElectronBootstrapApp
  files: ElectronBootstrapFiles
  /** Absent where this device hosts no web views (web shell, a partial host). */
  browserHost?: ElectronBrowserHost
  /**
   * This device's client host (`@slayzone/platform/client-host`): Electron main over
   * IPC, `localStorage` in the web shell, the Mojo KV in the chromium shell.
   */
  clientHost?: ElectronClientHost
}
