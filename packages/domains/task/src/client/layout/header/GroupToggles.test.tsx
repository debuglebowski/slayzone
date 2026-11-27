// @vitest-environment jsdom
// Pins the title row's group toggles (docs/plans/panel-model.md step 9): a toggle
// per group shows/hides it, a hidden group's icon is gray, and right-click renames.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TaskLayout } from '@slayzone/task-contracts'
import { TooltipProvider } from '@slayzone/ui'
import { GroupToggles, type GroupTogglesProps } from './GroupToggles'
import { layoutGroups } from './groups'

const layout: TaskLayout = {
  v: 1,
  rev: 1,
  layoutId: 'classic',
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
    },
    {
      id: 'browser',
      size: { unit: 'fr', value: 1 },
      slots: [
        {
          id: 'browser',
          hidden: true,
          weight: 1,
          activeInstanceId: 'browser',
          tabs: [{ instanceId: 'browser' }, { instanceId: 'editor' }]
        }
      ]
    }
  ],
  instances: {
    terminal: { id: 'terminal', kind: 'agent', settings: {} },
    browser: { id: 'browser', kind: 'browser', settings: {} },
    editor: { id: 'editor', kind: 'editor', settings: {} }
  }
}

const groups = layoutGroups(layout, { webPanels: [], isTabListed: () => true })

function renderToggles(props: Partial<GroupTogglesProps> = {}) {
  const onToggle = vi.fn()
  const onRename = vi.fn()
  render(
    <TooltipProvider>
      <GroupToggles
        groups={groups}
        webPanels={[]}
        mode="toggles"
        align="end"
        onToggle={onToggle}
        shortcutOf={() => null}
        onRename={onRename}
        {...props}
      />
    </TooltipProvider>
  )
  return { onToggle, onRename }
}

afterEach(cleanup)

describe('GroupToggles', () => {
  it('one toggle per group, named, pressed while shown; click flips it', () => {
    const { onToggle } = renderToggles()
    const agent = screen.getByRole('button', { name: 'Agent' })
    const web = screen.getByRole('button', { name: 'Browser + Editor' })
    expect(agent.getAttribute('aria-pressed')).toBe('true')
    expect(web.getAttribute('aria-pressed')).toBe('false')
    // Shown: coloured kind icon; hidden: gray.
    expect(agent.querySelector('svg')?.getAttribute('class')).toContain('text-agent')
    expect(web.querySelector('svg')?.getAttribute('class')).not.toContain('text-info')
    fireEvent.click(web)
    expect(onToggle).toHaveBeenCalledWith(groups[1], true)
    fireEvent.click(agent)
    expect(onToggle).toHaveBeenCalledWith(groups[0], false)
  })

  it('right-click → Rename names the group (blank = from its contents)', async () => {
    const { onRename } = renderToggles()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Browser + Editor' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const field = await screen.findByRole('textbox', { name: 'Group name' })
    expect(field.getAttribute('placeholder')).toBe('Browser + Editor')
    fireEvent.change(field, { target: { value: 'Web' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onRename).toHaveBeenCalledWith('browser', 'Web')
  })

  it('menu mode lists the groups in a Panels dropdown', async () => {
    const { onToggle } = renderToggles({ mode: 'menu' })
    expect(screen.queryByRole('button', { name: 'Agent' })).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Panels' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Browser + Editor' }))
    expect(onToggle).toHaveBeenCalledWith(groups[1], true)
  })
})
