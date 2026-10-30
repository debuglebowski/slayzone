import type { CommandInfo } from '@slayzone/terminal-contracts'
import type { AutocompleteSource, ChatListApi } from '../types'
import { rankByName } from '../ranking'
import { spliceReplace } from '../useAutocomplete'
import { expandCommandBody, transformCommandSubmit } from '../custom-command-items'
import { renderCommandItem } from './render-command'

// Moved to the DOM-free `../custom-command-items` (also exported as
// `@slayzone/task-terminals/slash-commands`); re-exported for this source's importers.
export { expandCommandBody, transformCommandSubmit }

export function filterCommands(items: CommandInfo[], filter: string): CommandInfo[] {
  return rankByName(items, filter, {
    getName: (c) => c.name,
    getDescription: (c) => c.description
  })
}

export function createCommandsSource(
  onSend: (text: string) => Promise<boolean>,
  listApi?: ChatListApi
): AutocompleteSource<CommandInfo> {
  return {
    id: 'commands',
    commandTrigger: true,
    detect(draft, cursorPos) {
      if (!draft.startsWith('/')) return null
      const rest = draft.slice(1, cursorPos)
      // Active at any `/word` position — we'll beat skills on name match, else skills takes over.
      // Here we accept the trigger regardless; cmd+skill sources compete on filter results.
      if (/\s/.test(rest)) return null
      return { query: rest, tokenStart: 0, tokenEnd: cursorPos }
    },
    async fetch({ cwd }) {
      if (!listApi) return []
      return listApi.listCommands(cwd)
    },
    filter: filterCommands,
    getKey: (c) => `${c.source}:${c.name}`,
    render: renderCommandItem,
    transformSubmit: transformCommandSubmit,
    getName: (c) => c.name,
    getDescription: (c) => c.description,
    // Enter sends `/name args` through the composer, whose transformSubmit
    // expands the template. A template that needs arguments none were typed for
    // falls back to accept(), which parks `/name ` for them.
    submitText: (cmd, ctx) => {
      const rest = ctx.draft.slice(ctx.tokenEnd)
      if (/\$ARGUMENTS/.test(cmd.body) && rest.trim().length === 0) return null
      return `/${cmd.name}${rest}`
    },
    async accept(cmd, ctx) {
      const rawAfter = ctx.draft.slice(ctx.tokenEnd).trimStart()
      const needsArgs = /\$ARGUMENTS/.test(cmd.body)
      // If the command template references $ARGUMENTS but the user hasn't typed any,
      // park `/cmdname ` in the draft so they can type args + Enter themselves.
      if (needsArgs && rawAfter.length === 0) {
        const next = spliceReplace(ctx.draft, ctx.tokenStart, ctx.draft.length, `/${cmd.name} `)
        ctx.setDraft(next)
        ctx.toast(`${cmd.name}: type args then press Enter`)
        return
      }
      const next = spliceReplace(ctx.draft, ctx.tokenStart, ctx.draft.length, '')
      ctx.setDraft(next)
      const prompt = expandCommandBody(cmd.body, rawAfter).trim()
      if (prompt) await onSend(prompt)
    }
  }
}
