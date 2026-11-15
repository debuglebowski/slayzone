declare const BrandSymbol: unique symbol

export type Brand<T, B> = T & { readonly [BrandSymbol]: B }

export type ArtifactId = Brand<string, 'ArtifactId'>
export type VersionId = Brand<string, 'VersionId'>
export type ContentHash = Brand<string, 'ContentHash'>

export interface ArtifactVersion {
  id: VersionId
  artifact_id: ArtifactId
  version_num: number
  content_hash: ContentHash
  size: number
  name: string | null
  author_type: 'user' | 'agent' | null
  author_id: string | null
  created_at: string
  parent_id: VersionId | null
}

export type VersionRef = number | string

export interface DiffHunkLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

export interface DiffHunk {
  lines: DiffHunkLine[]
}

export type DiffResult =
  | { kind: 'text'; hunks: DiffHunk[] }
  | {
      kind: 'binary'
      a: { hash: ContentHash; size: number }
      b: { hash: ContentHash; size: number }
    }

export interface PruneOptions {
  keepLast?: number
  keepNamed?: boolean
  /** Protect the current (HEAD) version from deletion. Default true. */
  keepCurrent?: boolean
  dryRun?: boolean
}

export interface PruneReport {
  deletedVersions: number
  deletedBlobs: number
  keptNamed: number
}

export interface AuthorContext {
  type: 'user' | 'agent' | null
  id: string | null
}

export interface StorageStats {
  totalBlobs: number
  totalBytes: number
  perArtifact: { artifact_id: ArtifactId; bytes: number; versions: number }[]
}

export interface IntegrityIssue {
  artifact_id: ArtifactId
  version_id: VersionId
  version_num: number
  content_hash: ContentHash
  problem: 'blob_missing' | 'hash_mismatch' | 'size_mismatch'
}

export interface IntegrityReport {
  checked: number
  issues: IntegrityIssue[]
}

export interface SeedProgress {
  total: number
  done: number
  current: ArtifactId | null
}

export type SeedProgressCallback = (p: SeedProgress) => void

export interface SeedReport {
  seeded: number
  skippedMissing: number
}

// --- Search (`GET /api/artifacts/search`, `searchArtifacts` in ../server/search.ts) ---

export interface ArtifactSearchMatch {
  type: 'title' | 'content'
  line?: number
  snippet: string
  contextBefore?: string | null
  contextAfter?: string | null
}

export interface ArtifactSearchResult {
  artifactId: string
  taskId: string
  title: string
  matches: ArtifactSearchMatch[]
  /** Backend modification time used for stable merged search ordering. */
  updatedAt?: string
}

/** An artifact whose CURRENT version exceeded the scan limit (`MAX_SCAN_BYTES`, server). */
export interface SkippedLargeArtifact {
  /** The artifact title — what the CLI's stderr notice names. */
  label: string
  size: number
}

export interface ArtifactSearchReport {
  results: ArtifactSearchResult[]
  /** Size of the addressable set, i.e. the CLI footer's "Scanned N artifacts". */
  scannedCount: number
  /** `limit` was hit AND there were more candidates behind it. */
  truncated: boolean
  skippedLarge: SkippedLargeArtifact[]
}

/** One entry of a zip artifact's listing (`artifacts.listArchive`). */
export interface ArchiveEntry {
  /** Path inside the archive, `/`-separated; a folder ends in `/`. */
  path: string
  isDirectory: boolean
  /** Uncompressed bytes. */
  size: number
  compressedSize: number
  /** `YYYY-MM-DDTHH:MM:SS` as stored (zip keeps no time zone); null when unset. */
  modified: string | null
  encrypted: boolean
}

/** A zip artifact's entries, capped; the totals count every entry. */
export interface ArchiveListing {
  entries: ArchiveEntry[]
  totalEntries: number
  /** Sum of every entry's uncompressed size. */
  totalSize: number
}

/**
 * Which bytes of an artifact a ranged read covers — each chosen exactly as the
 * whole read it pages: `bytes` = `readArtifactBytes` (the working file, else the
 * current version), `content` = `readArtifactContent` (the working file, its legacy
 * path, else the current version, else nothing), `version` = a version REF as
 * `resolveArtifactVersion` resolves it, `currentVersion` = a diff's default side.
 */
export type ArtifactReadSpec =
  | { kind: 'bytes' }
  | { kind: 'content' }
  | { kind: 'version'; ref: VersionRef }
  | { kind: 'currentVersion' }

/** Where a {@link ArtifactReadSpec}'s bytes are (nothing read). */
export type ArtifactReadSource =
  | { kind: 'file'; path: string }
  | { kind: 'blob'; path: string; version: ArtifactVersion }
  /** `content` of an artifact with no file and no version: '' */
  | { kind: 'empty' }
  /** `content` of no artifact: null */
  | { kind: 'missing' }
