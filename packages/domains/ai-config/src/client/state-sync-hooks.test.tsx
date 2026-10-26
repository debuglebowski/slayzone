// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { AiConfigItem, ProjectSkillStatus } from '../shared'

/**
 * Pins the observable state transitions of the ai-config hooks whose loaders,
 * prop→state resets and derived-state corrections run around effects: what a
 * consumer sees after each mount / prop change / load settles, which tRPC calls go
 * out, and with which inputs.
 */

type Handler = (input: unknown) => Promise<unknown>
let handlers: Record<string, Handler> = {}
let calls: Array<{ path: string; input: unknown }> = []

/** A tRPC-vanilla-shaped client: `client.a.b.query(input)` → handlers['a.b'](input). */
function makeClient(): unknown {
  // Path proxies are cached per client, like tRPC's own recursive proxy.
  const cache = new Map<string, unknown>()
  const build = (path: string[]): unknown => {
    const key = path.join('.')
    if (!cache.has(key)) cache.set(key, makeNode(path))
    return cache.get(key)
  }
  const makeNode = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => build([...path, String(key)]),
      apply: (_target, _this, args: unknown[]) => {
        const p = path.slice(0, -1).join('.')
        calls.push({ path: p, input: args[0] })
        const handler = handlers[p]
        return handler ? handler(args[0]) : Promise.resolve(undefined)
      }
    })
  return build([])
}

let client = makeClient()

vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => client
}))

