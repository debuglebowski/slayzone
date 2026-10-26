// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Pins what the ai-config views render around their mount loads, prop-driven form
 * fills and trigger-counter props: the loading → loaded sequence, which tRPC calls
 * go out, and what a dialog shows each time it opens.
 */

type Handler = (input: unknown) => Promise<unknown>
let handlers: Record<string, Handler> = {}
let calls: Array<{ path: string; input: unknown }> = []

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

type Kids = { children?: React.ReactNode }
vi.mock('@slayzone/ui', () => {
  const Pass = ({ children }: Kids) => <>{children}</>
  const Div = ({ children }: Kids) => <div>{children}</div>
  return {
    cn: (...xs: unknown[]) => xs.filter(Boolean).join(' '),
    Button: ({ children, variant: _v, size: _s, ...props }: Record<string, unknown> & Kids) => (
      <button {...(props as React.ComponentProps<'button'>)}>{children}</button>
    ),
    IconButton: ({ children, ...props }: React.ComponentProps<'button'>) => (
      <button {...props}>{children}</button>
    ),
    Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
    Label: ({ children }: Kids) => <label>{children}</label>,
    Textarea: (props: React.ComponentProps<'textarea'>) => <textarea {...props} />,
    Dialog: ({ open, children }: { open: boolean } & Kids) => (open ? <div>{children}</div> : null),
    DialogContent: Div,
    DialogHeader: Div,
    DialogTitle: Div,
    DialogFooter: Div,
    Tooltip: Pass,
    TooltipTrigger: Pass,
    TooltipContent: () => null,
    FileTree: ({ items }: { items: Array<{ relativePath: string }> }) => (
      <ul>
        {items.map((i) => (
          <li key={i.relativePath}>{i.relativePath}</li>
        ))}
      </ul>
    ),
    fileTreeIndent: () => 0,
    toast: { success: vi.fn(), error: vi.fn() }
  }
})

vi.mock('./LibraryItemPicker', () => ({
  LibraryItemPicker: () => <div data-testid="library-picker" />
}))
vi.mock('./ContextItemEditor', () => ({
  ContextItemEditor: ({ item }: { item: { id: string } }) => (
    <div data-testid={`editor-${item.id}`} />
  )
}))

const { ProjectSkills } = await import('./ProjectSkills')
const { AddComputerMcpDialog } = await import('./mcp-servers-panel/dialogs/AddComputerMcpDialog')
const { AddProjectMcpDialog } = await import('./mcp-servers-panel/dialogs/AddProjectMcpDialog')
const { ComputerMcpView } = await import('./ComputerMcpView')
const { ContextFilesPanel } = await import('./ContextFilesPanel')
const { ProviderSyncSection } = await import('./ProviderSyncSection')
const { ProjectContextFilesView } = await import('./ProjectContextFilesView')

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

beforeEach(() => {
  handlers = {}
  calls = []
  client = makeClient()
})
afterEach(() => cleanup())

