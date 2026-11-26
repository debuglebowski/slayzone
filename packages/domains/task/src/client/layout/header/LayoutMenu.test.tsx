// @vitest-environment jsdom
// Pins the Layout menu (docs/plans/panel-model.md step 10): enabled layouts with
// thumbnails, "· edited" and ⌃⌥N in position order, the "Unsaved changes" header
// (Revert / Save as… / Save) only while dirty, Save offered only with a definition.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ResolvedLayoutDefinition } from '@slayzone/task-contracts'
import { TooltipProvider } from '@slayzone/ui'
import { LayoutMenu, type LayoutMenuProps } from './LayoutMenu'

function def(id: string, patch: Partial<ResolvedLayoutDefinition> = {}): ResolvedLayoutDefinition {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    builtin: true,
    enabled: true,
    edited: false,
    columns: [
      {
        id: 'terminal',
        size: { unit: 'fr', value: 1 },
        slots: [
          {
            id: 'terminal',
            weight: 1,
            activeInstanceId: 'terminal',
            tabs: [{ instanceId: 'terminal' }]
          }
        ]
      }
    ],
    instances: { terminal: { id: 'terminal', kind: 'agent', settings: {} } },
    ...patch
  }
}

const layouts = [
  def('classic', { edited: true }),
  def('focus', { enabled: false }),
  def('pair'),
  def('mine', { builtin: false })
]

function open(props: Partial<LayoutMenuProps> = {}) {
  const handlers = {
    onSelectLayout: vi.fn(),
    onRevert: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onManage: vi.fn()
  }
  render(
    <TooltipProvider>
      <LayoutMenu layouts={layouts} current={layouts[0]} dirty={false} {...handlers} {...props} />
    </TooltipProvider>
  )
  fireEvent.pointerDown(screen.getByTestId('layout-menu'), { button: 0, ctrlKey: false })
  return handlers
}

afterEach(cleanup)

describe('LayoutMenu', () => {
  it('lists the enabled layouts with edited marks and position shortcuts', async () => {
    const h = open()
    const menu = await screen.findByTestId('layout-menu-content')
    expect(within(menu).queryByTestId('layout-option-focus')).toBeNull()
    expect(within(menu).getByTestId('layout-option-classic').textContent).toContain('· edited')
    // pair is the second ENABLED layout: ⌃⌥2 (rendered per platform)
    expect(within(menu).getByTestId('layout-option-pair').textContent).toMatch(/2$/)
    expect(within(menu).getByTestId('layout-option-classic').dataset.current).toBe('true')
    expect(within(menu).queryByTestId('layout-unsaved')).toBeNull()
    fireEvent.click(within(menu).getByTestId('layout-option-mine'))
    expect(h.onSelectLayout).toHaveBeenCalledWith('mine')
  })

  it('shows Unsaved changes with Revert / Save as… / Save while dirty', async () => {
    const h = open({ dirty: true })
    const unsaved = await screen.findByTestId('layout-unsaved')
    fireEvent.click(within(unsaved).getByTestId('layout-save'))
    expect(h.onSave).toHaveBeenCalled()
  })

  it('without a definition: Save as… only, named Custom', async () => {
    open({ dirty: true, current: null })
    const unsaved = await screen.findByTestId('layout-unsaved')
    expect(within(unsaved).queryByTestId('layout-save')).toBeNull()
    expect(within(unsaved).queryByTestId('layout-revert')).toBeNull()
    expect(within(unsaved).getByTestId('layout-save-as')).toBeTruthy()
    expect(screen.getByTestId('layout-menu-current').textContent).toBe('Custom')
  })
})
