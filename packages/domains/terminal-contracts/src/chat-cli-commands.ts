import type { TurnInitEvent } from './agent-events'

/**
 * The slash commands a chat CLI advertised (Claude Code's `system/init`).
 * Source of the composer's `/` menu: live from the session's latest
 * `turn-init`, or the last list persisted for the project before a session's
 * first turn.
 */
export interface CliCommandList {
  /** Every command the CLI runs from raw `/name args` text. */
  slashCommands: string[]
  /** Terminal-bound subset — hidden from chat menus. */
  terminalSlashCommands: string[]
  /** Skills subset. */
  skills: string[]
  cliVersion: string | null
  /**
   * Description + argument hint per command name, from the CLI's `initialize`
   * reply. Absent when unknown (older CLI, reply not seen yet).
   */
  details?: CliCommandDetails
}

export interface CliCommandDetail {
  description: string
  /** E.g. `<fruit> <count>`; empty when the command takes none. */
  argumentHint: string
}

export type CliCommandDetails = Readonly<Record<string, CliCommandDetail>>

/** Details keyed by name, from an `initialize` reply's `commands[]` (malformed entries skipped). */
export function cliCommandDetailsFromList(
  commands: ReadonlyArray<{ name: string; description: string; argumentHint: string }>
): CliCommandDetails {
  const out: Record<string, CliCommandDetail> = {}
  for (const c of commands)
    out[c.name] = { description: c.description, argumentHint: c.argumentHint }
  return out
}

export function sameCliCommandDetails(
  a: CliCommandDetails | null | undefined,
  b: CliCommandDetails | null | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every(
    (k) => b[k] && b[k].description === a[k].description && b[k].argumentHint === a[k].argumentHint
  )
}

/** The list a `turn-init` advertises, or null when it carries none (Codex, older CLIs). */
export function cliCommandListFromTurnInit(event: TurnInitEvent): CliCommandList | null {
  if (!event.slashCommands) return null
  return {
    slashCommands: event.slashCommands,
    terminalSlashCommands: event.terminalSlashCommands ?? [],
    skills: event.skills ?? [],
    cliVersion: event.cliVersion ?? null
  }
}

export function sameCliCommandList(a: CliCommandList | null, b: CliCommandList | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.cliVersion === b.cliVersion &&
    sameStrings(a.slashCommands, b.slashCommands) &&
    sameStrings(a.terminalSlashCommands, b.terminalSlashCommands) &&
    sameStrings(a.skills, b.skills)
  )
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
