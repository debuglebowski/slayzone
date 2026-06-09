import type { CommandInfo } from '@slayzone/terminal/shared'
import type { AutocompleteSource, ChatListApi, SubmitTransform } from '../types'
import { rankByName } from '../ranking'
import { spliceReplace } from '../useAutocomplete'
import { renderCommandItem } from './render-command'

export function filterCommands(items: CommandInfo[], filter: string): CommandInfo[] {
  return rankByName(items, filter, {
    getName: (c) => c.name,
    getDescription: (c) => c.description
  })
}

/** Expand `$ARGUMENTS` token in command body with the rest-of-line after the cmd name. */
export function expandCommandBody(body: string, args: string): string {
  return body.replace(/\$ARGUMENTS/g, args)
}

/**
 * If draft starts with `/<name>` and `<name>` matches a loaded command, return the expanded
 * template body (with args spliced in) as the text to actually send. Otherwise return null.
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

export function createCommandsSource(
  onSend: (text: string) => Promise<boolean>,
  listApi?: ChatListApi
): AutocompleteSource<CommandInfo> {
  return {
    id: 'commands',
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
