import type { SkillInfo } from '@slayzone/terminal-contracts'
import type { AutocompleteSource, ChatListApi } from '../types'
import { filterSkills } from '../../skill-filter'
import { spliceReplace } from '../useAutocomplete'
import { renderSkillItem } from './render-skill'

export function createSkillsSource(listApi?: ChatListApi): AutocompleteSource<SkillInfo> {
  return {
    id: 'skills',
    commandTrigger: true,
    detect(draft, cursorPos) {
      if (!draft.startsWith('/')) return null
      const rest = draft.slice(1, cursorPos)
      if (/\s/.test(rest)) return null
      return { query: rest, tokenStart: 0, tokenEnd: cursorPos }
    },
    async fetch({ cwd }) {
      if (!listApi) return []
      return listApi.listSkills(cwd)
    },
    filter: filterSkills,
    getKey: (s) => `${s.source}:${s.name}`,
    render: renderSkillItem,
    getName: (s) => s.name,
    getDescription: (s) => s.description,
    // Enter runs the skill in the CLI (`/name args`); Tab/click parks it for args.
    submitText: (s, ctx) => `/${s.name}${ctx.draft.slice(ctx.tokenEnd)}`,
    accept(skill, ctx) {
      const next = spliceReplace(ctx.draft, ctx.tokenStart, ctx.tokenEnd, `/${skill.name} `)
      ctx.setDraft(next)
    }
  }
}
