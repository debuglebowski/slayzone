import type { CliCommandList } from '@slayzone/terminal-contracts'
import type { AutocompleteSource } from '../types'
import { rankByName } from '../ranking'
import { spliceReplace } from '../useAutocomplete'
import { cliCommandItems, type CliCommandItem } from '../cli-command-items'
import { renderCliCommandItem } from './render-cli-command'

// Moved to a DOM-free module (`../cli-command-items`, also exported as
// `@slayzone/task-terminals/slash-commands`); re-exported for this source's importers.
export { cliCommandItems, type CliCommandItem }

/**
 * The chat CLI's own slash commands (Claude Code's `system/init` list — live, or
 * the project's last known list before a session's first turn). Enter sends
 * `/name …` for the CLI to run; Tab/click parks `/name ` to add arguments.
 * Local sources with the same name (app builtins, skills/commands from disk,
 * which carry real descriptions) take precedence.
 */
export function createCliCommandsSource(
  list: CliCommandList | null
): AutocompleteSource<CliCommandItem> {
  const items = cliCommandItems(list)
  return {
    id: 'cli-commands',
    commandTrigger: true,
    shadowedBy: ['builtins', 'skills', 'commands'],
    detect(draft, cursorPos) {
      if (!draft.startsWith('/')) return null
      const rest = draft.slice(1, cursorPos)
      if (/\s/.test(rest)) return null
      return { query: rest, tokenStart: 0, tokenEnd: cursorPos }
    },
    async fetch() {
      return items
    },
    filter: (all, query) =>
      rankByName(all, query, { getName: (c) => c.name, getDescription: (c) => c.description }),
    getKey: (c) => `cli:${c.name}`,
    render: renderCliCommandItem,
    getName: (c) => c.name,
    getDescription: (c) => c.description,
    submitText: (c, ctx) => `/${c.name}${ctx.draft.slice(ctx.tokenEnd)}`,
    accept(c, ctx) {
      ctx.setDraft(spliceReplace(ctx.draft, ctx.tokenStart, ctx.tokenEnd, `/${c.name} `))
    }
  }
}
