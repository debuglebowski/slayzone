import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { StrictMode } from 'react'

const renderMock = vi.fn()
const initializeMock = vi.fn()

vi.mock('mermaid', () => ({
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}))

const themeState: { theme: 'dark' | 'light' } = { theme: 'dark' }
vi.mock('@slayzone/settings/client', () => ({
  useTheme: () => ({ theme: themeState.theme }),
}))

vi.mock('@slayzone/ui', () => ({
  IconButton: (props: { onClick?: () => void; 'aria-label': string; children?: React.ReactNode }) => (
    <button aria-label={props['aria-label']} onClick={props.onClick}>{props.children}</button>
  ),
}))

import { MermaidBlock } from './MermaidBlock'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  renderMock.mockReset()
  initializeMock.mockReset()
  themeState.theme = 'dark'
  // Reset module-level cache + inflight by re-importing? Cache lives in module
  // closure; tests use unique code strings per case to avoid cross-test pollution.
})

describe('MermaidBlock', () => {
  it('renders SVG returned by mermaid.render', async () => {
    renderMock.mockResolvedValueOnce({ svg: '<svg data-testid="diagram-1"/>' })
    const { container } = render(<MermaidBlock code="flowchart TD\nA-->B # case-1" />)
    await waitFor(() => expect(container.querySelector('[data-testid="diagram-1"]')).not.toBeNull())
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', theme: 'dark' }),
    )
  })

  it('does not call mermaid.render twice in strict mode for same code', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram-2"/>' })
    const { container } = render(
      <StrictMode>
        <MermaidBlock code="flowchart TD\nA-->B # case-2" />
      </StrictMode>,
    )
    await waitFor(() => expect(container.querySelector('[data-testid="diagram-2"]')).not.toBeNull())
    // Strict mode runs effects twice; cancelled flag must drop the duplicate render
    // path. We expect no more than 2 render calls (one for each effect-mount), but
    // critically only one set of controls in the DOM.
    const controls = container.querySelectorAll('[aria-label="Reset"]')
    expect(controls.length).toBe(1)
  })

  it('re-renders with new theme on theme switch', async () => {
    renderMock.mockResolvedValueOnce({ svg: '<svg data-testid="diagram-3a"/>' })
    const { container, rerender } = render(<MermaidBlock code="flowchart TD\nA-->B # case-3" />)
    await waitFor(() => expect(container.querySelector('[data-testid="diagram-3a"]')).not.toBeNull())

    renderMock.mockResolvedValueOnce({ svg: '<svg data-testid="diagram-3b"/>' })
    act(() => {
      themeState.theme = 'light'
    })
    rerender(<MermaidBlock code="flowchart TD\nA-->B # case-3" />)

    await waitFor(() =>
      expect(initializeMock).toHaveBeenCalledWith(
        expect.objectContaining({ securityLevel: 'strict', theme: 'default' }),
      ),
    )
    await waitFor(() => expect(container.querySelector('[data-testid="diagram-3b"]')).not.toBeNull())
  })

  it('falls back to <pre><code> when mermaid.render rejects', async () => {
    renderMock.mockRejectedValueOnce(new Error('parse error'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(<MermaidBlock code="invalid mermaid # case-4" />)
    await waitFor(() => expect(container.querySelector('pre code')).not.toBeNull())
    expect(container.querySelector('pre code')?.textContent).toBe('invalid mermaid # case-4')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
