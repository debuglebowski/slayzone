/**
 * Refusals for work a hub switch turned off (T-04, T-05, T-06, T-07).
 *
 *   SLAYZONE_HUB_ENABLE_PROCESSES=0     the hub runs nothing itself: no background
 *                                       process, no automation command (`run_command`,
 *                                       `ai`), no terminal or agent spawned in its own
 *                                       process (T-04/05), and no git, `gh`, shell probe,
 *                                       OS opener or project-file access on its own disk
 *                                       (T-06, "connect a computer"). Work routed to a
 *                                       computer is unaffected.
 *   SLAYZONE_HUB_ENABLE_INTEGRATIONS=0  no integration connect, no stored provider
 *                                       credential, no provider call, no sign-in start.
 *
 * ONE SHAPE FOR EVERY REFUSAL. A chokepoint calls `assertHub*Enabled`, which writes one
 * `denied` audit line and throws {@link HubSwitchedOffError}: a stable `code` and one
 * message per switch that names the variable. Each transport maps that error the same
 * way wherever it surfaces — tRPC `FORBIDDEN` with `data.appCode`, REST 403
 * `{ error, code }` — so a refusal deep in a domain reads exactly like one at a router.
 *
 * Read per call through {@link resolveHubSwitches}: a hub validated every switch at
 * boot (B4), and `hub.config.json` is already folded into env by then, so there is
 * nothing to cache. Defaults are on, so a process that never sets these (the desktop
 * app's hub, tests) behaves exactly as before.
 *
 * Lean leaf (hub-switches + security-log only), also the
 * `@slayzone/platform/hub-switch-refusal` subpath.
 *
 * @module platform/hub-switch-refusal
 */
import { HUB_SWITCH_ENV, resolveHubSwitches } from './hub-switches'
import { securityEvent } from './security-log'

export type HubSwitchedOffCode =
  | 'HUB_PROCESSES_DISABLED'
  | 'HUB_INTEGRATIONS_DISABLED'
  | 'NO_COMPUTER_CONNECTED'

const MESSAGES: Record<HubSwitchedOffCode, string> = {
  HUB_PROCESSES_DISABLED:
    'This hub does not run processes, automation commands, terminals or agents itself ' +
    `(${HUB_SWITCH_ENV.enableProcesses}=0).`,
  HUB_INTEGRATIONS_DISABLED: `Integrations are switched off on this hub (${HUB_SWITCH_ENV.enableIntegrations}=0).`,
  NO_COMPUTER_CONNECTED:
    'Connect a computer: this hub does not read project files or run git, gh or other ' +
    `commands itself (${HUB_SWITCH_ENV.enableProcesses}=0).`
}

const VARIABLES: Record<HubSwitchedOffCode, string> = {
  HUB_PROCESSES_DISABLED: HUB_SWITCH_ENV.enableProcesses,
  HUB_INTEGRATIONS_DISABLED: HUB_SWITCH_ENV.enableIntegrations,
  NO_COMPUTER_CONNECTED: HUB_SWITCH_ENV.enableProcesses
}

/** Work refused because a hub switch is `0`. */
export class HubSwitchedOffError extends Error {
  /** The env var of the switch that is off. */
  readonly variable: string

  constructor(readonly code: HubSwitchedOffCode) {
    super(MESSAGES[code])
    this.name = 'HubSwitchedOffError'
    this.variable = VARIABLES[code]
  }
}

/**
 * `instanceof`, plus a structural fallback for an error that crossed a module copy
 * (a bundle can hold two of this class). Matches only our own codes.
 */
export function isHubSwitchedOffError(err: unknown): err is HubSwitchedOffError {
  if (err instanceof HubSwitchedOffError) return true
  if (!(err instanceof Error) || err.name !== 'HubSwitchedOffError') return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code in MESSAGES
}

/** `SLAYZONE_HUB_ENABLE_PROCESSES` — may this hub run processes itself? */
export function hubProcessesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveHubSwitches(env).enableProcesses
}

/** `SLAYZONE_HUB_ENABLE_INTEGRATIONS` — may this hub talk to integration providers? */
export function hubIntegrationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveHubSwitches(env).enableIntegrations
}

/** What was refused, for the audit line. Ids and short codes only — never a command. */
export interface HubRefusal {
  /** Short name of the refused operation, e.g. `create`, `pty.spawn`, `save`. */
  op: string
  detail?: Record<string, unknown>
}

function refuse(
  event: 'hub.process.spawn' | 'automation.run_command' | 'integration.connect' | 'hub.local_exec',
  code: HubSwitchedOffCode,
  refusal: HubRefusal
): never {
  securityEvent({
    event,
    outcome: 'denied',
    targetKind: 'hub',
    detail: { ...refusal.detail, op: refusal.op, code, variable: VARIABLES[code] }
  })
  throw new HubSwitchedOffError(code)
}

/**
 * Throw {@link HubSwitchedOffError} (`HUB_PROCESSES_DISABLED`) after one audit line
 * when `SLAYZONE_HUB_ENABLE_PROCESSES=0`. `event` is `hub.process.spawn` for a
 * process, terminal or agent, `automation.run_command` for an automation action.
 */
export function assertHubProcessesEnabled(
  event: 'hub.process.spawn' | 'automation.run_command',
  refusal: HubRefusal
): void {
  if (!hubProcessesEnabled()) refuse(event, 'HUB_PROCESSES_DISABLED', refusal)
}

/**
 * Throw {@link HubSwitchedOffError} (`HUB_INTEGRATIONS_DISABLED`) after one
 * `integration.connect` audit line when `SLAYZONE_HUB_ENABLE_INTEGRATIONS=0`.
 */
export function assertHubIntegrationsEnabled(refusal: HubRefusal): void {
  if (!hubIntegrationsEnabled()) refuse('integration.connect', 'HUB_INTEGRATIONS_DISABLED', refusal)
}

/**
 * Throw {@link HubSwitchedOffError} (`NO_COMPUTER_CONNECTED`) after one `hub.local_exec`
 * audit line when `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-06). Called at every point where
 * the hub would touch its OWN disk or exec on its own machine for project work: git,
 * `gh`, login-shell probes, the OS opener, the local workspace filesystem — including
 * each fallback that used to run here when no computer was resolved. Such a hub never
 * holds or touches project data; computers do.
 */
export function assertHubLocalExecEnabled(refusal: HubRefusal): void {
  if (!hubProcessesEnabled()) refuse('hub.local_exec', 'NO_COMPUTER_CONNECTED', refusal)
}
