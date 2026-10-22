import type { Response } from 'express'
import { isUnsafePathError } from '@slayzone/platform/safe-path'

/**
 * REST shape of an id refused as a path segment (T-104, `@slayzone/platform/safe-path`):
 * 400 `{ ok: false, error, code }` with `code` `INVALID_ID` / `PATH_OUTSIDE_BASE`, the
 * twin of tRPC's BAD_REQUEST + `data.appCode`. The refusal already wrote the audit line.
 *
 * Returns whether `err` was such a refusal (and so the response is sent); a route's
 * catch answers anything else as before.
 */
export function respondUnsafePath(res: Response, err: unknown): boolean {
  if (!isUnsafePathError(err)) return false
  res.status(400).json({ ok: false, error: err.message, code: err.code })
  return true
}
