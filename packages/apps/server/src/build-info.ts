/**
 * Build identity of THIS running sidecar (Phase 1 of plans/sidecar-staleness.md).
 *
 * The values are injected at bundle time by esbuild `define` (see build.mjs):
 *   __SLAYZONE_SERVER_COMMIT__   — `git rev-parse --short HEAD` (+ `-dirty`)
 *   __SLAYZONE_SERVER_BUILT_AT__ — ISO timestamp of the build
 * Declared `string | undefined` so the typeof-guard narrows cleanly AND so
 * running the TS source directly (dev / unit tests, no esbuild pass) resolves to
 * the sentinels instead of a ReferenceError.
 *
 * `buildId` (commit@builtAt) is the compiled-in, immutable-for-this-process key
 * the supervisor compares against dist/sidecar-build.json to detect a stale
 * process. The bundle's sha256 lives ONLY in that on-disk manifest — a running
 * process can't hash the code it is actually executing, only the file on disk
 * (which may already have changed), so it is deliberately not compiled in.
 */
declare const __SLAYZONE_SERVER_COMMIT__: string | undefined
declare const __SLAYZONE_SERVER_BUILT_AT__: string | undefined

export type ServerBuildInfo = {
  /** Short git sha of the build, `-dirty` when the tree had uncommitted changes. */
  commit: string
  /** ISO timestamp the bundle was built. */
  builtAt: string
  /** `commit@builtAt` — unique per build; the running-vs-disk staleness key. */
  buildId: string
}

export function getServerBuildInfo(): ServerBuildInfo {
  const commit = typeof __SLAYZONE_SERVER_COMMIT__ === 'string' ? __SLAYZONE_SERVER_COMMIT__ : 'dev'
  const builtAt =
    typeof __SLAYZONE_SERVER_BUILT_AT__ === 'string' ? __SLAYZONE_SERVER_BUILT_AT__ : 'unknown'
  return { commit, builtAt, buildId: `${commit}@${builtAt}` }
}