vi.mock('@slayzone/ui', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

const { useProjectMcpServers } = await import('./mcp-servers-panel/useProjectMcpServers')
const { useComputerMcpServers } = await import('./mcp-servers-panel/useComputerMcpServers')
const { useMcpFlatState } = await import('./useMcpFlatState')
const { useSkillMarketplace } = await import('./useSkillMarketplace')
const { useLegacyContextState } = await import('./useLegacyContextState')
const { useContextItemEditorState } = await import('./useContextItemEditorState')
const { useSkillItem } = await import('./useSkillItem')
const { useStaleSkillCount } = await import('./useStaleSkillCount')
const { useStaleSkillCounts } = await import('./useStaleSkillCounts')

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Each call to `path` gets its own deferred, kept in call order. */
function deferredHandler(path: string): Array<Deferred<unknown>> {
  const list: Array<Deferred<unknown>> = []
  handlers[path] = () => {
    const d = deferred<unknown>()
    list.push(d)
    return d.promise
  }
  return list
}

const callsTo = (path: string) => calls.filter((c) => c.path === path)

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function item(over: Partial<AiConfigItem> = {}): AiConfigItem {
  return {
    id: 'i1',
    type: 'skill',
    scope: 'project',
    project_id: 'p1',
    name: 'one',
    slug: 'one',
    content: 'body',
    metadata_json: '{}',
    created_at: '',
    updated_at: '',
    ...over
  }
}

beforeEach(() => {
  handlers = {}
  calls = []
  client = makeClient()
})

afterEach(() => {
  cleanup()
})

describe('useProjectMcpServers', () => {
  it('loads on mount, reloads with loading=true when the project changes', async () => {
    const discover = deferredHandler('aiConfig.discoverMcpConfigs')
    handlers['settings.get'] = async () => null
    handlers['aiConfig.getProjectProviders'] = async () => ['claude']

    const { result, rerender } = renderHook(
      ({ path, id }: { path: string; id: string }) => useProjectMcpServers(path, id),
      { initialProps: { path: '/a', id: 'p1' } }
    )
    expect(result.current.loading).toBe(true)
    await flush()
    expect(callsTo('aiConfig.discoverMcpConfigs').map((c) => c.input)).toEqual([
      { projectPath: '/a' }
    ])
    expect(result.current.loading).toBe(true)

    await act(async () => discover[0].resolve([]))
    await flush()
    expect(result.current.loading).toBe(false)

    rerender({ path: '/b', id: 'p1' })
    expect(result.current.loading).toBe(true)
    await flush()
    expect(callsTo('aiConfig.discoverMcpConfigs').map((c) => c.input)).toEqual([
      { projectPath: '/a' },
      { projectPath: '/b' }
    ])
    expect(result.current.loading).toBe(true)
    await act(async () => discover[1].resolve([]))
    await flush()
    expect(result.current.loading).toBe(false)

    // Same props → no reload.
    rerender({ path: '/b', id: 'p1' })
    await flush()
    expect(callsTo('aiConfig.discoverMcpConfigs')).toHaveLength(2)
    expect(result.current.loading).toBe(false)
  })

  it('loadConfigs() from a handler shows loading, and a failed load clears it', async () => {
    const discover = deferredHandler('aiConfig.discoverMcpConfigs')
    handlers['settings.get'] = async () => null
    handlers['aiConfig.getProjectProviders'] = async () => []
    const { result } = renderHook(() => useProjectMcpServers('/a', 'p1'))
    await flush()
    await act(async () => discover[0].resolve([]))
    await flush()
    expect(result.current.loading).toBe(false)

    let pending!: Promise<void>
    act(() => {
      pending = result.current.loadConfigs()
    })
    expect(result.current.loading).toBe(true)
    await act(async () => {
      discover[1].reject(new Error('boom'))
      await expect(pending).rejects.toThrow('boom')
    })
    expect(result.current.loading).toBe(false)
  })
})

describe('useComputerMcpServers', () => {
  it('loads favorites and custom servers on mount; loadCustom() reloads', async () => {
    let custom = [{ id: 'c1', name: 'C1', config: { command: 'x', args: [] } }]
    handlers['settings.get'] = async (input) => {
      const key = (input as { key: string }).key
      if (key === 'mcp_favorites') return JSON.stringify(['fav'])
      if (key === 'mcp_custom_servers') return JSON.stringify(custom)
      return null
    }
    const { result } = renderHook(() => useComputerMcpServers())
    await flush()
    expect(result.current.favorites).toEqual(['fav'])
    expect(result.current.filteredCustom.map((s) => s.id)).toEqual(['c1'])

    custom = [...custom, { id: 'c2', name: 'C2', config: { command: 'y', args: [] } }]
    await act(async () => {
      await result.current.loadCustom()
    })
    expect(result.current.filteredCustom.map((s) => s.id)).toEqual(['c1', 'c2'])
  })
})

describe('useMcpFlatState', () => {
  it('loads on mount and reloads with loading=true when projectPath changes', async () => {
    const discover = deferredHandler('aiConfig.discoverMcpConfigs')
    handlers['settings.get'] = async () => null
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useMcpFlatState({ projectPath: path, enabledProviders: [] }),
      { initialProps: { path: '/a' } }
    )
    expect(result.current.loading).toBe(true)
    await flush()
    await act(async () => discover[0].resolve([]))
    await flush()
    expect(result.current.loading).toBe(false)

    rerender({ path: '/b' })
    expect(result.current.loading).toBe(true)
    await flush()
    expect(callsTo('aiConfig.discoverMcpConfigs').map((c) => c.input)).toEqual([
      { projectPath: '/a' },
      { projectPath: '/b' }
    ])
    await act(async () => discover[1].resolve([]))
    await flush()
    expect(result.current.loading).toBe(false)
  })
})

describe('useSkillMarketplace', () => {
  it('loads registries + entries on mount and reloads entries on search', async () => {
    handlers['aiConfig.marketplace.listRegistries'] = async () => [{ id: 'r1' }]
    handlers['aiConfig.marketplace.ensureFresh'] = () => new Promise(() => {})
    const entries = deferredHandler('aiConfig.marketplace.listEntries')

    const { result } = renderHook(() => useSkillMarketplace('p1', '/a'))
    expect(result.current.loading).toBe(true)
    await flush()
    expect(result.current.registries).toEqual([{ id: 'r1' }])
    expect(callsTo('aiConfig.marketplace.listEntries').map((c) => c.input)).toEqual([
      { registryId: undefined, search: undefined, projectId: 'p1' }
    ])
    await act(async () => entries[0].resolve([{ id: 'e1' }]))
    await flush()
    expect(result.current.loading).toBe(false)
    expect(result.current.entries).toEqual([{ id: 'e1' }])

    act(() => result.current.setSearch('lint'))
    expect(result.current.loading).toBe(true)
    await flush()
    expect(callsTo('aiConfig.marketplace.listEntries').at(-1)?.input).toEqual({
      registryId: undefined,
      search: 'lint',
      projectId: 'p1'
    })
    await act(async () => entries[1].resolve([{ id: 'e2' }]))
    await flush()
    expect(result.current.loading).toBe(false)
    expect(result.current.entries).toEqual([{ id: 'e2' }])
  })
})

