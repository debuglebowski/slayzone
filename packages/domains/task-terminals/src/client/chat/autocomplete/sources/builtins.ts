import type { AutocompleteSource, BuiltinCommand } from '../types'
import { availableBuiltins, rankBuiltins, type BuiltinsSourceOpts } from '../builtins-registry'
import { spliceReplace } from '../useAutocomplete'
import { renderBuiltinItem } from './render-builtin'

// Moved to the DOM-free registry (also exported as `@slayzone/task-terminals/slash-commands`).
export { availableBuiltins, type BuiltinsSourceOpts }

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
