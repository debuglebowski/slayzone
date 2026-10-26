import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { detectPlatform, registry } from '@slayzone/shortcuts'
import { useShortcutAction } from './useShortcutAction'
import { useShortcutStore } from './useShortcutStore'

// browser-find defaults to mod+f in the browser scope.
const press = () =>
  registry.dispatch(
    new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: detectPlatform() === 'mac',
      ctrlKey: detectPlatform() !== 'mac'
    }),
    new Set(['browser'])
  )

beforeEach(() => {
  registry.clear()
  useShortcutStore.setState({ overrides: {} })
})

describe('useShortcutAction (static id)', () => {
  it('binds the default keys', () => {
    const handler = vi.fn()
    renderHook(() => useShortcutAction('browser-find', handler))
    expect(press()).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('binds nothing when the shortcut is cleared (null override)', () => {
    useShortcutStore.setState({ overrides: { 'browser-find': null } })
    const handler = vi.fn()
    renderHook(() => useShortcutAction('browser-find', handler))
    expect(press()).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })
})
