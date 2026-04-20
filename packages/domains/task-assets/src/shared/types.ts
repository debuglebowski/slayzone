declare const BrandSymbol: unique symbol

export type Brand<T, B> = T & { readonly [BrandSymbol]: B }

export type AssetId = Brand<string, 'AssetId'>
export type VersionId = Brand<string, 'VersionId'>
export type ContentHash = Brand<string, 'ContentHash'>

export interface AssetVersion {
  id: VersionId
  asset_id: AssetId
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
  | { kind: 'binary'; a: { hash: ContentHash; size: number }; b: { hash: ContentHash; size: number } }

export interface PruneOptions {
  keepLast?: number
  keepNamed?: boolean
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
  perAsset: { asset_id: AssetId; bytes: number; versions: number }[]
}

export interface IntegrityIssue {
  asset_id: AssetId
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
  current: AssetId | null
}

export type SeedProgressCallback = (p: SeedProgress) => void

export interface SeedReport {
  seeded: number
  skippedMissing: number
}
