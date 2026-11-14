import type { Response } from 'express'
import {
  COMPUTER_FRAME_TOO_LARGE,
  isComputerFrameTooLarge
} from '@slayzone/platform/computer-frame-limit'

/**
 * REST shape of a frame over the computer link limit (`frameTooLarge`: a computer's
 * reply, or the hub's request, refused before sending so the connection survived):
 * 413 `{ ok: false, error, code: 'COMPUTER_FRAME_TOO_LARGE' }`, the twin of tRPC's
 * PAYLOAD_TOO_LARGE + `data.appCode`. The message names the method and both sizes.
 *
 * Returns whether `err` was one (and so the response is sent); a route's catch
 * answers anything else as before.
 */
export function respondFrameTooLarge(res: Response, err: unknown): boolean {
  if (!isComputerFrameTooLarge(err)) return false
  res.status(413).json({ ok: false, error: err.message, code: COMPUTER_FRAME_TOO_LARGE })
  return true
}
