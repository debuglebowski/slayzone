export const MIGRATE_PROTOCOL_VERSION = 1
export const DEFAULT_MAX_CHUNK_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
export const UPLOAD_TTL_MS = 60 * 60 * 1000

export interface ManifestFileEntry {
  /** Path inside the tar archive, e.g. "artifacts/<taskId>/file.md". */
  path: string
  /** Hex sha256 of file contents. */
  sha256: string
  bytes: number
}

export interface ManifestSource {
  hostname: string
  slayzoneVersion: string
  schemaUserVersion: number
  exportedAt: string
}

export interface Manifest {
  protocolVersion: number
  source: ManifestSource
  /** Row counts per table. Server cross-checks after import. */
  tables: Record<string, number>
  files: ManifestFileEntry[]
  /** Sum of all file bytes (manifest excluded; tar overhead excluded). */
  totalContentBytes: number
}

export type MigratePhase =
  | 'preflight'
  | 'uploading'
  | 'verifying-archive'
  | 'unpacking'
  | 'verifying-manifest'
  | 'committing'
  | 'cleaning-up'
  | 'done'
  | 'error'

export interface ProgressEvent {
  uploadId: string
  phase: MigratePhase
  /** 0..1 within the current phase. */
  percent: number
  message: string
}

export interface HealthInfo {
  slayzoneVersion: string
  schemaUserVersion: number
  isEmpty: boolean
  protocolVersion: number
}

export interface PreflightResponse {
  uploadId: string
  maxChunkBytes: number
  maxArchiveBytes: number
}

export interface UploadAppendInput {
  uploadId: string
  seq: number
  /** Base64-encoded chunk. */
  data: string
  /** Hex sha256 of the decoded chunk bytes. */
  sha256: string
}

export interface UploadFinalizeInput {
  uploadId: string
  manifest: Manifest
  archiveSha256: string
  archiveBytes: number
  dryRun: boolean
}

export interface TableCheck {
  expected: number
  actual: number
}

export interface MigrateReceipt {
  ok: boolean
  dryRun: boolean
  files: {
    expected: number
    present: number
    mismatched: string[]
  }
  tables: Record<string, TableCheck>
  worktreeRowsRewritten: number
  durationMs: number
  errors: string[]
}

/** Tables we never copy on commit. */
export const SKIP_TABLES: ReadonlySet<string> = new Set([
  /** Telemetry — written to a separate diagnostics DB elsewhere; if present in the
   *  main DB it is a vestigial leftover from older migrations. */
  'diagnostics_events',
  /** Server-process-local port discovery — destination has its own. */
  /** (settings table itself is migrated; only specific keys are pruned post-import.) */
])

/** Settings keys pruned after import (server-process-local). */
export const PRUNE_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'slayzone_server_port',
  'slayzone_mcp_port',
  'mcp_server_port',
])