describe('useLegacyContextState', () => {
  it('loads library skills for the skill section and resets on section change', async () => {
    const list = deferredHandler('aiConfig.listItems')
    const { result, rerender } = renderHook(
      ({ section }: { section: 'skill' | null }) => useLegacyContextState(section),
      { initialProps: { section: null as 'skill' | null } }
    )
    await flush()
    expect(result.current.section).toBe(null)
    expect(result.current.loading).toBe(false)
    expect(callsTo('aiConfig.listItems')).toHaveLength(0)

    act(() => result.current.setEditingId('x'))
    expect(result.current.editingId).toBe('x')

    rerender({ section: 'skill' })
    await flush()
    expect(result.current.section).toBe('skill')
    expect(result.current.editingId).toBe(null)
    expect(result.current.loading).toBe(true)
    expect(callsTo('aiConfig.listItems').map((c) => c.input)).toEqual([
      { scope: 'library', type: 'skill' }
    ])
    await act(async () => list[0].resolve([item({ id: 'a' })]))
    await flush()
    expect(result.current.loading).toBe(false)
    expect(result.current.items.map((i) => i.id)).toEqual(['a'])
  })

  it('starts loading immediately when mounted on the skill section', async () => {
    const list = deferredHandler('aiConfig.listItems')
    const { result } = renderHook(() => useLegacyContextState('skill'))
    await flush()
    expect(result.current.loading).toBe(true)
    expect(callsTo('aiConfig.listItems')).toHaveLength(1)
    await act(async () => list[0].resolve([]))
    await flush()
    expect(result.current.loading).toBe(false)
  })
})

describe('useContextItemEditorState', () => {
  const baseProps = {
    onUpdate: async () => {},
    onDelete: async () => {},
    onClose: () => {}
  }
  const status = (it: AiConfigItem, stale: Array<'claude' | 'codex'>): ProjectSkillStatus => ({
    item: it,
    providers: {
      claude: {
        path: '/c',
        syncHealth: stale.includes('claude') ? 'stale' : 'synced',
        syncReason: null,
        diskContent: 'disk-c'
      },
      codex: {
        path: '/x',
        syncHealth: stale.includes('codex') ? 'stale' : 'synced',
        syncReason: null,
        diskContent: 'disk-x'
      }
    }
  })

  it('resets local slug/content when the item slug or content changes', async () => {
    const first = item()
    const { result, rerender } = renderHook((props) => useContextItemEditorState(props), {
      initialProps: { ...baseProps, item: first }
    })
    act(() => {
      result.current.setSlug('edited')
      result.current.setContent('edited body')
    })
    expect(result.current.slug).toBe('edited')
    // Same slug/content, new object → local edits kept.
    rerender({ ...baseProps, item: { ...first } })
    expect(result.current.slug).toBe('edited')
    expect(result.current.content).toBe('edited body')
    // Content changed → both reset.
    rerender({ ...baseProps, item: { ...first, content: 'server body' } })
    expect(result.current.slug).toBe('one')
    expect(result.current.content).toBe('server body')
  })

  it('auto-selects the first stale provider per item and corrects a non-stale selection', async () => {
    const it1 = item()
    const { result, rerender } = renderHook((props) => useContextItemEditorState(props), {
      initialProps: { ...baseProps, item: it1, syncStatus: status(it1, ['claude', 'codex']) }
    })
    expect(result.current.activeDiffProvider).toBe('claude')
    act(() => result.current.setActiveDiffProvider('codex'))
    expect(result.current.activeDiffProvider).toBe('codex')
    expect(result.current.activeDiffDisk).toBe('disk-x')

    // codex no longer stale → falls back to the first stale provider.
    rerender({ ...baseProps, item: it1, syncStatus: status(it1, ['claude']) })
    expect(result.current.activeDiffProvider).toBe('claude')
    // Nothing stale → cleared.
    rerender({ ...baseProps, item: it1, syncStatus: status(it1, []) })
    expect(result.current.activeDiffProvider).toBe(null)
    // Manually picked provider that is not stale gets corrected straight away.
    act(() => result.current.setActiveDiffProvider('codex'))
    expect(result.current.activeDiffProvider).toBe(null)
  })
})

