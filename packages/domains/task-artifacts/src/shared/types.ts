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