describe('ProjectSkills', () => {
  const props = { projectId: 'p1', projectPath: '/a' }

  it('shows Loading until both lists arrive; reloads on project change', async () => {
    const status = deferredHandler('aiConfig.getProjectSkillsStatus')
    handlers['aiConfig.listItems'] = async () => []
    const { rerender } = render(<ProjectSkills {...props} />)
    expect(screen.getByText('Loading...')).toBeTruthy()
    await flush()
    expect(screen.getByText('Loading...')).toBeTruthy()
    await act(async () => status[0].resolve([]))
    await flush()
    expect(screen.getByText('No skills yet')).toBeTruthy()

    rerender(<ProjectSkills projectId="p2" projectPath="/b" />)
    expect(screen.getByText('Loading...')).toBeTruthy()
    await flush()
    expect(callsTo('aiConfig.getProjectSkillsStatus').map((c) => c.input)).toEqual([
      { projectId: 'p1', projectPath: '/a' },
      { projectId: 'p2', projectPath: '/b' }
    ])
    await act(async () => status[1].resolve([]))
    await flush()
    expect(screen.getByText('No skills yet')).toBeTruthy()
  })

  it('opens the picker for a positive trigger at mount and on every bump', async () => {
    handlers['aiConfig.getProjectSkillsStatus'] = async () => []
    handlers['aiConfig.listItems'] = async () => []
    const { rerender } = render(<ProjectSkills {...props} openPickerTrigger={0} />)
    await flush()
    expect(screen.queryByTestId('library-picker')).toBeNull()
    rerender(<ProjectSkills {...props} openPickerTrigger={1} />)
    await flush()
    expect(screen.getByTestId('library-picker')).toBeTruthy()
    cleanup()

    render(<ProjectSkills {...props} openPickerTrigger={3} />)
    await flush()
    expect(screen.getByTestId('library-picker')).toBeTruthy()
  })

  it('creates a skill once per create-trigger bump and opens its editor', async () => {
    handlers['aiConfig.getProjectSkillsStatus'] = async () => []
    handlers['aiConfig.listItems'] = async () => []
    let n = 0
    handlers['aiConfig.createItem'] = async () => ({
      id: `new-${++n}`,
      type: 'skill',
      scope: 'project',
      project_id: 'p1',
      name: 'new-skill',
      slug: 'new-skill',
      content: '',
      metadata_json: '{}',
      created_at: '',
      updated_at: ''
    })
    const onChanged = vi.fn()
    const { rerender } = render(
      <ProjectSkills {...props} openCreateTrigger={0} onChanged={onChanged} />
    )
    await flush()
    expect(callsTo('aiConfig.createItem')).toHaveLength(0)
    rerender(<ProjectSkills {...props} openCreateTrigger={1} onChanged={onChanged} />)
    await flush()
    expect(callsTo('aiConfig.createItem')).toHaveLength(1)
    expect(screen.getByTestId('editor-new-1')).toBeTruthy()
    expect(onChanged).toHaveBeenCalledTimes(1)
    rerender(<ProjectSkills {...props} openCreateTrigger={1} onChanged={onChanged} />)
    await flush()
    expect(callsTo('aiConfig.createItem')).toHaveLength(1)
  })
})

describe('AddComputerMcpDialog / AddProjectMcpDialog', () => {
  const editTarget = {
    originalKey: 'srv',
    server: {
      id: 'srv',
      name: 'srv',
      description: 'desc',
      config: { command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } }
    }
  }

  it('fills the form from editTarget on open and clears it for a fresh add', () => {
    const base = { onOpenChange: vi.fn(), onAdded: vi.fn() }
    const { rerender } = render(<AddComputerMcpDialog {...base} open editTarget={editTarget} />)
    expect((screen.getByPlaceholderText('my-server') as HTMLInputElement).value).toBe('srv')
    expect((screen.getByPlaceholderText('npx') as HTMLInputElement).value).toBe('npx')
    expect((screen.getByPlaceholderText('-y @foo/bar') as HTMLInputElement).value).toBe('-y pkg')
    expect((screen.getByPlaceholderText('KEY') as HTMLInputElement).value).toBe('A')

    // User edits survive unrelated re-renders.
    fireEvent.change(screen.getByPlaceholderText('npx'), { target: { value: 'node' } })
    rerender(<AddComputerMcpDialog {...base} open editTarget={editTarget} />)
    expect((screen.getByPlaceholderText('npx') as HTMLInputElement).value).toBe('node')

    // Close keeps state; reopen as a fresh add resets.
    rerender(<AddComputerMcpDialog {...base} open={false} editTarget={null} />)
    rerender(<AddComputerMcpDialog {...base} open editTarget={null} />)
    expect((screen.getByPlaceholderText('my-server') as HTMLInputElement).value).toBe('')
    expect((screen.getByPlaceholderText('npx') as HTMLInputElement).value).toBe('')
    expect(screen.queryByPlaceholderText('KEY')).toBeNull()

    // Reopening the same edit target re-fills it.
    fireEvent.change(screen.getByPlaceholderText('npx'), { target: { value: 'typed' } })
    rerender(<AddComputerMcpDialog {...base} open={false} editTarget={editTarget} />)
    rerender(<AddComputerMcpDialog {...base} open editTarget={editTarget} />)
    expect((screen.getByPlaceholderText('npx') as HTMLInputElement).value).toBe('npx')
  })

  it('project dialog seeds provider checkboxes from availableProviders / editProviders', () => {
    const base = {
      onOpenChange: vi.fn(),
      onAdded: vi.fn(),
      projectPath: '/a',
      availableProviders: ['claude', 'codex'] as Array<'claude' | 'codex'>
    }
    const { rerender } = render(<AddProjectMcpDialog {...base} open editTarget={null} />)
    const boxes = () =>
      (screen.getAllByRole('checkbox') as HTMLInputElement[]).map((b) => b.checked)
    expect(boxes()).toEqual([true, true])
    rerender(<AddProjectMcpDialog {...base} open={false} editTarget={null} />)
    rerender(
      <AddProjectMcpDialog {...base} open editTarget={editTarget} editProviders={['codex']} />
    )
    expect(boxes()).toEqual([false, true])
    expect((screen.getByPlaceholderText('my-server') as HTMLInputElement).value).toBe('srv')
  })
})

