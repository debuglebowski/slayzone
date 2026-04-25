import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { mermaidCodeOverride } from './mermaidCodeOverride'

afterEach(cleanup)

vi.mock('./MermaidBlock', () => ({
  MermaidBlock: ({ code }: { code: string }) => <div data-testid="mermaid">{code}</div>,
}))

describe('mermaidCodeOverride', () => {
  it('renders MermaidBlock for explicit language-mermaid fence', () => {
    const { getByTestId } = render(
      mermaidCodeOverride({ className: 'language-mermaid', children: 'flowchart TD\nA-->B\n' }),
    )
    expect(getByTestId('mermaid').textContent).toBe('flowchart TD\nA-->B')
  })

  it('renders MermaidBlock for bare fence with mermaid keyword', () => {
    const { getByTestId } = render(
      mermaidCodeOverride({ children: 'sequenceDiagram\nAlice->>Bob: hi\n' }),
    )
    expect(getByTestId('mermaid').textContent).toBe('sequenceDiagram\nAlice->>Bob: hi')
  })

  it('renders default <code> for inline code without newline', () => {
    const { container } = render(
      mermaidCodeOverride({ children: 'flowchart TD' }),
    )
    expect(container.querySelector('[data-testid="mermaid"]')).toBeNull()
    expect(container.querySelector('code')).not.toBeNull()
  })

  it('renders default <code> for non-mermaid bare fence', () => {
    const { container } = render(
      mermaidCodeOverride({ children: 'echo hello\nls -la\n' }),
    )
    expect(container.querySelector('[data-testid="mermaid"]')).toBeNull()
    expect(container.querySelector('code')).not.toBeNull()
  })

  it('renders default <code> for non-mermaid language fence', () => {
    const { container } = render(
      mermaidCodeOverride({ className: 'language-typescript', children: 'const x = 1\n' }),
    )
    expect(container.querySelector('[data-testid="mermaid"]')).toBeNull()
    expect(container.querySelector('code')?.className).toBe('language-typescript')
  })
})
