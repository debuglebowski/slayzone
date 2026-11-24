// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Pins the full-window Settings view's open/close behavior: it renders only while
 * open, shows the routed page, and Esc / "Back to app" close it — except when Esc
 * belongs to an open dialog or a focused field.
 */

vi.mock('./SettingsNav', () => ({ SettingsNav: () => <nav data-testid="nav" /> }))
vi.mock('./SettingsPages', () => ({
  SettingsPage: ({ route }: { route: unknown }) => (
    <div data-testid="page">{JSON.stringify(route)}</div>
  )
}))

const { SettingsView } = await import('./SettingsView')
const { closeSettings, installSettingsEventBridge, openSettings, useSettingsViewStore } =
  await import('../settings-view-store')

afterEach(() => {
  cleanup()
  act(() => closeSettings())
  document.body.innerHTML = ''
})

const page = () => screen.getByTestId('page').textContent

describe('SettingsView', () => {
  it('renders nothing while closed, the routed page while open', () => {
    render(<SettingsView />)
    expect(screen.queryByTestId('settings-view')).toBeNull()
    act(() => openSettings('mcp'))
    expect(screen.getByTestId('settings-view')).toBeTruthy()
    expect(page()).toBe(JSON.stringify({ kind: 'hub', hubId: null, tab: 'mcp' }))
  })

  it('opens from the open-settings event', () => {
    const off = installSettingsEventBridge()
    render(<SettingsView />)
    act(() => {
      window.dispatchEvent(new CustomEvent('open-settings', { detail: 'labs' }))
    })
    expect(page()).toBe(JSON.stringify({ kind: 'app', page: 'labs' }))
    off()
  })

  it('closes on Back to app and on Esc', () => {
    render(<SettingsView />)
    act(() => openSettings())
    fireEvent.click(screen.getByTestId('settings-back'))
    expect(useSettingsViewStore.getState().open).toBe(false)

    act(() => openSettings())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useSettingsViewStore.getState().open).toBe(false)
  })

  it('closes even when a closing (animating-out) dialog already claimed Esc', () => {
    render(<SettingsView />)
    act(() => openSettings())
    const closing = document.createElement('div')
    closing.setAttribute('role', 'dialog')
    closing.setAttribute('data-state', 'closed')
    document.body.appendChild(closing)
    document.addEventListener('keydown', (e) => e.preventDefault(), { once: true })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(useSettingsViewStore.getState().open).toBe(false)
  })

  it('leaves Esc to an open dialog', () => {
    render(<SettingsView />)
    act(() => openSettings())
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    document.body.appendChild(dialog)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useSettingsViewStore.getState().open).toBe(true)
  })

  it('Esc in a field closes too, like the old dialog', () => {
    render(<SettingsView />)
    act(() => openSettings())
    const input = document.createElement('input')
    screen.getByTestId('settings-view').appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useSettingsViewStore.getState().open).toBe(false)
  })
})
