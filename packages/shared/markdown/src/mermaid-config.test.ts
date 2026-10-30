import { describe, expect, it } from 'vitest'
import { MERMAID_FENCE_LANGUAGE, mermaidInitOptions } from './mermaid-config'

describe('mermaidInitOptions', () => {
  it('renders on request only, strict, dagre layout, in the app theme', () => {
    expect(mermaidInitOptions('dark')).toEqual({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      layout: 'dagre'
    })
    expect(mermaidInitOptions('light').theme).toBe('default')
  })

  it('names the fence language the editor renders as a diagram', () => {
    expect(MERMAID_FENCE_LANGUAGE).toBe('mermaid')
  })
})
