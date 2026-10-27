/**
 * Tests for filterSkills scoring.
 */
import { describe, expect, test } from 'vitest'
import { filterSkills } from './skill-filter'
import type { SkillInfo } from '@slayzone/terminal/shared'

function skill(name: string, description = '', source: SkillInfo['source'] = 'user'): SkillInfo {
  return { name, description, source, path: `/tmp/${name}/SKILL.md` }
}

const all: SkillInfo[] = [
  skill('caveman', 'terse mode'),
  skill('caveman-commit', 'commit variant'),
  skill('caveman-review', 'review variant'),
  skill('commit', 'regular commit'),
  skill('release', 'cut release'),
  skill('slay', 'manage slay CLI'),
  skill('slay-tasks', 'tasks'),
  skill('unrelated', 'includes the word caveman in text')
]

describe('filterSkills', () => {
  test('empty filter returns all skills', () => {
    const out = filterSkills(all, '')
    expect(out.length).toBe(all.length)
  })

  test('prefix match ranks above substring match', () => {
    const out = filterSkills(all, 'cave')
    expect(out[0].name).toBe('caveman')
    // All three caveman* come before anything matching only via description
    const prefixMatches = out.filter((s) => s.name.startsWith('caveman'))
    expect(prefixMatches.length).toBe(3)
    const lastIdx = out.findIndex((s) => s.name === 'unrelated')
    if (lastIdx !== -1 && lastIdx < 3)
      throw new Error('description match ranked above prefix match')
  })

  test('exact name match always ranks first, even above alphabetical winner', () => {
    // Query 'commit' is an exact match for 'commit' and a fuzzy match for 'alpha-commit'.
    // Exact match always wins regardless of fzf score / usage / alphabetical order.
    const pool: SkillInfo[] = [skill('alpha-commit'), skill('commit')]
    const out = filterSkills(pool, 'commit')
    expect(out[0].name).toBe('commit')
    expect(out[1].name).toBe('alpha-commit')
  })

  test('exact match is case-insensitive', () => {
    const pool: SkillInfo[] = [skill('alpha-commit'), skill('commit')]
    const out = filterSkills(pool, 'COMMIT')
    expect(out[0].name).toBe('commit')
  })

  test('description-only match still included but ranked last', () => {
    const out = filterSkills(all, 'cave')
    const descOnly = out.find((s) => s.name === 'unrelated')
    if (!descOnly) throw new Error('description match excluded')
    expect(out[out.length - 1].name).toBe('unrelated')
  })

  test('case-insensitive', () => {
    const out = filterSkills(all, 'CAVE')
    expect(out[0].name).toBe('caveman')
  })

  test('no match returns empty array', () => {
    const out = filterSkills(all, 'zzzzz-nonexistent')
    expect(out.length).toBe(0)
  })

  test('alphabetical tiebreak within same score', () => {
    const out = filterSkills(all, 'caveman-')
    // caveman-commit and caveman-review are both prefix matches
    expect(out[0].name).toBe('caveman-commit')
    expect(out[1].name).toBe('caveman-review')
  })
})
