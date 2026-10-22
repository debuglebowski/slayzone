/**
 * Ids that become filesystem paths (T-104).
 *
 * A task, project or artifact id is a directory or file NAME under a hub data dir:
 * `<storage>/artifacts/<taskId>/<artifactId><ext>`, `<storage>/project-icons/<projectId>.png`.
 * Joined unchecked, `..` names the data dir itself: `artifacts.cleanupTask('..')` and
 * `task.archiveMany(['..'])` removed it recursively, database included, on any hub
 * without login (every desktop app's own hub) and for any signed-in user elsewhere.
 *
 * Two checks, one module:
 *
 *   - {@link assertPathSafeId}: an id is ONE plain path segment, 1–128 of
 *     `[A-Za-z0-9_-]`. Every id the app makes passes (`randomUUID()`, and the short
 *     ids tests use); `.`/`..`, `/`, `\`, `%2e%2e`, NUL, `:` (a Windows drive) and `''`
 *     cannot.
 *   - {@link containedPath}: the resolved path lies strictly INSIDE its base. Every
 *     write or delete under a data dir goes through it, so a part that is not an id
 *     (a title's extension, a backup filename) cannot leave the base either, and the
 *     base itself is never the target.
 *
 * Both throw {@link UnsafePathError} (a stable `code`) after one `denied` audit line.
 * The transports map it the same way wherever it surfaces: tRPC `BAD_REQUEST` with
 * `data.appCode`, REST 400 `{ ok: false, error, code }`. Nothing is read, written or
 * deleted first.
 *
 * Lean leaf (node:path + security-log only), also the `@slayzone/platform/safe-path`
 * subpath.
 *
 * @module platform/safe-path
 */
import path from 'node:path'
import { securityEvent } from './security-log'

export type UnsafePathCode = 'INVALID_ID' | 'PATH_OUTSIDE_BASE'

const PATH_SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** A path refused because an id was not one plain segment, or it left its base. */
export class UnsafePathError extends Error {
  constructor(
    readonly code: UnsafePathCode,
    message: string
  ) {
    super(message)
    this.name = 'UnsafePathError'
  }
}

/**
 * `instanceof`, plus a structural fallback for an error that crossed a module copy
 * (a bundle can hold two of this class). Matches only our own codes.
 */
export function isUnsafePathError(err: unknown): err is UnsafePathError {
  if (err instanceof UnsafePathError) return true
  if (!(err instanceof Error) || err.name !== 'UnsafePathError') return false
  const code = (err as { code?: unknown }).code
  return code === 'INVALID_ID' || code === 'PATH_OUTSIDE_BASE'
}

function refuse(code: UnsafePathCode, message: string, detail: Record<string, unknown>): never {
  securityEvent({ event: 'hub.path.refused', outcome: 'denied', detail: { ...detail, code } })
  throw new UnsafePathError(code, message)
}

/** True when `value` may be used as one path segment: 1–128 of `[A-Za-z0-9_-]`. */
export function isPathSafeId(value: unknown): value is string {
  return typeof value === 'string' && PATH_SAFE_ID.test(value)
}

/**
 * Return `value` when it may become one path segment; otherwise throw
 * {@link UnsafePathError} (`INVALID_ID`). `kind` names the id in the message and the
 * audit line (`taskId`, `projectId`, …).
 */
export function assertPathSafeId(value: unknown, kind: string): string {
  if (isPathSafeId(value)) return value
  return refuse('INVALID_ID', `Invalid ${kind}: an id is 1-128 letters, digits, '_' or '-'`, {
    kind,
    value: typeof value === 'string' ? JSON.stringify(value) : typeof value
  })
}

/**
 * `path.resolve(base, ...segments)`, refused with {@link UnsafePathError}
 * (`PATH_OUTSIDE_BASE`) unless the result is strictly inside `base`: not `base`
 * itself, not above it, not on another drive. A NUL anywhere is refused too.
 */
export function containedPath(base: string, ...segments: string[]): string {
  const root = path.resolve(base)
  const target = path.resolve(root, ...segments)
  const rel = path.relative(root, target)
  const inside =
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel) &&
    !segments.some((s) => s.includes('\0'))
  if (inside) return target
  return refuse('PATH_OUTSIDE_BASE', 'Refused a path outside its directory', {
    base: path.basename(root),
    value: JSON.stringify(segments.join('/'))
  })
}
