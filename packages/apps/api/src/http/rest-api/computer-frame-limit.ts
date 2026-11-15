import type { ErrorRequestHandler, Response } from 'express'
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
  // Once a response has started (a stream), there is no status left to give it.
  if (!isComputerFrameTooLarge(err) || res.headersSent) return false
  res.status(413).json({ ok: false, error: err.message, code: COMPUTER_FRAME_TOO_LARGE })
  return true
}

/**
 * The REST app's last error handler: a route with no catch of its own (Express 5
 * hands its rejected promise here) answers a refused oversized frame as the 413
 * above. Everything else goes on to Express's default handler, unchanged.
 */
export const computerErrorMiddleware: ErrorRequestHandler = (err, _req, res, next) => {
  if (respondFrameTooLarge(res, err)) return
  next(err)
}
