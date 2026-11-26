import { describe, expect, it } from 'vitest'
import { normalizeShortcutOverrides } from './normalize'

describe('normalizeShortcutOverrides', () => {
  it('rewrites a renamed id to its new id', () => {
    const r = normalizeShortcutOverrides({ 'agent-panel': 'mod+k' })
    expect(r.overrides).toEqual({ 'global-agent-panel': 'mod+k' })
    expect(r.changed).toBe(true)
  })

  it('keeps the new id when both old and new are set', () => {
    const r = normalizeShortcutOverrides({ 'agent-panel': 'mod+k', 'global-agent-panel': 'mod+l' })
    expect(r.overrides).toEqual({ 'global-agent-panel': 'mod+l' })
  })

  it('applies a default migration after the rename', () => {
    const r = normalizeShortcutOverrides({ 'agent-panel': 'mod+.' })
    expect(r.overrides).toEqual({})
    expect(r.changed).toBe(true)
  })

  it('clears overrides equal to a retired default', () => {
    const r = normalizeShortcutOverrides({ 'zen-mode': 'mod+j', search: 'mod+shift+p' })
    expect(r.overrides).toEqual({ search: 'mod+shift+p' })
  })

  it("reads a legacy '' clear as unbound (null)", () => {
    const r = normalizeShortcutOverrides({ search: '' })
    expect(r.overrides).toEqual({ search: null })
    expect(r.changed).toBe(true)
  })

  it('drops values that are neither a string nor null', () => {
    const r = normalizeShortcutOverrides({ search: 3, other: 'mod+o' } as unknown as Record<
      string,
      unknown
    >)
    expect(r.overrides).toEqual({ other: 'mod+o' })
    expect(r.changed).toBe(true)
  })

  it('reports unchanged for an already-normal map and never mutates its input', () => {
    const input = { search: 'mod+shift+p', 'go-home': null }
    const r = normalizeShortcutOverrides(input)
    expect(r.overrides).toEqual(input)
    expect(r.overrides).not.toBe(input)
    expect(r.changed).toBe(false)
  })

  it('treats a non-object as empty', () => {
    expect(normalizeShortcutOverrides(null)).toEqual({ overrides: {}, changed: false })
    expect(normalizeShortcutOverrides('x')).toEqual({ overrides: {}, changed: true })
  })
})
