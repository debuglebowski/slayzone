// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ReactNode } from 'react'

/**
 * Pins where each context-manager section puts its header actions — and, for skills,
 * its editor side panel and resize handle: into the slots of the shell that renders
 * it (ContextManagerShell, the Context Manager page), also when two shells are
 * mounted at once.
 */

type Handler = (input: unknown) => unknown
let handlers: Record<string, Handler> = {}

function makeClient(): unknown {
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
        const handler = handlers[p]
        return Promise.resolve(handler ? handler(args[0]) : undefined)
      }
    })
  return build([])
}
const client = makeClient()

vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => client,
  getTrpcClient: () => client
}))
vi.mock('@slayzone/file-editor/client/useWatchedFile', () => ({
  useWatchedFile: () => ({
    content: '',
    setContent: () => {},
    dirty: false,
    diskChanged: false,
    reloadFromDisk: async () => {},
    flushNow: async () => {},
    onBlur: () => {}
  })
}))
vi.mock('@slayzone/file-editor/client/workspace-target', () => ({
  WorkspaceTargetProvider: ({ children }: { children?: ReactNode }) => <>{children}</>
}))
vi.mock('./SkillGraphCanvas', () => ({ SkillGraphCanvas: () => null }))
vi.mock('./AddItemPicker', () => ({ AddItemPicker: () => null }))
vi.mock('./ContextItemEditor', () => ({
  ContextItemEditor: ({ item }: { item: { id: string } }) => (
    <div data-testid={`skill-editor-${item.id}`} />
  )
}))

const { ContextManagerShell } = await import('./ContextManagerShell')
const { useContextManagerStore } = await import('./useContextManagerStore')

const SKILL = {
  id: 's1',
  type: 'skill',
  scope: 'library',
  project_id: null,
  slug: 'alpha',
  content: '---\nname: alpha\ndescription: a\n---\n',
  metadata_json: '{}',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z'
}

