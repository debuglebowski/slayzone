import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest'
import { ShortcutRegistry } from './registry'

// Written against macOS bindings (mod = Cmd). Pin the platform before anything caches
// it, so these cases mean the same thing on the Linux CI runner; restored afterwards.
const realPlatform = vi.hoisted(() => {
  const real = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  return real
})
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

function makeKeyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides
  } as unknown as KeyboardEvent
}

describe('ShortcutRegistry', () => {
  let reg: ShortcutRegistry

  beforeEach(() => {
    reg = new ShortcutRegistry()
  })

  it('dispatches to matching handler', () => {
    const handler = vi.fn()
    reg.register({ id: 'test', scope: 'global', keys: 'mod+k', handler })

    const e = makeKeyEvent({ key: 'k', metaKey: true })
    const result = reg.dispatch(e, new Set(['global']))

    expect(result).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
  })

  it('returns false when no match', () => {
    const handler = vi.fn()
    reg.register({ id: 'test', scope: 'global', keys: 'mod+k', handler })

    const result = reg.dispatch(makeKeyEvent({ key: 'j', metaKey: true }), new Set(['global']))

    expect(result).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('picks highest-priority scope', () => {
    const taskHandler = vi.fn()
    const editorHandler = vi.fn()
    reg.register({ id: 'panel-settings', scope: 'task', keys: 'mod+s', handler: taskHandler })
    reg.register({ id: 'editor-save', scope: 'editor', keys: 'mod+s', handler: editorHandler })

    const e = makeKeyEvent({ key: 's', metaKey: true })
    reg.dispatch(e, new Set(['global', 'task', 'editor']))

    expect(editorHandler).toHaveBeenCalledOnce()
    expect(taskHandler).not.toHaveBeenCalled()
  })

  it('falls back to lower priority when higher scope not active', () => {
    const taskHandler = vi.fn()
    const editorHandler = vi.fn()
    reg.register({ id: 'panel-settings', scope: 'task', keys: 'mod+s', handler: taskHandler })
    reg.register({ id: 'editor-save', scope: 'editor', keys: 'mod+s', handler: editorHandler })

    const e = makeKeyEvent({ key: 's', metaKey: true })
    reg.dispatch(e, new Set(['global', 'task']))

    expect(taskHandler).toHaveBeenCalledOnce()
    expect(editorHandler).not.toHaveBeenCalled()
  })

  it('last-registered wins at same priority', () => {
    const first = vi.fn()
    const second = vi.fn()
    reg.register({ id: 'a', scope: 'terminal', keys: 'mod+f', handler: first })
    reg.register({ id: 'b', scope: 'terminal', keys: 'mod+f', handler: second })

    reg.dispatch(makeKeyEvent({ key: 'f', metaKey: true }), new Set(['global', 'terminal']))

    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
  })

  it('skips disabled handlers', () => {
    const handler = vi.fn()
    reg.register({ id: 'test', scope: 'global', keys: 'mod+k', handler, enabled: false })

    reg.dispatch(makeKeyEvent({ key: 'k', metaKey: true }), new Set(['global']))

    expect(handler).not.toHaveBeenCalled()
  })

  it('unsubscribe removes handler', () => {
    const handler = vi.fn()
    const unsub = reg.register({ id: 'test', scope: 'global', keys: 'mod+k', handler })

    unsub()
    reg.dispatch(makeKeyEvent({ key: 'k', metaKey: true }), new Set(['global']))

    expect(handler).not.toHaveBeenCalled()
  })

  it('skips handlers when scope not in activeScopes', () => {
    const handler = vi.fn()
    reg.register({ id: 'test', scope: 'terminal', keys: 'mod+f', handler })

    reg.dispatch(makeKeyEvent({ key: 'f', metaKey: true }), new Set(['global', 'task']))

    expect(handler).not.toHaveBeenCalled()
  })

  it('clear removes all handlers', () => {
    const handler = vi.fn()
    reg.register({ id: 'a', scope: 'global', keys: 'mod+k', handler })
    reg.register({ id: 'b', scope: 'task', keys: 'mod+s', handler })

    reg.clear()
    reg.dispatch(makeKeyEvent({ key: 'k', metaKey: true }), new Set(['global']))

    expect(handler).not.toHaveBeenCalled()
  })

  it('matches non-modifier shortcuts (bubble phase)', () => {
    const handler = vi.fn()
    reg.register({ id: 'escape', scope: 'global', keys: 'escape', handler })

    reg.dispatch(makeKeyEvent({ key: 'Escape' }), new Set(['global']))

    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not consume event when handler returns false', () => {
    const handler = vi.fn(() => false)
    reg.register({ id: 'undo', scope: 'global', keys: 'mod+z', handler })

    const e = makeKeyEvent({ key: 'z', metaKey: true })
    const result = reg.dispatch(e, new Set(['global']))

    expect(handler).toHaveBeenCalledOnce()
    expect(result).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(e.stopPropagation).not.toHaveBeenCalled()
  })

  it('consumes event when handler returns void', () => {
    const handler = vi.fn()
    reg.register({ id: 'save', scope: 'editor', keys: 'mod+s', handler })

    const e = makeKeyEvent({ key: 's', metaKey: true })
    reg.dispatch(e, new Set(['global', 'editor']))

    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
  })
})
