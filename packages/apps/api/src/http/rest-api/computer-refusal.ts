import type { Response } from 'express'
import { COMPUTER_REFUSED, isComputerRefusal } from '@slayzone/platform/path-scope'

/**
 * REST shape of a computer's refusal by its own policy — its path jail refused a
 * folder (T-27, B3): 409 `{ ok: false, error, code: 'COMPUTER_REFUSED' }`, the twin
 * of tRPC's CONFLICT + `data.appCode`. A conflict the caller can resolve (pick
 * another folder), not a server fault. The hub gateway already audited it.
 *
 * Returns whether `err` was such a refusal (and so the response is sent); a route's
 * catch answers anything else as before.
 */
export function respondComputerRefusal(res: Response, err: unknown): boolean {
  if (!isComputerRefusal(err)) return false
  res.status(409).json({ ok: false, error: err.message, code: COMPUTER_REFUSED })
  return true
}
