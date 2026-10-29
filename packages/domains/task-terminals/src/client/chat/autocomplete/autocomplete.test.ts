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
import type { AcceptCtx, AutocompleteSource, BuiltinCommand } from './types'
import { resolveEnter } from './resolve-enter'
import { createCliCommandsSource, type CliCommandItem } from './sources/cli-commands'
import { createBuiltinsSource } from './sources/builtins'
import { chatCapabilitiesForMode, type CliCommandList } from '@slayzone/terminal-contracts'

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

describe('resolveEnter (native slash commands)', () => {
  const names = ['compact', 'context', 'commit']

  test('keyboard navigation wins', () => {
    expect(resolveEnter({ query: 'compact', names, selectedIndex: 2, navigated: true })).toEqual({
      kind: 'entry',
      index: 2
    })
  })

  test('an exactly typed name picks that entry, whatever is highlighted', () => {
    expect(resolveEnter({ query: 'context', names, selectedIndex: 0, navigated: false })).toEqual({
      kind: 'entry',
      index: 1
    })
    expect(
      resolveEnter({
        query: 'Compact',
        names: ['commit', 'compact'],
        selectedIndex: 0,
        navigated: false
      })
    ).toEqual({ kind: 'entry', index: 1 })
  })

  test('a prefix of the top entry completes to it; an empty query takes the highlight', () => {
    expect(resolveEnter({ query: 'comp', names, selectedIndex: 0, navigated: false })).toEqual({
      kind: 'entry',
      index: 0
    })
    expect(resolveEnter({ query: '', names, selectedIndex: 0, navigated: false })).toEqual({
      kind: 'entry',
      index: 0
    })
  })

  test('anything else passes through as typed (the CLI answers unknown commands)', () => {
    expect(resolveEnter({ query: 'cpt', names, selectedIndex: 0, navigated: false })).toEqual({
      kind: 'passthrough'
    })
    expect(resolveEnter({ query: 'zzz', names: [], selectedIndex: 0, navigated: false })).toEqual({
      kind: 'passthrough'
    })
  })
})

const cliList = (overrides: Partial<CliCommandList> = {}): CliCommandList => ({
  slashCommands: ['compact', 'context', 'doctor', 'simplify', '__remote-workflow', 'init'],
  terminalSlashCommands: ['doctor'],
  skills: ['simplify'],
  cliVersion: '2.1.312',
  ...overrides
})

const ctxFor = (draft: string, tokenEnd = draft.length): AcceptCtx =>
  ({
    draft,
    setDraft: () => {},
    tokenStart: 0,
    tokenEnd,
    session: { tabId: 't', taskId: 'k', mode: 'claude-chat', cwd: '/r' },
    chat: {} as AcceptCtx['chat'],
    navigate: {} as AcceptCtx['navigate'],
    toast: () => {},
    submit: async () => {}
  }) as AcceptCtx

describe('CLI commands source', () => {
  test('lists the CLI commands usable in chat (no terminal-bound or internal ones)', async () => {
    const src = createCliCommandsSource(cliList())
    const items = await src.fetch({ cwd: '/r' })
    expect(items.map((i) => i.name)).toEqual(['compact', 'context', 'simplify', 'init'])
    const byName = new Map(items.map((i) => [i.name, i]))
    expect(byName.get('compact')?.description).toMatch(/context/i)
    expect(byName.get('simplify')?.kind).toBe('skill')
  })

  test('no list → no items', async () => {
    expect(await createCliCommandsSource(null).fetch({ cwd: '/r' })).toEqual([])
  })

  test('Enter sends `/name` plus anything after the token; Tab parks `/name ` for args', () => {
    const src = createCliCommandsSource(cliList())
    const item: CliCommandItem = { name: 'compact', kind: 'command', description: '' }
    expect(src.submitText?.(item, ctxFor('/comp keep the API notes', 5))).toBe(
      '/compact keep the API notes'
    )
    let draft = ''
    void src.accept(item, { ...ctxFor('/comp'), setDraft: (v) => (draft = v) })
    expect(draft).toBe('/compact ')
  })

  test('is a command trigger shadowed by the richer local sources', () => {
    const src = createCliCommandsSource(cliList())
    expect(src.commandTrigger).toBe(true)
    expect(src.shadowedBy).toEqual(['builtins', 'skills', 'commands'])
  })
})

describe('builtins vs the CLI command list', () => {
  const names = async (cli: string[], mode: string): Promise<string[]> => {
    const src = createBuiltinsSource({
      cliCommandNames: new Set(cli),
      capabilities: chatCapabilitiesForMode(mode)
    })
    return (await src.fetch({ cwd: '/r' })).map((b: BuiltinCommand) => b.name)
  }

  test('CLI-wins builtins step aside when the CLI runs the command itself', async () => {
    const withCli = await names(['init', 'compact'], 'claude-chat')
    expect(withCli).not.toContain('init')
    expect(withCli).toContain('review')
    expect(await names([], 'claude-chat')).toContain('init')
  })

  test('app-wins builtins stay even when the CLI has the same name', async () => {
    const list = await names(['clear', 'effort', 'model', 'config', 'mcp'], 'claude-chat')
    for (const n of ['clear', 'effort', 'model', 'config', 'mcp']) expect(list).toContain(n)
  })

  test('/model is offered only where the provider runs its own slash commands', async () => {
    expect(await names([], 'claude-chat')).toContain('model')
    expect(await names([], 'codex-chat')).not.toContain('model')
  })

  test('filter ranks within the fetched items (hidden builtins stay hidden)', async () => {
    const src = createBuiltinsSource({
      cliCommandNames: new Set(['init']),
      capabilities: chatCapabilitiesForMode('claude-chat')
    })
    const items = await src.fetch({ cwd: '/r' })
    expect(src.filter(items, 'init').map((b) => b.name)).not.toContain('init')
  })
})
