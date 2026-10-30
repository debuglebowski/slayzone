import type { CliCommandList } from '@slayzone/terminal-contracts'
import { describeCliCommand } from './cli-command-descriptions'

export interface CliCommandItem {
  name: string
  kind: 'command' | 'skill'
  description: string
  /** What the command takes, e.g. `<model>` (from the CLI); empty when nothing / unknown. */
  argumentHint: string
}

/** Commands the CLI runs that make sense in chat: no terminal-bound and no internal (`__x`) ones. */
export function cliCommandItems(list: CliCommandList | null): CliCommandItem[] {
  if (!list) return []
  const terminal = new Set(list.terminalSlashCommands)
  const skills = new Set(list.skills)
  return list.slashCommands
    .filter((name) => !terminal.has(name) && !name.startsWith('__'))
    .map((name) => {
      // The CLI's own words (its `initialize` reply) when known.
      const detail = list.details?.[name]
      return {
        name,
        kind: skills.has(name) ? 'skill' : 'command',
        description: detail?.description || describeCliCommand(name, skills.has(name)),
        argumentHint: detail?.argumentHint ?? ''
      }
    })
}