describe('ComputerMcpView', () => {
  it('shows loading until configs arrive', async () => {
    const discover = deferredHandler('aiConfig.discoverComputerMcpConfigs')
    render(<ComputerMcpView />)
    expect(screen.getByText('Loading computer MCP configs...')).toBeTruthy()
    await flush()
    expect(callsTo('aiConfig.discoverComputerMcpConfigs')).toHaveLength(1)
    await act(async () => discover[0].resolve([]))
    await flush()
    expect(screen.getByText('Computer MCP Servers')).toBeTruthy()
  })
})

describe('ContextFilesPanel', () => {
  it('discovers files on mount and again when projectPath changes', async () => {
    handlers['aiConfig.discoverContextFiles'] = async (input) => [
      {
        path: `${(input as { projectPath: string }).projectPath}/CLAUDE.md`,
        name: 'CLAUDE.md',
        exists: true
      }
    ]
    const { rerender } = render(<ContextFilesPanel projectPath="/a" />)
    await flush()
    expect(screen.getByText('CLAUDE.md')).toBeTruthy()
    rerender(<ContextFilesPanel projectPath="/b" />)
    await flush()
    expect(callsTo('aiConfig.discoverContextFiles').map((c) => c.input)).toEqual([
      { projectPath: '/a' },
      { projectPath: '/b' }
    ])
  })
})

describe('ProviderSyncSection', () => {
  it('loads providers then project providers, and reloads on sz:settings-changed', async () => {
    handlers['aiConfig.listProviders'] = async () => [
      { id: 'claude', name: 'Claude', enabled: true, isDefault: false }
    ]
    handlers['aiConfig.getProjectProviders'] = async () => ['claude']
    render(<ProviderSyncSection projectId="p1" />)
    await flush()
    expect(callsTo('aiConfig.listProviders')).toHaveLength(1)
    expect(callsTo('aiConfig.getProjectProviders').map((c) => c.input)).toEqual([
      { projectId: 'p1' }
    ])
    expect(screen.getAllByRole('switch').length).toBeGreaterThan(0)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('sz:settings-changed'))
    })
    await flush()
    expect(callsTo('aiConfig.listProviders')).toHaveLength(2)
  })

  it('skips project providers without a project', async () => {
    handlers['aiConfig.listProviders'] = async () => []
    render(<ProviderSyncSection projectId={null} />)
    await flush()
    expect(callsTo('aiConfig.listProviders')).toHaveLength(1)
    expect(callsTo('aiConfig.getProjectProviders')).toHaveLength(0)
  })
})

describe('ProjectContextFilesView', () => {
  it('shows the loading state while the first tree load is in flight', async () => {
    const tree = deferredHandler('aiConfig.getContextTree')
    const { rerender } = render(<ProjectContextFilesView projectId="p1" projectPath="/a" />)
    await flush()
    expect(screen.getByText('Loading files...')).toBeTruthy()
    await act(async () =>
      tree[0].resolve([
        { path: '/a/CLAUDE.md', relativePath: 'CLAUDE.md', exists: true, syncHealth: 'synced' }
      ])
    )
    await flush()
    expect(screen.getByText('CLAUDE.md')).toBeTruthy()
    expect(screen.getByText('Refresh').closest('button')?.disabled).toBe(false)

    rerender(<ProjectContextFilesView projectId="p1" projectPath="/b" />)
    await flush()
    expect(callsTo('aiConfig.getContextTree').map((c) => c.input)).toEqual([
      { projectPath: '/a', projectId: 'p1' },
      { projectPath: '/b', projectId: 'p1' }
    ])
    // Entries stay on screen while reloading; Refresh is disabled meanwhile.
    expect(screen.getByText('CLAUDE.md')).toBeTruthy()
    expect(screen.getByText('Refresh').closest('button')?.disabled).toBe(true)
    await act(async () => tree[1].resolve([]))
    await flush()
    expect(screen.getByText('No context files found.')).toBeTruthy()
  })
})
