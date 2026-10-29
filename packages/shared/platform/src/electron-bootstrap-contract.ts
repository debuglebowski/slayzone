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
import type { LocalComputerStatus } from './local-computer-status'

export interface ElectronBootstrapApp {
  getServerUrl: () => Promise<{ mode: 'local' | 'remote'; url: string }>
  /** Pre-boot config the renderer can't get from the settings DB (multi-hub). */
  getBootConfig: () => Promise<{ multiHub: boolean }>
  /** Resolved multi-hub registry (local always first + present when multiHub on;
   *  the local hub's `url` is injected from the live sidecar port). */
  getHubRegistry: () => Promise<{ hubs: HubEntry[]; defaultHubId: string }>
  /** Per-hub bearer tokens (hubId → token), safeStorage-decrypted in main.
   *  Threaded into the tRPC client's connectionParams for authed remote hubs. */
  getHubTokens: () => Promise<Record<string, string>>
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
  restartSidecar: () => Promise<{ ok: boolean; error?: string }>
  /** Cycle the co-located computer, or start it if it never came up. Stops every
   *  agent pty on this machine — they are all children of that process. */
  restartLocalComputer: () => Promise<{ ok: boolean; error?: string }>
  /** Null when this host supervises no local computer (remote mode). */
  getLocalComputerStatus: () => Promise<LocalComputerStatus | null>
  isPlaywright: boolean
  dataReady: () => void
  bootMark: (label: string) => void
}

export interface ElectronBootstrapFiles {
  getDropPaths: () => string[]
  getPastePaths: () => string[]
}

/** The whole `window.api` surface. `@slayzone/types`' `ElectronAPI` extends it. */
export interface ElectronBootstrapAPI {
  app: ElectronBootstrapApp
  files: ElectronBootstrapFiles
}
