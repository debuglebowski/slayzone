/**
 * Computer contracts for the hub/computer split. Row shapes mirror the v149 schema
 * (snake_case columns), matching the store's SELECT * reads.
 */

// The local-computer identity constant now lives on the lean
// `@slayzone/platform/slayzone-config` subpath (so the computer bundle can read it
// without the heavy server graph). Re-exported here for existing consumers.
export { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/platform/slayzone-config'

/**
 * Row in `computers` — one enrolled computer (a machine/process that can host
 * task work). `revoked_at` NULL = active.
 */
export interface ComputerRecord {
  id: string
  name: string
  platform: string
  version: string
  /** JSON object describing what the computer can do (modes, arch, ...). */
  capabilities_json: string
  /** Key id the computer authenticates with after enrollment. NULL until issued. */
  auth_key_id: string | null
  /** Last heartbeat, epoch ms. NULL until first seen. */
  last_seen_at: number | null
  created_at: number
  revoked_at: number | null
  /** Which physical box this computer is on (v164). NULL = ungrouped — either a
   *  computer too old to report one, or one whose host id could not be resolved.
   *  A MUTABLE attribute: never store it, never key anything off it. */
  host_id?: string | null
  /** SlayZone user who owns this computer (v161). NULL = unclaimed. */
  owner_user_id?: string | null
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
  /** Computer that eventually enrolled with this token. */
  computer_id: string | null
  /** User who minted it; becomes that computer's owner at enroll. NULL = unowned. */
  minted_by_user_id?: string | null
}
