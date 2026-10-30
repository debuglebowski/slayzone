import type { CliCommandList, CommandInfo } from '@slayzone/terminal-contracts'
import type { SubmitTransform } from './types'

/** Template references the typed arguments (`$ARGUMENTS`, or `$0`, `$1`, … positional). */
export function takesArguments(cmd: CommandInfo): boolean {
  return /\$(ARGUMENTS|\d)/.test(cmd.body)
}

/**
 * The name the CLI runs a command file under. It names commands after the file
 * (`cliName`); when its advertised list carries the frontmatter `name` instead,
 * follow the CLI.
 */
function runName(cmd: CommandInfo, listed: ReadonlySet<string> | null): string {
  const fileName = cmd.cliName ?? cmd.name
  if (listed && !listed.has(fileName) && listed.has(cmd.name)) return cmd.name
  return fileName
}

/**
 * Custom command files (`chat.listCommands`, nested) as the CLI runs them: one entry
 * per name it runs, under that name, a project file beating a user file; by name.
 */
export function customCommandItems(
  cmds: readonly CommandInfo[],
  cliList: CliCommandList | null
): CommandInfo[] {
  const listed = cliList ? new Set(cliList.slashCommands) : null
  const byName = new Map<string, CommandInfo>()
  for (const c of cmds) {
    const item = { ...c, name: runName(c, listed) }
    const prev = byName.get(item.name)
    if (!prev || (prev.source === 'user' && item.source === 'project')) byName.set(item.name, item)
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/** Expand `$ARGUMENTS` token in command body with the rest-of-line after the cmd name. */
export function expandCommandBody(body: string, args: string): string {
  return body.replace(/\$ARGUMENTS/g, args)
}

/**
 * For a provider that does NOT run slash commands itself (Codex chat): if draft starts
 * with `/<name>` and `<name>` matches a loaded command, return the expanded template
 * body (with args spliced in) as the text to actually send. Otherwise return null.
 */
export function transformCommandSubmit(
  draft: string,
  items: CommandInfo[]
): SubmitTransform | null {
  if (!draft.startsWith('/')) return null
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim())
  if (!match) return null
  const [, name, rawArgs] = match
  const cmd = items.find((c) => c.name === name)
  if (!cmd) return null
  const args = rawArgs?.trim() ?? ''
  return { send: expandCommandBody(cmd.body, args).trim() }
}
