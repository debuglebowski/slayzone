/**
 * Runner contracts for the hub/runner split. Row shapes mirror the v149 schema
 * (snake_case columns), matching the store's SELECT * reads.
 */

// The local-runner identity constant now lives on the lean
// `@slayzone/platform/slayzone-config` subpath (so the runner bundle can read it
// without the heavy server graph). Re-exported here for existing consumers.
export { DEFAULT_LOCAL_RUNNER_NAME } from '@slayzone/platform/slayzone-config'

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
