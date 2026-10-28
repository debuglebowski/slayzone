/**
 * Tests for shared rankByName helper.
 */
import { describe, expect, test } from 'vitest'
import { rankByName, rankAcrossSources } from './ranking'
import { transformCommandSubmit } from './sources/commands'
import type { AutocompleteSource } from './types'
import type { CommandInfo } from '@slayzone/terminal-contracts'

interface TestItem {
  name: string
  description: string
}

const pool: TestItem[] = [
  { name: 'caveman', description: 'terse' },
  { name: 'caveman-commit', description: 'commit' },
  { name: 'commit', description: 'plain commit' },
  { name: 'unrelated', description: 'has caveman in desc' }
]

describe('rankByName', () => {
  test('empty query — alphabetical', () => {
    const out = rankByName(pool, '', { getName: (i) => i.name })
    expect(out[0].name).toBe('caveman')
    expect(out[1].name).toBe('caveman-commit')
    expect(out[2].name).toBe('commit')
    expect(out[3].name).toBe('unrelated')
  })

  test('prefix > substring > description', () => {
    const out = rankByName(pool, 'cave', {
      getName: (i) => i.name,
      getDescription: (i) => i.description
    })
    expect(out[0].name).toBe('caveman')
    expect(out[out.length - 1].name).toBe('unrelated')
  })

  test('no description accessor — description matches excluded', () => {
    const out = rankByName(pool, 'cave', { getName: (i) => i.name })
    expect(out.find((i) => i.name === 'unrelated')).toBe(undefined)
  })

  test('alphabetical tiebreak in same score bucket', () => {
    const out = rankByName(pool, 'caveman-', { getName: (i) => i.name })
    expect(out[0].name).toBe('caveman-commit')
  })

  test('fuzzy match — non-contiguous chars', () => {
    const out = rankByName(pool, 'cmt', { getName: (i) => i.name })
    // 'commit' and 'caveman-commit' both contain c…m…t fuzzily
    expect(out.some((i) => i.name === 'commit')).toBe(true)
    expect(out.some((i) => i.name === 'caveman-commit')).toBe(true)
  })

  test('fuzzy match — case-insensitive', () => {
    const out = rankByName(pool, 'CAVE', { getName: (i) => i.name })
    expect(out[0].name).toBe('caveman')
  })

  test('usage tiebreak — higher count beats alphabetical', () => {
    // fzf scores 'commit' and 'caveman-commit' identically for query 'commit'.
    // Alphabetical tiebreak normally puts 'caveman-commit' first ('ca' < 'co').
    // When usage favors 'commit', it should overtake.
    const usage: Record<string, number> = { commit: 5, 'caveman-commit': 0 }
    const out = rankByName(pool, 'commit', {
      getName: (i) => i.name,
      getUsage: (i) => usage[i.name] ?? 0
    })
    expect(out[0].name).toBe('commit')
    expect(out[1].name).toBe('caveman-commit')
  })

  test('exact name match wins over alphabetical tiebreak', () => {
    // Equal usage. Without exact-match priority, alphabetical would put
    // 'caveman-commit' first. Exact match for 'commit' overrides.
    const usage: Record<string, number> = { commit: 3, 'caveman-commit': 3 }
    const out = rankByName(pool, 'commit', {
      getName: (i) => i.name,
      getUsage: (i) => usage[i.name] ?? 0
    })
    expect(out[0].name).toBe('commit')
    expect(out[1].name).toBe('caveman-commit')
  })

  test('exact match wins over higher usage of partial match', () => {
    // Partial match has much higher usage; exact match still ranks first.
    const usage: Record<string, number> = { commit: 0, 'caveman-commit': 100 }
    const out = rankByName(pool, 'commit', {
      getName: (i) => i.name,
      getUsage: (i) => usage[i.name] ?? 0
    })
    expect(out[0].name).toBe('commit')
  })

  test('exact match priority is case-insensitive', () => {
    const out = rankByName(pool, 'COMMIT', { getName: (i) => i.name })
    expect(out[0].name).toBe('commit')
  })

  test('empty query — usage outranks alphabetical', () => {
    const usage: Record<string, number> = { commit: 7 }
    const out = rankByName(pool, '', {
      getName: (i) => i.name,
      getUsage: (i) => usage[i.name] ?? 0
    })
    expect(out[0].name).toBe('commit')
  })
})

describe('rankAcrossSources — usage tiebreak', () => {
  interface NamedItem {
    name: string
  }

  function makeSource(
    id: string,
    items: NamedItem[]
  ): { source: AutocompleteSource; items: unknown[] } {
    const src: AutocompleteSource<NamedItem> = {
      id,
      detect: () => null,
      fetch: async () => items,
      filter: (i) => i,
      getKey: (i) => i.name,
      render: () => null,
      accept: () => undefined,
      getName: (i) => i.name,
      getDescription: () => ''
    }
    return { source: src as AutocompleteSource, items: items as unknown[] }
  }

  test('cross-source usage tiebreak applies across source boundaries', () => {
    const skills = makeSource('skills', [{ name: 'caveman-commit' }, { name: 'commit' }])
    const out = rankAcrossSources([skills], 'commit', (sourceId, name) => {
      if (sourceId === 'skills' && name === 'commit') return 10
      return 0
    })
    expect((out[0].item as NamedItem).name).toBe('commit')
  })

  test('cross-source exact match beats higher-usage partial match', () => {
    // Skills has the exact match 'commit' with zero usage. Commands has 'commit-amend'
    // (partial fuzzy match) with high usage. Exact match must still rank first.
    const skills = makeSource('skills', [{ name: 'commit' }])
    const commands = makeSource('commands', [{ name: 'commit-amend' }])
    const out = rankAcrossSources([skills, commands], 'commit', (sourceId, name) => {
      if (sourceId === 'commands' && name === 'commit-amend') return 100
      return 0
    })
    expect((out[0].item as NamedItem).name).toBe('commit')
  })

  test('cross-source — picks higher usage from one source over another', () => {
    // Two sources, both contain 'commit'. Usage favors the one in 'commands'.
    const skills = makeSource('skills', [{ name: 'commit' }])
    const commands = makeSource('commands', [{ name: 'commit' }])
    const out = rankAcrossSources([skills, commands], 'commit', (sourceId, name) => {
      if (sourceId === 'commands' && name === 'commit') return 9
      return 0
    })
    expect(out[0].source.id).toBe('commands')
  })
})

describe('transformCommandSubmit', () => {
  function cmd(name: string, body: string): CommandInfo {
    return { name, description: '', source: 'user', path: `/tmp/${name}.md`, body }
  }

  test('returns null when draft does not start with /', () => {
    expect(transformCommandSubmit('hello', [cmd('x', 'body')])).toBe(null)
  })

  test('returns null when no cmd matches', () => {
    expect(transformCommandSubmit('/unknown args', [cmd('x', 'body')])).toBe(null)
  })

  test('expands $ARGUMENTS with rest-of-line', () => {
    const r = transformCommandSubmit('/review https://github.com/pr/1', [
      cmd('review', 'Review PR: $ARGUMENTS')
    ])
    expect(r?.send).toBe('Review PR: https://github.com/pr/1')
  })

  test('empty args expand to empty string', () => {
    const r = transformCommandSubmit('/review', [cmd('review', 'Do $ARGUMENTS')])
    expect(r?.send).toBe('Do')
  })

  test('returns body unchanged when no $ARGUMENTS placeholder', () => {
    const r = transformCommandSubmit('/commit', [cmd('commit', 'Please commit staged files.')])
    expect(r?.send).toBe('Please commit staged files.')
  })
})
