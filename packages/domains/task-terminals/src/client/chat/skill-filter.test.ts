/**
 * Tests for filterSkills scoring.
 * Run with: npx tsx packages/domains/task-terminals/src/client/chat/skill-filter.test.ts
 */
import { filterSkills } from './skill-filter'
import type { SkillInfo } from '@slayzone/terminal/shared'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(`${label ?? 'values'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

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
  skill('unrelated', 'includes the word caveman in text'),
]

console.log('\nfilterSkills')

test('empty filter returns all skills', () => {
  const out = filterSkills(all, '')
  assertEqual(out.length, all.length)
})

test('prefix match ranks above substring match', () => {
  const out = filterSkills(all, 'cave')
  assertEqual(out[0].name, 'caveman')
  // All three caveman* come before anything matching only via description
  const prefixMatches = out.filter((s) => s.name.startsWith('caveman'))
  assertEqual(prefixMatches.length, 3)
  const lastIdx = out.findIndex((s) => s.name === 'unrelated')
  if (lastIdx !== -1 && lastIdx < 3) throw new Error('description match ranked above prefix match')
})

test('exact name match always ranks first, even above alphabetical winner', () => {
  // Query 'commit' is an exact match for 'commit' and a fuzzy match for 'alpha-commit'.
  // Exact match always wins regardless of fzf score / usage / alphabetical order.
  const pool: SkillInfo[] = [skill('alpha-commit'), skill('commit')]
  const out = filterSkills(pool, 'commit')
  assertEqual(out[0].name, 'commit')
  assertEqual(out[1].name, 'alpha-commit')
})

test('exact match is case-insensitive', () => {
  const pool: SkillInfo[] = [skill('alpha-commit'), skill('commit')]
  const out = filterSkills(pool, 'COMMIT')
  assertEqual(out[0].name, 'commit')
})

test('description-only match still included but ranked last', () => {
  const out = filterSkills(all, 'cave')
  const descOnly = out.find((s) => s.name === 'unrelated')
  if (!descOnly) throw new Error('description match excluded')
  assertEqual(out[out.length - 1].name, 'unrelated')
})

test('case-insensitive', () => {
  const out = filterSkills(all, 'CAVE')
  assertEqual(out[0].name, 'caveman')
})

test('no match returns empty array', () => {
  const out = filterSkills(all, 'zzzzz-nonexistent')
  assertEqual(out.length, 0)
})

test('alphabetical tiebreak within same score', () => {
  const out = filterSkills(all, 'caveman-')
  // caveman-commit and caveman-review are both prefix matches
  assertEqual(out[0].name, 'caveman-commit')
  assertEqual(out[1].name, 'caveman-review')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
