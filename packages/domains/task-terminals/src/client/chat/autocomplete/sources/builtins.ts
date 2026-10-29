import type { ChatCapabilities } from '@slayzone/terminal-contracts'
import type { AutocompleteSource, BuiltinCommand } from '../types'
import { rankBuiltins, builtinCommands } from '../builtins-registry'
import { spliceReplace } from '../useAutocomplete'
import { renderBuiltinItem } from './render-builtin'

export interface BuiltinsSourceOpts {
  /** Commands the chat CLI runs itself (its list minus terminal-only ones); empty when unknown. */
  cliCommandNames: ReadonlySet<string>
  capabilities: ChatCapabilities
}

/** Builtins offered for this chat: available for the mode, and not shadowed by a CLI-native command. */
export function availableBuiltins(opts: BuiltinsSourceOpts): BuiltinCommand[] {
  return builtinCommands.filter(
    (b) =>
      (b.available?.(opts.capabilities) ?? true) &&
      !(b.cliCollision === 'cli-wins' && opts.cliCommandNames.has(b.name))
  )
}

export function createBuiltinsSource(opts: BuiltinsSourceOpts): AutocompleteSource<BuiltinCommand> {
  const items = availableBuiltins(opts)
  return {
    id: 'builtins',
    commandTrigger: true,
    detect(draft, cursorPos) {
      if (!draft.startsWith('/')) return null
      const rest = draft.slice(1, cursorPos)
      if (/\s/.test(rest)) return null
      return { query: rest, tokenStart: 0, tokenEnd: cursorPos }
    },
    async fetch() {
      return items
    },
    filter: (all, query) => rankBuiltins(all, query),
    getKey: (b) => `builtin:${b.name}`,
    render: renderBuiltinItem,
    getName: (b) => b.name,
    getDescription: (b) => b.description,
    async accept(cmd, ctx) {
      // Clear the draft, then run side effect.
      const next = spliceReplace(ctx.draft, ctx.tokenStart, ctx.draft.length, '')
      ctx.setDraft(next)
      await cmd.run(ctx)
    }
  }
}
