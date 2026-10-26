// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The native host bridge: record every inlay navigation the modal asks for.
const host = vi.hoisted(() => ({
  openExtensionsModal: vi.fn(),
  openExtensionPopup: vi.fn(),
  openExtensionOptions: vi.fn(),
  closeExtensionsModal: vi.fn(),
  setExtensionsModalBounds: vi.fn(),
  listExtensions: vi.fn(),
  onExtensionsChanged: vi.fn(() => () => {})
}))
vi.mock('./embedded-tab-host', () => ({
  ...host,
  createEmbeddedTabHost: () => ({}),
  onNewView: vi.fn(),
  registerBrowserAdoption: vi.fn(),
  setEmbeddedProfileKey: vi.fn()
}))
vi.mock('./BrowserPanel', () => ({ makeBrowserPanel: () => () => null }))

import { ExtensionsModal } from './TaskDetailsView'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  for (const fn of Object.values(host)) fn.mockClear()
  host.listExtensions.mockResolvedValue([
    { id: 'ext1', name: 'Vault', enabled: true, hasOptions: false, hasPopup: true }
  ])
})

afterEach(cleanup)

describe('ExtensionsModal inlay navigation', () => {
  it('opens the Web Store inlay exactly once on mount', () => {
    render(<ExtensionsModal profileKey="" onClose={vi.fn()} />)
    expect(host.openExtensionsModal).toHaveBeenCalledTimes(1)
    expect(host.openExtensionsModal).toHaveBeenCalledWith(expect.anything(), '', 'store')
  })

  it('switching identity with an extension selected goes straight to the new Web Store', async () => {
    const { rerender } = render(<ExtensionsModal profileKey="work" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByTitle('Vault'))
    expect(host.openExtensionPopup).toHaveBeenCalledTimes(1)
    expect(host.openExtensionPopup).toHaveBeenCalledWith('ext1')
    host.openExtensionsModal.mockClear()
    host.openExtensionPopup.mockClear()

    rerender(<ExtensionsModal profileKey="personal" onClose={vi.fn()} />)
    await waitFor(() => expect(host.listExtensions).toHaveBeenCalledWith('personal'))

    // The old identity's extension popup is never re-opened in the new identity.
    expect(host.openExtensionPopup).not.toHaveBeenCalled()
    expect(host.openExtensionsModal).toHaveBeenCalledTimes(1)
    expect(host.openExtensionsModal).toHaveBeenCalledWith(expect.anything(), 'personal', 'store')
  })
})
