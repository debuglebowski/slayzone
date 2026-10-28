import type { SkillInfo } from '@slayzone/terminal-contracts'
import { rankByName } from './autocomplete/ranking'

export function filterSkills(skills: SkillInfo[], filter: string): SkillInfo[] {
  return rankByName(skills, filter, {
    getName: (s) => s.name,
    getDescription: (s) => s.description
  })
}
