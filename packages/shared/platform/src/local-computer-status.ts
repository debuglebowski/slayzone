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
