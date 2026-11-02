import { describe, expect, test, vi } from 'vitest'
// renderers.tsx pulls these in; irrelevant here and heavy to load.
vi.mock('@slayzone/diff-view', () => ({ DiffView: () => null }))
vi.mock('@slayzone/markdown/client', () => ({ GhMarkdown: () => null }))

import { isRenderable } from './renderers'

describe('isRenderable: interrupted markers', () => {
  test('a marker is shown', () => {
    expect(isRenderable({ kind: 'interrupted', timestamp: 1 })).toBe(true)
  })

  test('a marker a later one superseded (same turn) is not', () => {
    expect(isRenderable({ kind: 'interrupted', timestamp: 1, superseded: true })).toBe(false)
  })
})
