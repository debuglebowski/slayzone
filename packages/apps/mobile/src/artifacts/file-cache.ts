/**
 * An artifact's bytes as a local file (platform-free; the device's file store and the
 * app's entry points are in `files.ts`): images and PDFs are shown from it, and Share hands
 * it to the iOS share sheet. Downloaded from the owning hub's REST API with its bearer
 * (`GET /api/artifacts/:id/content`, the working copy desktop shows; a version:
 * `…/versions/content?ref=N`), streamed to disk by the OS, never through JS.
 *
 * Kept in the caches directory (the OS may purge it) per hub and artifact, under a stamp
 * that changes whenever the content may have — the row's current version and update
 * time, plus a tick the viewer bumps when the hub says the file changed on disk (a
 * desktop autosave changes neither) — or, for a version, its content hash (immutable).
 * A stamp already on disk is reused; a new one replaces the artifact's older copies.
 *
 *   <caches>/slayzone-artifacts/<hub>/<artifact id>/<stamp>/<title>
 */
import type { TaskArtifact } from '@slayzone/task-contracts'
import {
  authHeaders,
  HubRestError,
  type HubTarget,
  hubApiUrl,
  signInExpired,
  unreachable
} from './hub-rest'

export const ARTIFACT_CACHE_DIR = 'slayzone-artifacts'

/** Where the files live; a directory is a list of path segments under the caches dir. */
export interface ArtifactFileStore {
  /** The URI of `<dir>/<name>` if it is there. */
  find(dir: string[], name: string): string | null
  /** Downloads `url` to `<dir>/<name>` (creating `dir`); its URI. Throws on a non-2xx answer. */
  download(
    url: string,
    headers: Record<string, string>,
    dir: string[],
    name: string
  ): Promise<string>
  /** Deletes everything in `dir` except its child `keep` (null: everything, `dir` too). */
  removeExcept(dir: string[], keep: string | null): void
}

export interface ArtifactFileSource {
  artifact: Pick<TaskArtifact, 'id' | 'title' | 'current_version_id' | 'updated_at'>
  /** One version instead of the working copy: its number and content hash. */
  version?: { ref: number; contentHash: string } | null
  /** Bumped when the hub reports the file changed (`artifacts.onContentChanged`). */
  contentTick?: number
}

/** A path segment from any string: no separators, nothing hidden or empty. */
const segment = (value: string): string => {
  const safe = value.replace(/[/\\:]/g, '_').replace(/^\.+/, '_')
  return safe || '_'
}

/** A file name from a title, keeping what is legal on iOS (only `/` and `:` are not). */
const fileName = (title: string): string => segment(title.replace(/[/:]/g, '_'))

export function artifactFileStamp(source: ArtifactFileSource): string {
  if (source.version) return `v-${segment(source.version.contentHash)}`
  const { current_version_id, updated_at } = source.artifact
  return segment(`w-${current_version_id ?? 'none'}-${updated_at}-${source.contentTick ?? 0}`)
}

/** The status in expo-file-system's download error (`… response has status 404`). */
export function downloadStatusOf(err: unknown): number | null {
  const m = /response has status (\d{3})/.exec(err instanceof Error ? err.message : String(err))
  return m ? Number(m[1]) : null
}

/** Downloads into `store` (the device's: `downloadArtifactFile` in `files.ts`). */
export async function downloadArtifactFileTo(
  store: ArtifactFileStore,
  target: HubTarget,
  source: ArtifactFileSource
): Promise<string> {
  const artifactDir = [ARTIFACT_CACHE_DIR, segment(target.hubId), segment(source.artifact.id)]
  const stamp = artifactFileStamp(source)
  const dir = [...artifactDir, stamp]
  const name = fileName(source.artifact.title)
  const cached = store.find(dir, name)
  if (cached) return cached

  const base = `/api/artifacts/${encodeURIComponent(source.artifact.id)}`
  const urls = source.version
    ? [hubApiUrl(target, `${base}/versions/content`, { ref: source.version.ref })]
    : [
        hubApiUrl(target, `${base}/content`),
        // No working copy on disk (written by `slay artifacts write`): its current version.
        hubApiUrl(target, `${base}/versions/content`, { ref: 'current' })
      ]

  let uri: string | null = null
  let firstError: unknown = null
  for (const url of urls) {
    try {
      uri = await store.download(url, authHeaders(target), dir, name)
      break
    } catch (err) {
      firstError ??= err
      if (downloadStatusOf(err) !== 404) break
    }
  }
  if (uri === null) throw downloadError(target, source, firstError)
  store.removeExcept(artifactDir, stamp)
  return uri
}

function downloadError(target: HubTarget, source: ArtifactFileSource, err: unknown): Error {
  const status = downloadStatusOf(err)
  if (status === 401) return signInExpired(target)
  if (status === null) return unreachable(target, err)
  return new HubRestError(
    `Couldn't download ${source.artifact.title} from ${target.label} (HTTP ${status})`,
    status
  )
}

/** Deletes every file `store` keeps from one hub. */
export function forgetArtifactCacheIn(store: ArtifactFileStore, hubId: string): void {
  store.removeExcept([ARTIFACT_CACHE_DIR, segment(hubId)], null)
}
