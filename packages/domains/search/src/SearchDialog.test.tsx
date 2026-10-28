// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { usePaletteCommandStore, type PaletteCommand } from '@slayzone/ui'
import { useDialogStore } from '@slayzone/dialogs'

vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))

import { SearchDialog } from './SearchDialog'

interface Deferred {
  resolve: (files: string[]) => void
}

let wrapper: (props: { children: ReactNode }) => ReactNode
let listAllFiles: Mock<(input: { rootPath: string }) => Promise<unknown>>
/** Pending listAllFiles answers by root path; unset = answer at once from `filesByRoot`. */
let pending: Map<string, Deferred> | null
const filesByRoot: Record<string, string[]> = {
  '/a': ['alpha-only.ts'],
  '/b': ['beta-only.ts']
}

function Host() {
  const open = useDialogStore((s) => s.searchOpen)
  return (
    <SearchDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) useDialogStore.getState().closeSearch()
      }}
      tasks={[]}
      projects={[]}
      closedTabs={[]}
      openTaskTabs={[]}
      activeTaskId={null}
      onSelectTask={vi.fn()}
      onSelectProject={vi.fn()}
      onNewTask={vi.fn()}
      onNewTemporaryTask={vi.fn()}
      onReopenClosedTab={vi.fn()}
      onAddProject={vi.fn()}
      onGoHome={vi.fn()}
      onToggleGlobalAgentPanel={vi.fn()}
      onOpenChangelog={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  )
}

function renderHost() {
  const Wrapper = wrapper
  return render(
    <Wrapper>
      <Host />
    </Wrapper>
  )
}

async function openPalette(projectPath?: string) {
  await act(async () => {
    useDialogStore
      .getState()
      .openSearch(projectPath ? { fileContext: { projectPath, openFile: vi.fn() } } : undefined)
  })
}

async function closePalette() {
  await act(async () => {
    fireEvent.keyDown(input(), { key: 'Escape' })
  })
  expect(screen.queryByRole('dialog')).toBeNull()
}

const input = () => screen.getByRole('combobox') as HTMLInputElement

/** A query answer reaches React on react-query's next-macrotask notify. */
async function flushQueries() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function type(value: string) {
  await act(async () => {
    fireEvent.change(input(), { target: { value } })
  })
}

async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    fireEvent.keyDown(input(), { key: k, ...init })
  })
}

const selectedValue = () =>
  document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value')

const activeFilter = () =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    b.className.includes('text-accent-foreground')
  )?.textContent

function publishScope(commands: PaletteCommand[]) {
  usePaletteCommandStore.getState().publish(Symbol('task'), {
    key: 't1',
    title: 'My task',
    commands
  })
}

beforeEach(() => {
  // jsdom has no layout: cmdk scrolls the selected row into view.
  Element.prototype.scrollIntoView = vi.fn()
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  pending = null
  listAllFiles = vi.fn(
    ({ rootPath }) =>
      new Promise((resolve) => {
        const answer = (files: string[]) => resolve({ files, truncated: false })
        if (pending) pending.set(rootPath, { resolve: answer })
        else answer(filesByRoot[rootPath] ?? [])
      })
  )
  wrapper = createTrpcTest({
    procedures: { 'fileEditor.listAllFiles': listAllFiles }
  }).wrapper
  useDialogStore.getState().closeSearch()
  usePaletteCommandStore.setState({ scope: null, owner: null })
})

afterEach(() => {
  cleanup()
})

describe('SearchDialog reopen', () => {
  it('reopening clears the search and the filter', async () => {
    renderHost()
    await openPalette()
    await type('new')
    await key('Tab')
    expect(activeFilter()).not.toBe('All')
    await closePalette()

    await openPalette()
    expect(input().value).toBe('')
    await type('new')
    expect(activeFilter()).toBe('All')
  })

  it('reopening leaves a sub-page', async () => {
    publishScope([
      {
        id: 'status',
        label: 'Change status',
        featured: true,
        page: {
          kind: 'list',
          title: 'Status',
          items: [{ id: 'done', label: 'Done', run: vi.fn() }]
        }
      }
    ])
    renderHost()
    await openPalette()
    await key('Enter')
    expect(screen.queryByText('Backspace to go back')).not.toBeNull()
    await closePalette()

    await openPalette()
    expect(screen.queryByText('Backspace to go back')).toBeNull()
  })

  it('a focus-taking command runs after the dialog has closed', async () => {
    const order: string[] = []
    publishScope([
      {
        id: 'focus',
        label: 'Focus thing',
        featured: true,
        takesFocus: true,
        run: () => {
          order.push(screen.queryByRole('dialog') ? 'ran while open' : 'ran after close')
        }
      }
    ])
    renderHost()
    await openPalette()
    await key('Enter')
    // Radix restores focus (onCloseAutoFocus) on a timer after the trap unmounts.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(order).toEqual(['ran after close'])
  })

  it('the best hit stays highlighted while typing', async () => {
    renderHost()
    await openPalette()
    await type('settings')
    expect(selectedValue()).toBe('action:open-settings')
  })

  it('lists the project files, fetched once per project across reopens', async () => {
    renderHost()
    await openPalette('/a')
    await flushQueries()
    await type('alpha')
    expect(document.body.textContent).toContain('alpha-only.ts')
    await closePalette()

    await openPalette('/a')
    await type('alpha')
    expect(document.body.textContent).toContain('alpha-only.ts')
    expect(listAllFiles).toHaveBeenCalledTimes(1)
  })

  // Bug 2: the row last arrowed to stayed highlighted when nothing was typed.
  it('reopening highlights the top row', async () => {
    renderHost()
    await openPalette()
    const top = selectedValue()
    expect(top).toBe('action:new-task')
    await key('ArrowDown')
    await key('ArrowDown')
    expect(selectedValue()).not.toBe(top)
    await closePalette()

    await openPalette()
    expect(selectedValue()).toBe(top)
  })

  // Bug 3: a list that arrives late filled whichever project the palette showed by then.
  it("never shows another project's files", async () => {
    pending = new Map()
    renderHost()
    await openPalette('/a')
    await closePalette()
    await openPalette('/b')
    await act(async () => {
      pending?.get('/a')?.resolve(filesByRoot['/a'])
    })
    await flushQueries()
    await type('only')
    expect(document.body.textContent).not.toContain('alpha-only.ts')

    await act(async () => {
      pending?.get('/b')?.resolve(filesByRoot['/b'])
    })
    await flushQueries()
    await type('beta')
    expect(document.body.textContent).toContain('beta-only.ts')
    expect(document.body.textContent).not.toContain('alpha-only.ts')
  })
})
