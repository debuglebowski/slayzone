/**
 * Artifact search across every signed-in hub: titles and the text of each artifact's
 * current version, the hub's own search (`GET /api/artifacts/search`, what
 * `slay tasks artifacts search` uses). One request per hub, all at once; the merged
 * results keep the hubs in the order given (sign-in order) and each hub's own order
 * (most recently updated first), every result tagged with its hub — which is also the
 * hub any follow-up about it goes to. A hub that fails says why; the others' results
 * stay. Global search (wave 2) builds on this.
 */
import type {
  ArtifactSearchReport,
  ArtifactSearchResult,
  SkippedLargeArtifact
} from '@slayzone/task-artifacts/shared'
import { HubRestError, type HubFetch, type HubTarget, hubJson } from './hub-rest'

export interface ArtifactSearchQuery {
  /** What to find (required, non-blank). */
  q: string
  /** One task's artifacts only (a task lives on one hub); absent = every task. */
  taskId?: string
  titlesOnly?: boolean
  contentOnly?: boolean
  /** `q` is a regular expression (JavaScript syntax, run on the hub). */
  regex?: boolean
  caseSensitive?: boolean
  /** Most artifacts per hub (hub default 50). */
  limit?: number
  /** Most matching lines per artifact (hub default 20). */
  maxMatches?: number
}

/** One result, tagged with the hub it came from. */
export interface HubArtifactSearchResult extends ArtifactSearchResult {
  /** Unique across hubs. */
  key: string
  hubId: string
  hubLabel: string
}

/** How one hub's search went. */
export type HubSearchOutcome =
  | {
      hubId: string
      hubLabel: string
      ok: true
      scannedCount: number
      /** The hub had more matches than `limit`. */
      truncated: boolean
      /** Versions too large to scan (the hub's 5 MB limit). */
      skippedLarge: SkippedLargeArtifact[]
    }
  | { hubId: string; hubLabel: string; ok: false; error: string; code: string | null }

export interface ArtifactSearchOutcome {
  results: HubArtifactSearchResult[]
  /** One per hub asked, in the same order. */
  hubs: HubSearchOutcome[]
}

/**
 * The route's query string. The hub reads a flag as on whenever it is PRESENT
 * (`regex=false` would turn regex on), so a flag is sent only when it is on.
 */
export function artifactSearchQuery(query: ArtifactSearchQuery): Record<string, string | true> {
  const params: Record<string, string | true> = { q: query.q }
  if (query.taskId) params.taskId = query.taskId
  else params.allTasks = true
  if (query.titlesOnly) params.titlesOnly = true
  if (query.contentOnly) params.contentOnly = true
  if (query.regex) params.regex = true
  if (query.caseSensitive) params.caseSensitive = true
  if (query.limit !== undefined) params.limit = String(query.limit)
  if (query.maxMatches !== undefined) params.maxMatches = String(query.maxMatches)
  return params
}

export async function searchArtifacts(
  targets: readonly HubTarget[],
  query: ArtifactSearchQuery,
  options: { fetch?: HubFetch; signal?: AbortSignal } = {}
): Promise<ArtifactSearchOutcome> {
  if (!query.q.trim()) throw new Error('Type something to search for')
  const params = artifactSearchQuery(query)
  const settled = await Promise.allSettled(
    targets.map((target) =>
      hubJson<ArtifactSearchReport>(target, '/api/artifacts/search', {
        query: params,
        fetch: options.fetch,
        signal: options.signal
      })
    )
  )
  const results: HubArtifactSearchResult[] = []
  const hubs = settled.map((outcome, i): HubSearchOutcome => {
    const { hubId, label: hubLabel } = targets[i]
    if (outcome.status === 'rejected') {
      const err = outcome.reason
      return {
        hubId,
        hubLabel,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof HubRestError ? err.code : null
      }
    }
    const report = outcome.value
    for (const result of report.results) {
      results.push({ ...result, key: `${hubId}\n${result.artifactId}`, hubId, hubLabel })
    }
    return {
      hubId,
      hubLabel,
      ok: true,
      scannedCount: report.scannedCount,
      truncated: report.truncated,
      skippedLarge: report.skippedLarge
    }
  })
  return { results, hubs }
}
