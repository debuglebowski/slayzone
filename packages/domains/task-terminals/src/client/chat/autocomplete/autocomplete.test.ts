/**
 * Tests for autocomplete source detectors + file `@` trigger.
 */
import { describe, expect, test } from 'vitest'
import { createSkillsSource } from './sources/skills'
import { createFilesSource } from './sources/files'
import { expandCommandBody } from './sources/commands'
import { filterBuiltins } from './builtins-registry'
import { spliceReplace } from './useAutocomplete'
import { rankAcrossSources } from './ranking'
import type { AutocompleteSource } from './types'

describe('skills source — detect', () => {
  const skills = createSkillsSource()

  test('triggers at start-of-line `/`', () => {
    const m = skills.detect('/cave', 5)
    expect(m?.query).toBe('cave')
    expect(m?.tokenStart).toBe(0)
    expect(m?.tokenEnd).toBe(5)
  })

  test('no trigger without leading `/`', () => {
    expect(skills.detect('hello', 5)).toBe(null)
  })

  test('no trigger when space after `/cmd`', () => {
    expect(skills.detect('/cmd ', 5)).toBe(null)
  })
})

describe('files source — detect', () => {
  const files = createFilesSource()

  test('triggers on `@` at start', () => {
    const m = files.detect('@src/', 5)
    expect(m?.query).toBe('src/')
    expect(m?.tokenStart).toBe(0)
  })

  test('triggers on `@` after space', () => {
    const m = files.detect('hey @src', 8)
    expect(m?.query).toBe('src')
    expect(m?.tokenStart).toBe(4)
  })

  test('no trigger on `email@addr`', () => {
    expect(files.detect('email@addr', 10)).toBe(null)
  })

  test('no trigger on plain text', () => {
    expect(files.detect('hello world', 11)).toBe(null)
  })
})

describe('spliceReplace', () => {
  test('replaces token in middle', () => {
    const out = spliceReplace('hey @src world', 4, 8, '@src/App.tsx')
    expect(out).toBe('hey @src/App.tsx world')
  })

  test('replaces token at start', () => {
    const out = spliceReplace('/cave', 0, 5, '/caveman ')
    expect(out).toBe('/caveman ')
  })
})

describe('expandCommandBody', () => {
  test('replaces $ARGUMENTS with args text', () => {
    const out = expandCommandBody('Review PR: $ARGUMENTS', 'https://example.com/pr/1')
    expect(out).toBe('Review PR: https://example.com/pr/1')
  })

  test('replaces multiple $ARGUMENTS tokens', () => {
    const out = expandCommandBody('$ARGUMENTS and $ARGUMENTS', 'x')
    expect(out).toBe('x and x')
  })

  test('empty args still substitutes (caller trims)', () => {
    expect(expandCommandBody('Do $ARGUMENTS', '')).toBe('Do ')
  })
})

describe('builtins filter', () => {
  test('empty query returns all', () => {
    expect(filterBuiltins('').length > 0).toBe(true)
  })

  test('prefix match ranked above description match', () => {
    const out = filterBuiltins('clear')
    expect(out[0].name).toBe('clear')
  })

  test('no match returns empty', () => {
    expect(filterBuiltins('zzzz-none').length).toBe(0)
  })
})

describe('rankAcrossSources — no shadowing across sources at same trigger', () => {
  interface Named {
    name: string
    description: string
  }
  function fakeSrc(id: string): AutocompleteSource<Named> {
    return {
      id,
      detect: () => null,
      fetch: async () => [],
      filter: () => [],
      getKey: (i) => `${id}:${i.name}`,
      render: () => null,
      accept: () => undefined,
      getName: (i) => i.name,
      getDescription: (i) => i.description
    }
  }

  test('union ranks all sources together — name hits beat desc-only hits', () => {
    const builtins = fakeSrc('builtins')
    const skills = fakeSrc('skills')
    const result = rankAcrossSources(
      [
        {
          source: builtins as AutocompleteSource,
          items: [{ name: 'help', description: 'Show available slash commands' }]
        },
        {
          source: skills as AutocompleteSource,
          items: [
            { name: 'commit', description: 'Commit changes' },
            { name: 'commit-and-done', description: 'Commit and mark done' },
            { name: 'comparison-page', description: 'Make comparison page' }
          ]
        }
      ],
      'comm'
    )
    // Repro: previously builtins (id='builtins') won alone via desc match on 'commands' word.
    // Now skills name-match items appear too — and rank above the builtins desc-only hit.
    const names = result.map((e) => (e.item as Named).name)
    expect(names.includes('commit'), 'commit included').toBe(true)
    expect(names.includes('commit-and-done'), 'commit-and-done included').toBe(true)
    expect(names.includes('help'), 'help included via desc').toBe(true)
    // First entry must be a name-match (skills), not the desc-only builtin.
    expect(names[0] === 'commit' || names[0] === 'commit-and-done', 'name match leads').toBe(true)
  })

  test('longer query that drops desc match still surfaces name matches', () => {
    const builtins = fakeSrc('builtins')
    const skills = fakeSrc('skills')
    const result = rankAcrossSources(
      [
        {
          source: builtins as AutocompleteSource,
          items: [{ name: 'help', description: 'Show available slash commands' }]
        },
        {
          source: skills as AutocompleteSource,
          items: [
            { name: 'commit', description: 'Commit changes' },
            { name: 'commit-and-done', description: 'Commit and mark done' }
          ]
        }
      ],
      'commi'
    )
    const names = result.map((e) => (e.item as Named).name)
    expect(names.includes('commit')).toBe(true)
    expect(names.includes('commit-and-done')).toBe(true)
  })
})