function defaultHandlers(): Record<string, Handler> {
  return {
    'settings.get': () => null,
    'aiConfig.getProjectStaleSkillCount': () => 0,
    'aiConfig.getComputerFiles': () => [],
    'aiConfig.listInstructionVariants': () => [],
    'aiConfig.getRootInstructions': () => ({ content: '', providerHealth: {} }),
    'aiConfig.getProjectInstructionVariant': () => null,
    'aiConfig.listItems': () => [SKILL],
    'aiConfig.getProjectSkillsStatus': () => [],
    'aiConfig.getProjectProviders': () => [],
    'aiConfig.marketplace.checkUpdates': () => [],
    'aiConfig.discoverMcpConfigs': () => []
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

function slot(root: HTMLElement, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`#${id}`)
  if (!el) throw new Error(`no #${id} in this shell`)
  return el
}
const header = (root: HTMLElement) => slot(root, 'context-manager-header-actions')

/** A second mount point after the first in document order, like a dialog portal. */
function secondRoot(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

function renderPage(level: 'computer' | 'project' | 'library', section: string) {
  act(() => {
    useContextManagerStore.setState({ activeLevel: level, activeSection: section, isLoaded: true })
  })
  return render(<ContextManagerShell selectedProjectId="p1" projectPath="/p" onBack={() => {}} />)
}

beforeEach(() => {
  handlers = defaultHandlers()
  useContextManagerStore.setState({ skillEditorWidth: null, pendingLibrarySkillId: null })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('Context Manager page (ContextManagerShell)', () => {
  it('Files: the header actions appear once the files have loaded', async () => {
    let release!: () => void
    handlers['aiConfig.getComputerFiles'] = () =>
      new Promise((res) => {
        release = () => res([])
      })
    const { container } = renderPage('computer', 'files')
    await flush()
    expect(header(container).textContent).toBe('')

    release()
    await flush()
    expect(within(header(container)).getByText('Line counts')).toBeTruthy()
    expect(within(header(container)).getByText('Content match')).toBeTruthy()
  })

  it('Project instructions: "Use library variant" in the header', async () => {
    const { container } = renderPage('project', 'instructions')
    await flush()
    expect(within(header(container)).getByText('Use library variant')).toBeTruthy()
  })

  it('Library instructions: "New Variant" in the header', async () => {
    const { container } = renderPage('library', 'instructions')
    await flush()
    expect(within(header(container)).getByText('New Variant')).toBeTruthy()
  })

  it('Project MCPs: search + "Custom" in the header', async () => {
    const { container } = renderPage('project', 'mcps')
    await flush()
    expect(within(header(container)).getByText('Custom')).toBeTruthy()
    expect(within(header(container)).getByRole('textbox')).toBeTruthy()
  })

  it('Library MCPs: search + "Custom" in the header', async () => {
    const { container } = renderPage('library', 'mcps')
    await flush()
    expect(within(header(container)).getByText('Custom')).toBeTruthy()
    expect(within(header(container)).getByRole('textbox')).toBeTruthy()
  })

  it('Library skills: actions in the header; a selected skill opens in the editor panel', async () => {
    const { container } = renderPage('library', 'skills')
    await flush()
    expect(within(header(container)).getByText('Add Skill')).toBeTruthy()
    const editorPanel = slot(container, 'context-manager-editor-panel')
    const handle = slot(container, 'context-manager-resize-handle')
    expect(editorPanel.childElementCount).toBe(0)
    expect(handle.childElementCount).toBe(0)

    fireEvent.click(within(container).getByText('alpha'))
    await flush()
    expect(within(editorPanel).getByTestId('skill-editor-s1')).toBeTruthy()
    expect(handle.childElementCount).toBe(1)
    expect(editorPanel.style.width).toBe('50%')

    act(() => {
      useContextManagerStore.getState().setSkillEditorWidth(420)
    })
    expect(editorPanel.style.width).toBe('420px')

    // Leaving the section takes the editor and its handle out; the empty panel is
    // hidden by its `empty:hidden` class.
    act(() => {
      useContextManagerStore.getState().setActive('library', 'instructions')
    })
    await flush()
    expect(editorPanel.childElementCount).toBe(0)
    expect(handle.childElementCount).toBe(0)
    expect(editorPanel.className).toContain('empty:hidden')
  })

  it('"Go to source" from a project skill opens that skill in the library', async () => {
    const PROJECT_SKILL = { ...SKILL, id: 'p-own', scope: 'project', project_id: 'p1', slug: 'own' }
    handlers['aiConfig.listItems'] = (input) =>
      (input as { scope: string }).scope === 'library' ? [SKILL] : [PROJECT_SKILL]
    handlers['aiConfig.getProjectSkillsStatus'] = () => [{ item: SKILL, providers: {} }]
    const { container } = renderPage('project', 'skills')
    await flush()
    const editorPanel = slot(container, 'context-manager-editor-panel')
    expect(editorPanel.childElementCount).toBe(0)

    act(() => {
      useContextManagerStore.getState().navigateToLibrarySkill('s1')
    })
    await flush()
    expect(useContextManagerStore.getState().activeLevel).toBe('library')
    expect(within(editorPanel).getByTestId('skill-editor-s1')).toBeTruthy()
    expect(useContextManagerStore.getState().pendingLibrarySkillId).toBe(null)
  })

  it('a library skill requested before the page opens is selected once it loads', async () => {
    act(() => {
      useContextManagerStore.getState().navigateToLibrarySkill('s1')
    })
    const { container } = renderPage('library', 'skills')
    await flush()
    const editorPanel = slot(container, 'context-manager-editor-panel')
    expect(within(editorPanel).getByTestId('skill-editor-s1')).toBeTruthy()
    expect(useContextManagerStore.getState().pendingLibrarySkillId).toBe(null)
  })

  it('switching section: the new section portals into the same header, never inline', async () => {
    const { container } = renderPage('library', 'instructions')
    await flush()
    const main = header(container).closest('.flex-col') as HTMLElement
    // Every insertion/removal of the MCP actions outside the header. A removed node
    // keeps its subtree, so an inline render later moved into the header shows up here.
    const inline: string[] = []
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (header(container).contains(r.target)) continue
        for (const n of [...r.addedNodes, ...r.removedNodes])
          if (
            n instanceof HTMLElement &&
            n.querySelector('input') &&
            /Custom/.test(n.textContent ?? '')
          )
            inline.push(n.outerHTML)
      }
    })
    observer.observe(main, { childList: true, subtree: true })

    act(() => {
      useContextManagerStore.getState().setActive('library', 'mcps')
    })
    await flush()
    observer.disconnect()
    expect(within(header(container)).getByText('Custom')).toBeTruthy()
    expect(within(header(container)).queryByText('New Variant')).toBeNull()
    expect(inline).toEqual([])
  })
})

describe('two shells mounted at once: each section uses its OWN shell', () => {
  it('page (MCPs) + a second page (MCPs)', async () => {
    const page = renderPage('library', 'mcps')
    await flush()
    const second = render(
      <ContextManagerShell selectedProjectId="p1" projectPath="/p" onBack={() => {}} />,
      { container: secondRoot() }
    )
    await flush()
    expect(within(header(page.container)).getAllByText('Custom')).toHaveLength(1)
    expect(within(header(second.container)).getAllByText('Custom')).toHaveLength(1)
  })
})
