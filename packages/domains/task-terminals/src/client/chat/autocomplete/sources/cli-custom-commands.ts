import type { CliCommandList, CommandInfo } from '@slayzone/terminal-contracts'
import type { AutocompleteSource, ChatListApi } from '../types'
import { rankByName } from '../ranking'
import { spliceReplace } from '../useAutocomplete'
import { renderCliCustomCommandItem } from './render-cli-custom-command'

/** Template references the typed arguments (`$ARGUMENTS`, or `$0`, `$1`, … positional). */
function takesArguments(cmd: CommandInfo): boolean {
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
 * Custom slash commands (`~/.claude/commands`, `<cwd>/.claude/commands`, sub-folders
 * as `dir:name`) for providers that run them natively (Claude Code). The CLI
 * expands the template itself — frontmatter, `$ARGUMENTS`/`$N`, `!shell` lines,
 * namespaces — so this source only names the command: Enter sends the typed
 * `/name args` unchanged, Tab/click parks `/name ` for arguments. Same `commands`
 * id as the expanding source it replaces, so menu shadowing and usage ranking
 * carry over.
 */
export function createCliCustomCommandsSource(
  listApi: ChatListApi | undefined,
  cliList: CliCommandList | null
): AutocompleteSource<CommandInfo> {
  const listed = cliList ? new Set(cliList.slashCommands) : null
  return {
    id: 'commands',
    commandTrigger: true,
    detect(draft, cursorPos) {
      if (!draft.startsWith('/')) return null
      const rest = draft.slice(1, cursorPos)
      if (/\s/.test(rest)) return null
      return { query: rest, tokenStart: 0, tokenEnd: cursorPos }
    },
    async fetch({ cwd }) {
      if (!listApi) return []
      const cmds = await listApi.listCommands(cwd, { nested: true })
      // One entry per name the CLI runs; a project file beats a user file.
      const byName = new Map<string, CommandInfo>()
      for (const c of cmds) {
        const item = { ...c, name: runName(c, listed) }
        const prev = byName.get(item.name)
        if (!prev || (prev.source === 'user' && item.source === 'project'))
          byName.set(item.name, item)
      }
      return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
    },
    filter: (items, query) =>
      rankByName(items, query, { getName: (c) => c.name, getDescription: (c) => c.description }),
    getKey: (c) => `${c.source}:${c.name}`,
    render: renderCliCustomCommandItem,
    getName: (c) => c.name,
    getDescription: (c) => c.description,
    // A template that takes arguments none were typed for falls back to accept(),
    // which parks `/name ` for them.
    submitText: (cmd, ctx) => {
      const rest = ctx.draft.slice(ctx.tokenEnd)
      if (takesArguments(cmd) && rest.trim().length === 0) return null
      return `/${cmd.name}${rest}`
    },
    accept(cmd, ctx) {
      ctx.setDraft(spliceReplace(ctx.draft, ctx.tokenStart, ctx.tokenEnd, `/${cmd.name} `))
      if (takesArguments(cmd) && ctx.draft.slice(ctx.tokenEnd).trim().length === 0) {
        const usage = cmd.argumentHint ? `/${cmd.name} ${cmd.argumentHint}` : `/${cmd.name}`
        ctx.toast(`${usage}: type the arguments, then press Enter`)
      }
    }
  }
}
