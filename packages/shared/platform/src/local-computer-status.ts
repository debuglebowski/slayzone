/**
 * Why the desktop app's own supervised computer is (not) connected — Settings →
 * Computers' "Not running" row. The hub only sees that it never enrolled; the
 * cause (it crashes at startup, its join token could not be minted) lives with
 * the supervisor in the main process.
 *
 * Lives here, not in `@slayzone/computers`: `@slayzone/transport` (below every
 * domain) and the preload contract (`./electron-bootstrap-contract`) both need it.
 *
 * Type-only and dependency-free: also the lean
 * `@slayzone/platform/local-computer-status` subpath, safe to import from
 * renderer bundles.
 */
/**
 * Where the desktop app's own computer stands on one REMOTE hub (it joins every hub
 * the client lists). Keyed by hub id in {@link LocalComputerHubs}.
 */
export interface LocalComputerHubStatus {
  /** `joining`: told to connect, not yet in. `joined`: connected now. `offline`: joined
   *  before, not connected now. `failed`: see `error` (e.g. not signed in there). */
  state: 'joining' | 'joined' | 'offline' | 'failed'
  /** Its computer id on that hub, once it has enrolled there. */
  computerId: string | null
  error: string | null
}

/** Per remote hub id. Empty when the app supervises no computer (remote mode). */
export type LocalComputerHubs = Record<string, LocalComputerHubStatus>

export interface LocalComputerStatus {
  /** A computer process is alive right now. */
  running: boolean
  /** Supervision gave up (only a manual start recovers); null while running or retrying. */
  stalled: 'backoff-exhausted' | 'needs-re-enrollment' | null
  /** Its most recent unrequested exit; `reason` is the dying output's error line. */
  lastExit: { code: number | null; signal: string | null; at: number; reason: string } | null
  /** Set when it was never spawned at all. */
  unspawnedReason: string | null
}
