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
