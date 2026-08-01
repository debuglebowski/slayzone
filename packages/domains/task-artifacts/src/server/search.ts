import { getEffectiveRenderMode, isBinaryRenderMode } from '@slayzone/task/shared'
import type { RenderMode } from '@slayzone/task/shared'
import { BlobStore } from './blob-store'
import type { DbLike } from './db'
import { getCurrentVersion } from './resolve'
import { readVersionContent } from './mutations'

/**
 * Artifact title + content search.
 *
 * Lifted verbatim (semantics, wording, limits) out of `slay tasks artifacts
 * search`, which used to open the SQLite file and the blob store directly. It
 * has to live server-side: the scan reads every in-scope artifact's CURRENT
 * VERSION out of the content-addressed blob store, which only the host holding
 * that store can do — a CLI on another machine cannot.
 *
 * Synchronous (`DbLike` + `BlobStore`) because that is what the version helpers
 * take, so this runs inside the DB worker as a named txn — one round trip for
 * the whole scan instead of N per-artifact reads across the worker boundary.
 */

export interface SearchMatcher {
  test: (s: string) => boolean
}

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

/** An artifact whose CURRENT version exceeded {@link MAX_SCAN_BYTES}. */
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

export interface ArtifactSearchOptions {
  query: string
  /** null = every task (the CLI's `--all-tasks`). */
  taskId?: string | null
  folderId?: string | null
  titlesOnly?: boolean
  contentOnly?: boolean
  regex?: boolean
  caseSensitive?: boolean
  limit?: number
  maxMatches?: number
}

/** A content scan above this many bytes is skipped rather than read. */
export const MAX_SCAN_BYTES = 5_000_000
/** Snippets longer than this are truncated with an ellipsis. */
export const SNIPPET_MAX = 200

/** Thrown for an uncompilable `--regex` pattern; the caller maps it to a 400. */
export class InvalidSearchRegexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSearchRegexError'
  }
}

export function compileMatcher(
  query: string,
  opts: { regex?: boolean; caseSensitive?: boolean }
): SearchMatcher {
  if (opts.regex) {
    let re: RegExp
    try {
      re = new RegExp(query, opts.caseSensitive ? '' : 'i')
    } catch (e) {
      throw new InvalidSearchRegexError((e as Error).message)
    }
    return { test: (s) => re.test(s) }
  }
  if (opts.caseSensitive) {
    return { test: (s) => s.includes(query) }
  }
  const q = query.toLowerCase()
  return { test: (s) => s.toLowerCase().includes(q) }
}

/** Tabs/control chars → spaces, then truncate. Keeps a snippet single-line. */
export function sanitizeSnippet(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\t\x00-\x08\x0b-\x1f\x7f]/g, ' ')
  return cleaned.length > SNIPPET_MAX ? cleaned.slice(0, SNIPPET_MAX) + '…' : cleaned
}

export function scanContentForMatches(
  content: string,
  matcher: SearchMatcher,
  maxMatches: number
): ArtifactSearchMatch[] {
  const lines = content.split('\n')
  const out: ArtifactSearchMatch[] = []
  for (let i = 0; i < lines.length; i++) {
    if (matcher.test(lines[i])) {
      out.push({
        type: 'content',
        line: i + 1,
        snippet: sanitizeSnippet(lines[i]),
        contextBefore: i > 0 ? sanitizeSnippet(lines[i - 1]) : null,
        contextAfter: i + 1 < lines.length ? sanitizeSnippet(lines[i + 1]) : null
      })
      if (out.length >= maxMatches) break
    }
  }
  return out
}

interface ArtifactScanRow {
  id: string
  task_id: string
  title: string
  render_mode: string | null
}

/**
 * Scan artifact titles + current-version content.
 *
 * `taskId`/`folderId` are already-resolved FULL ids (the route expands prefixes
 * before calling), so this never re-implements id resolution.
 */
export function searchArtifacts(
  db: DbLike,
  blobStore: BlobStore,
  opts: ArtifactSearchOptions
): ArtifactSearchReport {
  const matcher = compileMatcher(opts.query, opts)
  const limit = opts.limit ?? 50
  const maxMatches = opts.maxMatches ?? 20

  const sqlParts = ['SELECT * FROM task_artifacts WHERE 1=1']
  const params: unknown[] = []
  if (opts.taskId) {
    sqlParts.push('AND task_id = ?')
    params.push(opts.taskId)
  }
  if (opts.folderId) {
    sqlParts.push('AND folder_id = ?')
    params.push(opts.folderId)
  }
  sqlParts.push('ORDER BY updated_at DESC')
  const artifacts = db.prepare(sqlParts.join(' ')).all(...params) as ArtifactScanRow[]

  const results: ArtifactSearchResult[] = []
  const skippedLarge: SkippedLargeArtifact[] = []
  let truncated = false

  for (const a of artifacts) {
    const matches: ArtifactSearchMatch[] = []
    if (!opts.contentOnly && matcher.test(a.title)) {
      matches.push({ type: 'title', snippet: sanitizeSnippet(a.title) })
    }
    if (!opts.titlesOnly) {
      const mode = getEffectiveRenderMode(a.title, a.render_mode as RenderMode | null)
      if (!isBinaryRenderMode(mode)) {
        const content = loadArtifactContent(db, blobStore, a, skippedLarge)
        if (content != null) {
          matches.push(...scanContentForMatches(content, matcher, maxMatches))
        }
      }
    }
    if (matches.length > 0) {
      results.push({ artifactId: a.id, taskId: a.task_id, title: a.title, matches })
      if (results.length >= limit) {
        truncated = artifacts.length > results.length
        break
      }
    }
  }

  return { results, scannedCount: artifacts.length, truncated, skippedLarge }
}

/**
 * The current version's bytes as text, or null when there is nothing scannable
 * (no version, oversized, or an unreadable/missing blob — all non-fatal, as in
 * the CLI: one broken artifact must not fail the whole search).
 */
function loadArtifactContent(
  db: DbLike,
  blobStore: BlobStore,
  artifact: ArtifactScanRow,
  skippedLarge: SkippedLargeArtifact[]
): string | null {
  const version = getCurrentVersion(db, artifact.id)
  if (!version) return null
  if (version.size > MAX_SCAN_BYTES) {
    skippedLarge.push({ label: artifact.title, size: version.size })
    return null
  }
  try {
    return readVersionContent(blobStore, version).toString('utf-8')
  } catch {
    return null
  }
}
