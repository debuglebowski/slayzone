import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { StrictMode, useLayoutEffect } from 'react'

const renderMock = vi.fn()
const initializeMock = vi.fn()

vi.mock('mermaid', () => ({
  default: {
    initialize: initializeMock,
    render: renderMock
  }
}))

function setHtmlTheme(theme: 'dark' | 'light') {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../ui/src/use-deps-changed')),
  IconButton: (props: {
    onClick?: () => void
    'aria-label': string
    children?: React.ReactNode
  }) => (
    <button aria-label={props['aria-label']} onClick={props.onClick}>
      {props.children}
    </button>
  )
}))

import { MermaidBlock } from './MermaidBlock'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  renderMock.mockReset()
  initializeMock.mockReset()
  setHtmlTheme('dark')
  // Reset module-level cache + inflight by re-importing? Cache lives in module
  // closure; tests use unique code strings per case to avoid cross-test pollution.
})

describe('MermaidBlock', () => {
  it('renders SVG returned by mermaid.render', async () => {
    renderMock.mockResolvedValueOnce({ svg: '<svg data-testid="diagram-1"/>' })
    const { container } = render(<MermaidBlock code="flowchart TD\nA-->B # case-1" />)
    await waitFor(() => expect(container.querySelector('[data-testid="diagram-1"]')).not.toBeNull())
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', theme: 'dark' })
    )
  })

  it('does not call mermaid.render twice in strict mode for same code', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="diagram-2"/>' })
    const { container } = render(
      <StrictMode>
        <MermaidBlock code="flowchart TD\nA-->B # case-2" />
      </StrictMode>
    )
    await waitFor(() => expect(container.querySelector('[data-testid="diagram-2"]')).not.toBeNull())
    // StrictMode mounts effects twice; cancelled flag must drop duplicates so
    // exactly one diagram lands in the DOM.
    expect(container.querySelectorAll('[data-testid="diagram-2"]').length).toBe(1)
  })

  it('re-renders with new theme on theme switch', async () => {
    renderMock.mockResolvedValueOnce({ svg: '<svg data-testid="diagram-3a"/>' })
    const { container, rerender } = render(<MermaidBlock code="flowchart TD\nA-->B # case-3" />)
    await waitFor(() =>
      expect(container.querySelector('[data-testid="diagram-3a"]')).not.toBeNull()
    )

    renderMock.mockResolvedValueOnce({ svg: '<svg data-testid="diagram-3b"/>' })
    act(() => {
      setHtmlTheme('light')
    })
    rerender(<MermaidBlock code="flowchart TD\nA-->B # case-3" />)

    await waitFor(() =>
      expect(initializeMock).toHaveBeenCalledWith(
        expect.objectContaining({ securityLevel: 'strict', theme: 'default' })
      )
    )
    await waitFor(() =>
      expect(container.querySelector('[data-testid="diagram-3b"]')).not.toBeNull()
    )
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

  // What each commit puts on screen, read before passive effects run (= what is painted).
  function CommitProbe({ log, code }: { log: string[]; code: string }) {
    useLayoutEffect(() => {
      log.push(document.querySelector('[data-probe-root]')?.innerHTML ?? '<no root>')
    }, [code, log])
    return null
  }

  it('editing the code never paints the previous diagram', async () => {
    renderMock.mockResolvedValueOnce({ svg: '<svg data-testid="diagram-5a"/>' })
    const log: string[] = []
    const ui = (code: string) => (
      <div data-probe-root>
        <MermaidBlock code={code} />
        <CommitProbe log={log} code={code} />
      </div>
    )
    const { container, rerender } = render(ui('flowchart TD\nA-->B # case-5a'))
    await waitFor(() =>
      expect(container.querySelector('[data-testid="diagram-5a"]')).not.toBeNull()
    )

    let finish!: (v: { svg: string }) => void
    renderMock.mockReturnValueOnce(new Promise((r) => (finish = r)))
    log.length = 0
    rerender(ui('flowchart TD\nA-->C # case-5b'))
    expect(log).toHaveLength(1)
    expect(log.filter((html) => html.includes('diagram-5a'))).toEqual([])
    await act(async () => finish({ svg: '<svg data-testid="diagram-5b"/>' }))
    await waitFor(() =>
      expect(container.querySelector('[data-testid="diagram-5b"]')).not.toBeNull()
    )

    // Back to the first code: drawn from the cache at once, without rendering again.
    const calls = renderMock.mock.calls.length
    rerender(ui('flowchart TD\nA-->B # case-5a'))
    expect(container.querySelector('[data-testid="diagram-5a"]')).not.toBeNull()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(renderMock.mock.calls.length).toBe(calls)
  })

  it('a fixed diagram replaces the error fallback', async () => {
    renderMock.mockRejectedValueOnce(new Error('parse error'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container, rerender } = render(<MermaidBlock code="broken # case-6" />)
    await waitFor(() => expect(container.querySelector('pre code')).not.toBeNull())
    renderMock.mockResolvedValueOnce({ svg: '<svg data-testid="diagram-6"/>' })
    rerender(<MermaidBlock code="flowchart TD\nA-->B # case-6" />)
    await waitFor(() => expect(container.querySelector('[data-testid="diagram-6"]')).not.toBeNull())
    expect(container.querySelector('pre code')).toBeNull()
    warn.mockRestore()
  })
})
