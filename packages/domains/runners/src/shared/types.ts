/**
 * Fleet contracts for the hub/runner split. Row shapes mirror the v149 schema
 * (snake_case columns), matching the store's SELECT * reads.
 */

/**
 * Name of the co-located ("local") auto-spawned runner (Wave3.5-D5). This is the
 * SINGLE source of truth shared by BOTH sides of the local-runner dedup so they
 * can never silently diverge:
 *   - the Electron MAIN process injects it as `SLAYZONE_RUNNER_NAME` into the
 *     runner child (its enroll `name`), and
 *   - the sidecar composition passes it as `localRunnerName` to the fleet-auth
 *     adapters (which treat an enroll for THIS name as the local runner → gets a
 *     deterministic id + UPSERT + duplicate collapse).
 * If these two ever disagree the dedup silently disables (every local enroll
 * takes the remote fresh-uuid path → an orphan per boot), so both read this const
 * (each still honors an explicit `SLAYZONE_RUNNER_NAME` override — but the SAME
 * env var feeds both sides, so an override stays consistent too).
 */
export const DEFAULT_LOCAL_RUNNER_NAME = 'local-runner'

/** Lifecycle of a runner's checkout of a project. */
export type RunnerCheckoutStatus = 'pending' | 'cloning' | 'ready' | 'error'

/**
 * Row in `runners` — one enrolled runner (a machine/process that can host
 * task work). `revoked_at` NULL = active.
 */
export interface RunnerRecord {
  id: string
  name: string
  platform: string
  version: string
  /** JSON object describing what the runner can do (modes, arch, ...). */
  capabilities_json: string
  /** Key id the runner authenticates with after enrollment. NULL until issued. */
  auth_key_id: string | null
  /** Last heartbeat, epoch ms. NULL until first seen. */
  last_seen_at: number | null
  created_at: number
  revoked_at: number | null
}

/**
 * Row in `join_tokens` — a single-use enrollment token. Only `sha256(token)`
 * is at rest; the plaintext token is shown once at mint and never stored.
 */
export interface JoinToken {
  id: string
  token_hash: string
  label: string
  created_at: number
  expires_at: number
  /** Consumption marker: NULL = unclaimed, set exactly once by verify. */
  used_at: number | null
  /** Runner that eventually enrolled with this token. */
  runner_id: string | null
}

/** Row in `runner_project_checkouts` — where a runner has a project checked out. */
export interface RunnerProjectCheckout {
  runner_id: string
  project_id: string
  root_path: string
  status: RunnerCheckoutStatus
  updated_at: number
}
