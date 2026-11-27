// @vitest-environment jsdom
// Pins the panel close request (docs/plans/panel-model.md step 8): a kind's
// onCloseRequest decides — the agent confirms while its session runs, other kinds
// close right away.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TaskLayout } from '@slayzone/task-contracts'
import { usePanelCloseRequest } from './usePanelCloseRequest'

const layout: TaskLayout = {
  v: 1,
  rev: 1,
  layoutId: 'classic',
  columns: [
    {
      id: 'c',
      size: { unit: 'fr', value: 1 },
      slots: [
        {
          id: 's',
          weight: 1,
          activeInstanceId: 'terminal',
          tabs: [{ instanceId: 'terminal' }, { instanceId: 'settings' }]
        }
      ]
    }
  ],
  instances: {
    terminal: { id: 'terminal', kind: 'agent', settings: {} },
    settings: { id: 'settings', kind: 'settings', settings: {} }
  }
}

function Harness({
  closeTab,
  live,
  target
}: {
  closeTab: (id: string) => void
  live: boolean
  target: string
}) {
  const { requestClose, dialog } = usePanelCloseRequest({
    layout,
    closeTab,
    isSessionLive: async () => live
  })
  return (
    <>
      <button type="button" onClick={() => requestClose(target)}>
        close
      </button>
      {dialog}
    </>
  )
}

afterEach(cleanup)

async function clickClose() {
  await act(async () => {
    fireEvent.click(screen.getByText('close'))
    await Promise.resolve()
  })
}

describe('usePanelCloseRequest', () => {
  it('closes a kind without onCloseRequest right away', async () => {
    const closeTab = vi.fn()
    render(<Harness closeTab={closeTab} live target="settings" />)
    await clickClose()
    expect(closeTab).toHaveBeenCalledWith('settings')
  })

  it('closes an agent whose session is not running right away', async () => {
    const closeTab = vi.fn()
    render(<Harness closeTab={closeTab} live={false} target="terminal" />)
    await clickClose()
    expect(closeTab).toHaveBeenCalledWith('terminal')
  })

  it('asks before closing an agent whose session runs; Cancel keeps it', async () => {
    const closeTab = vi.fn()
    render(<Harness closeTab={closeTab} live target="terminal" />)
    await clickClose()
    expect(closeTab).not.toHaveBeenCalled()
    expect(await screen.findByText('Close the agent?')).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))
    expect(closeTab).not.toHaveBeenCalled()

    await clickClose()
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect(closeTab).toHaveBeenCalledWith('terminal')
  })
})
