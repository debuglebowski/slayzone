/**
 * Refusals about a computer's STATE — disabled, busy, or the desktop app's own — each
 * with a stable code that tRPC's error formatter carries to a client as `data.appCode`.
 *
 * Shared by the computers router (setDisabled / delete / bindings) and the hub's spawn
 * guard (`apps/hub` composition), so a refusal reads the same wherever it is raised.
 *
 * @module computers/server/computer-state-errors
 */
import { registerAppCode } from '@slayzone/trpc-server'

/** Work was sent to, or bound to, a disabled computer. */
export const COMPUTER_DISABLED = 'COMPUTER_DISABLED'
/** A computer cannot be disabled while terminals or agents run on it. */
export const COMPUTER_HAS_RUNNING_WORK = 'COMPUTER_HAS_RUNNING_WORK'
/** The desktop app's own computer, on its own hub: never disabled, deleted or renamed. */
export const COMPUTER_IS_LOCAL = 'COMPUTER_IS_LOCAL'
/** The name the desktop hub reserves for its own computer. */
export const COMPUTER_NAME_RESERVED = 'COMPUTER_NAME_RESERVED'

export type ComputerStateCode =
  | typeof COMPUTER_DISABLED
  | typeof COMPUTER_HAS_RUNNING_WORK
  | typeof COMPUTER_IS_LOCAL
  | typeof COMPUTER_NAME_RESERVED

export class ComputerStateError extends Error {
  constructor(
    readonly code: ComputerStateCode,
    message: string
  ) {
    super(message)
    this.name = 'ComputerStateError'
  }
}

/** `instanceof`, plus a structural fallback for an error from another module copy. */
export function isComputerStateError(err: unknown): err is ComputerStateError {
  if (err instanceof ComputerStateError) return true
  return (
    err instanceof Error &&
    err.name === 'ComputerStateError' &&
    typeof (err as { code?: unknown }).code === 'string'
  )
}

registerAppCode((cause) => (isComputerStateError(cause) ? cause.code : undefined))

/** `name` is the computer's display name when known. */
export function computerDisabledError(name?: string | null): ComputerStateError {
  const which = name ? `Computer "${name}"` : 'This computer'
  return new ComputerStateError(
    COMPUTER_DISABLED,
    `${which} is disabled, so it takes no new work. Enable it in Settings → Connections, ` +
      `or bind the task or project to another computer.`
  )
}

export function computerHasRunningWorkError(
  count: number,
  name?: string | null
): ComputerStateError {
  const on = name ? ` on "${name}"` : ' on this computer'
  const what = count === 1 ? '1 terminal or agent is' : `${count} terminals or agents are`
  return new ComputerStateError(
    COMPUTER_HAS_RUNNING_WORK,
    `${what} still running${on}. Stop ${count === 1 ? 'it' : 'them'} first, then disable it.`
  )
}

export function computerNameReservedError(name: string): ComputerStateError {
  return new ComputerStateError(
    COMPUTER_NAME_RESERVED,
    `"${name}" is reserved for the desktop app's own computer; choose another name.`
  )
}

export function computerIsLocalError(
  action: 'disabled' | 'deleted' | 'renamed'
): ComputerStateError {
  const why =
    action === 'renamed'
      ? 'this hub finds its own computer by that name'
      : 'nothing on this machine could run without it'
  return new ComputerStateError(
    COMPUTER_IS_LOCAL,
    `This app's own computer cannot be ${action} on this hub: ${why}.`
  )
}
