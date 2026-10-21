import type { Response } from 'express'
import {
  assertHubProcessesEnabled,
  isHubSwitchedOffError
} from '@slayzone/platform/hub-switch-refusal'

/**
 * REST shape of a hub-switch refusal (`SLAYZONE_HUB_ENABLE_PROCESSES=0`, …): 403
 * `{ ok: false, error, code }`, the twin of tRPC's FORBIDDEN + `data.appCode`. The
 * refusing chokepoint has already written the audit line.
 *
 * Returns whether `err` was a refusal (and so the response is sent); a route's catch
 * answers anything else as before.
 */
export function respondSwitchRefusal(res: Response, err: unknown): boolean {
  if (!isHubSwitchedOffError(err)) return false
  res.status(403).json({ ok: false, error: err.message, code: err.code })
  return true
}

/**
 * Run a switch assertion up front. Returns `true` when it refused (the 403 is sent
 * and the route must return); rethrows anything that is not a refusal.
 */
export function refusedBySwitch(res: Response, assert: () => void): boolean {
  try {
    assert()
    return false
  } catch (err) {
    if (respondSwitchRefusal(res, err)) return true
    throw err
  }
}

/**
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` for a `/api/processes` route: the hub has no
 * process of its own to list, follow or kill. `true` = refused and answered.
 */
export function refusedHubProcesses(res: Response, op: string): boolean {
  return refusedBySwitch(res, () => assertHubProcessesEnabled('hub.process.spawn', { op }))
}