describe('useSkillItem', () => {
  it('resets content/slug/slugDirty when the item content or slug changes', () => {
    const first = item()
    const props = {
      providers: {},
      enabledProviders: [],
      isLocal: true,
      projectId: 'p1',
      projectPath: '/a',
      onChanged: () => {}
    }
    const { result, rerender } = renderHook((p) => useSkillItem(p), {
      initialProps: { ...props, item: first }
    })
    act(() => result.current.setSlug('renamed'))
    expect(result.current.slugDirty).toBe(true)
    rerender({ ...props, item: { ...first } })
    expect(result.current.slug).toBe('renamed')
    expect(result.current.slugDirty).toBe(true)
    rerender({ ...props, item: { ...first, slug: 'two' } })
    expect(result.current.slug).toBe('two')
    expect(result.current.content).toBe('body')
    expect(result.current.slugDirty).toBe(false)
  })
})

describe('useStaleSkillCount', () => {
  it('fetches for a project, zeroes without one, refetches on focus', async () => {
    let n = 3
    handlers['aiConfig.getProjectStaleSkillCount'] = async () => n
    const { result, rerender } = renderHook(
      ({ id, path }: { id: string | null; path: string | null }) => useStaleSkillCount(id, path),
      { initialProps: { id: 'p1' as string | null, path: '/a' as string | null } }
    )
    await flush()
    expect(result.current.count).toBe(3)

    rerender({ id: null, path: null })
    await flush()
    expect(result.current.count).toBe(0)
    expect(callsTo('aiConfig.getProjectStaleSkillCount')).toHaveLength(1)

    n = 5
    rerender({ id: 'p2', path: '/b' })
    await flush()
    expect(result.current.count).toBe(5)
    expect(callsTo('aiConfig.getProjectStaleSkillCount').at(-1)?.input).toEqual({
      projectId: 'p2',
      projectPath: '/b'
    })

    n = 7
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(result.current.count).toBe(7)
  })
})

describe('useStaleSkillCount without a project at mount', () => {
  it('stays 0 without fetching, then follows a selected project and its removal', async () => {
    handlers['aiConfig.getProjectStaleSkillCount'] = async () => 4
    const { result, rerender } = renderHook(
      ({ id, path }: { id: string | null; path: string | null }) => useStaleSkillCount(id, path),
      { initialProps: { id: null as string | null, path: null as string | null } }
    )
    await flush()
    expect(result.current.count).toBe(0)
    expect(callsTo('aiConfig.getProjectStaleSkillCount')).toHaveLength(0)
    rerender({ id: 'p1', path: '/a' })
    await flush()
    expect(result.current.count).toBe(4)
    rerender({ id: 'p1', path: null })
    await flush()
    expect(result.current.count).toBe(0)
    rerender({ id: 'p1', path: '/a' })
    await flush()
    expect(result.current.count).toBe(4)
    expect(callsTo('aiConfig.getProjectStaleSkillCount')).toHaveLength(2)
  })
})

describe('useStaleSkillCounts', () => {
  it('fetches per project list, clears when no project has a path', async () => {
    handlers['aiConfig.getProjectsStaleSkillCounts'] = async () => ({ p1: 2 })
    const { result, rerender } = renderHook(
      ({ projects }: { projects: Array<{ id: string; path: string | null }> }) =>
        useStaleSkillCounts(projects),
      { initialProps: { projects: [{ id: 'p1', path: '/a' as string | null }] } }
    )
    await flush()
    expect([...result.current.counts]).toEqual([['p1', 2]])
    rerender({ projects: [{ id: 'p1', path: null }] })
    await flush()
    expect(result.current.counts.size).toBe(0)
  })
})
