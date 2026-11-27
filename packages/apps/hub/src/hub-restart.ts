import { readFileSync } from 'node:fs'
import { launchdLabel, systemdUnitName } from '@slayzone/platform/service-identity'
import type { HubRespawner } from '@slayzone/types'

/**
 * How a hub restarts itself (decision D2): it stops cleanly and exits with
 * {@link HUB_RESTART_EXIT_CODE}; whatever runs it starts it again. The desktop
 * supervisor treats this code as a planned restart, launchd
 * (`KeepAlive.SuccessfulExit=false`) and systemd (`Restart=on-failure`) restart on
 * any non-zero exit. Nothing is restarted in-process: a fresh process is the only
 * state reset the hub's composition has ever been proven against.
 *
 * The entrypoint (bin.ts) installs the handler. A hub embedded in a test or another
 * process has none: a requested restart then does nothing and the caller is told, so
 * the staged work (a restore) waits for the next start.
 */
export const HUB_RESTART_EXIT_CODE = 75

export type HubRestartReason = 'restore'

let handler: ((reason: HubRestartReason) => void) | null = null

export function setHubRestartHandler(fn: ((reason: HubRestartReason) => void) | null): void {
  handler = fn
}

/** Whether this process can restart itself (an entrypoint installed the handler). */
export function hasHubRestartHandler(): boolean {
  return handler !== null
}

/** True when a handler took the request (the process will exit). */
export function requestHubRestart(reason: HubRestartReason): boolean {
  if (!handler) return false
  handler(reason)
  return true
}

/** Who starts this hub again after it exits: the restart is automatic only then. */
export type { HubRespawner }

/**
 * Exact, never a guess from a variable a terminal also inherits: launchd sets
 * `XPC_SERVICE_NAME` to the job's label (a Terminal shell carries the terminal app's),
 * and systemd places a service in a cgroup named after its unit (`INVOCATION_ID` alone
 * is inherited by anything a systemd-run terminal starts). Both are compared with the
 * names `slay hub install` gives this hub's unit (service-unit.ts).
 */
export function detectHubRespawner(input: {
  supervised: boolean
  name: string
  env: NodeJS.ProcessEnv
  readCgroup?: () => string | null
}): HubRespawner {
  if (input.supervised) return 'desktop'
  let label: string | null = null
  let unit: string | null = null
  try {
    label = launchdLabel('hub', input.name)
    unit = systemdUnitName('hub', input.name)
  } catch {
    return null // a name no unit could have been installed under
  }
  if (input.env.XPC_SERVICE_NAME === label) return 'launchd'
  const cgroup = (input.readCgroup ?? readOwnCgroup)()
  if (cgroup?.split('\n').some((line) => line.endsWith(`/${unit}`))) return 'systemd'
  return null
}

function readOwnCgroup(): string | null {
  if (process.platform !== 'linux') return null
  try {
    return readFileSync('/proc/self/cgroup', 'utf8')
  } catch {
    return null
  }
}
