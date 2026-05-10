import { describe, it, expect } from 'vitest'
import { reduce, type State, type Event, type Context } from './state-machine'

const baseCtx: Context = {
  enabled: true,
  panelOpen: true,
  sessionId: 'session-1',
  collapsed: true
}

const fire = (state: State, event: Event, ctx: Partial<Context> = {}) =>
  reduce(state, event, { ...baseCtx, ...ctx })

const actionKinds = (actions: { kind: string }[]) => actions.map(a => a.kind)

describe('reduce — happy path', () => {
  it('attached + app-resign → detached(auto), runs detach actions', () => {
    const r = fire({ kind: 'attached' }, { kind: 'app-resign-active' })
    expect(r.state).toEqual({ kind: 'detached', sessionId: 'session-1', mode: 'auto' })
    expect(actionKinds(r.actions)).toEqual([
      'create-floating-window',
      'redirect-session-to-floating',
      'set-collapsed',
      'set-resizable',
      'apply-floating-bounds',
      'send-collapse-changed',
      'show-floating',
      'register-floating-shortcut',
      'broadcast-state',
      'log-diagnostic'
    ])
  })

  it('detached(auto) + main-focus → attached, runs reattach actions', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'main-focus' })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(actionKinds(r.actions)).toEqual([
      'unregister-floating-shortcut',
      'redirect-session-to-main',
      'replay-buffer-to-main',
      'request-resize-main',
      'hide-floating',
      'broadcast-state',
      'log-diagnostic'
    ])
  })
})

describe('reduce — manual detach', () => {
  it('attached + user-detach → detached(manual)', () => {
    const r = fire({ kind: 'attached' }, { kind: 'user-detach' })
    expect(r.state).toEqual({ kind: 'detached', sessionId: 'session-1', mode: 'manual' })
    expect(actionKinds(r.actions)).toContain('create-floating-window')
  })

  it('detached(manual) + main-focus → STAYS detached(manual)', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'manual' }, { kind: 'main-focus' })
    expect(r.state).toEqual({ kind: 'detached', sessionId: 'session-1', mode: 'manual' })
    expect(r.actions).toEqual([])
  })

  it('detached(auto) + user-detach → upgrades to manual', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'user-detach' })
    expect(r.state).toEqual({ kind: 'detached', sessionId: 'session-1', mode: 'manual' })
    expect(actionKinds(r.actions)).toEqual(['broadcast-state', 'log-diagnostic'])
  })

  it('detached(manual) + user-detach → no-op (already manual)', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'manual' }, { kind: 'user-detach' })
    expect(r.state).toEqual({ kind: 'detached', sessionId: 'session-1', mode: 'manual' })
    expect(r.actions).toEqual([])
  })

  it('disabled + user-detach → detached(manual) — bypasses enabled', () => {
    const r = fire({ kind: 'disabled' }, { kind: 'user-detach' }, { enabled: false })
    expect(r.state).toEqual({ kind: 'detached', sessionId: 'session-1', mode: 'manual' })
  })

  it('attached + user-detach without session → no-op', () => {
    const r = fire({ kind: 'attached' }, { kind: 'user-detach' }, { sessionId: null })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(r.actions).toEqual([])
  })

  it('detached(auto) + user-reattach → attached', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'user-reattach' })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(actionKinds(r.actions)).toContain('redirect-session-to-main')
  })

  it('detached(manual) + user-reattach → attached', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'manual' }, { kind: 'user-reattach' })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(actionKinds(r.actions)).toContain('redirect-session-to-main')
  })

  it('attached + user-reattach → no-op', () => {
    const r = fire({ kind: 'attached' }, { kind: 'user-reattach' })
    expect(r.actions).toEqual([])
  })
})

describe('reduce — guards', () => {
  it('app-resign while disabled → no-op', () => {
    const r = fire({ kind: 'attached' }, { kind: 'app-resign-active' }, { enabled: false })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(r.actions).toEqual([])
  })

  it('app-resign while panel closed → no-op', () => {
    const r = fire({ kind: 'attached' }, { kind: 'app-resign-active' }, { panelOpen: false })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(r.actions).toEqual([])
  })

  it('app-resign with no session → no-op', () => {
    const r = fire({ kind: 'attached' }, { kind: 'app-resign-active' }, { sessionId: null })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(r.actions).toEqual([])
  })

  it('main-focus while attached → no-op', () => {
    const r = fire({ kind: 'attached' }, { kind: 'main-focus' })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(r.actions).toEqual([])
  })

  it('floating-focus → no-op (just stays detached)', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'floating-focus' })
    expect(r.state).toEqual({ kind: 'detached', sessionId: 'session-1', mode: 'auto' })
    expect(r.actions).toEqual([])
  })

  it('floating-blur → no-op (info event only)', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'floating-blur' })
    expect(r.state).toEqual({ kind: 'detached', sessionId: 'session-1', mode: 'auto' })
    expect(r.actions).toEqual([])
  })
})

describe('reduce — user toggle', () => {
  it('disable while attached → disabled, tears down', () => {
    const r = fire({ kind: 'attached' }, { kind: 'user-set-enabled', enabled: false })
    expect(r.state).toEqual({ kind: 'disabled' })
    expect(actionKinds(r.actions)).toContain('destroy-floating-window')
  })

  it('disable while detached → disabled, reattaches session first', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'user-set-enabled', enabled: false })
    expect(r.state).toEqual({ kind: 'disabled' })
    const kinds = actionKinds(r.actions)
    expect(kinds).toContain('redirect-session-to-main')
    expect(kinds).toContain('destroy-floating-window')
    // redirect must come before destroy
    expect(kinds.indexOf('redirect-session-to-main')).toBeLessThan(kinds.indexOf('destroy-floating-window'))
  })

  it('enable while disabled → attached', () => {
    const r = fire({ kind: 'disabled' }, { kind: 'user-set-enabled', enabled: true })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(actionKinds(r.actions)).toContain('broadcast-state')
  })

  it('enable while attached → no-op', () => {
    const r = fire({ kind: 'attached' }, { kind: 'user-set-enabled', enabled: true })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(r.actions).toEqual([])
  })

  it('toggle-collapse while attached → no-op (no floating window to resize)', () => {
    const r = fire({ kind: 'attached' }, { kind: 'user-toggle-collapse' })
    expect(r.actions).toEqual([])
  })

  it('toggle-collapse while detached + collapsed → expand + resizable', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'user-toggle-collapse' }, { collapsed: true })
    expect(r.state).toEqual({ kind: 'detached', sessionId: 'session-1', mode: 'auto' })
    const setCollapsed = r.actions.find(a => a.kind === 'set-collapsed') as { kind: 'set-collapsed'; collapsed: boolean }
    const setResizable = r.actions.find(a => a.kind === 'set-resizable') as { kind: 'set-resizable'; resizable: boolean }
    expect(setCollapsed.collapsed).toBe(false)
    expect(setResizable.resizable).toBe(true)
  })

  it('toggle-collapse while detached + expanded → collapse + non-resizable', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'user-toggle-collapse' }, { collapsed: false })
    const setCollapsed = r.actions.find(a => a.kind === 'set-collapsed') as { kind: 'set-collapsed'; collapsed: boolean }
    const setResizable = r.actions.find(a => a.kind === 'set-resizable') as { kind: 'set-resizable'; resizable: boolean }
    expect(setCollapsed.collapsed).toBe(true)
    expect(setResizable.resizable).toBe(false)
  })
})

describe('reduce — context changes', () => {
  it('session-id changes while detached → tears down + reattaches', () => {
    const r = fire(
      { kind: 'detached', sessionId: 'session-1', mode: 'auto' },
      { kind: 'session-id-changed', sessionId: 'session-2' }
    )
    expect(r.state).toEqual({ kind: 'attached' })
    const kinds = actionKinds(r.actions)
    expect(kinds).toContain('redirect-session-to-main')
    expect(kinds).toContain('destroy-floating-window')
  })

  it('session-id changes while attached → no-op', () => {
    const r = fire({ kind: 'attached' }, { kind: 'session-id-changed', sessionId: 'session-2' })
    expect(r.actions).toEqual([])
  })

  it('panel closes while detached → tears down', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'panel-open-changed', isOpen: false })
    expect(r.state).toEqual({ kind: 'attached' })
    expect(actionKinds(r.actions)).toContain('destroy-floating-window')
  })
})

describe('reduce — external floating window close', () => {
  it('floating-window-closed while detached → reattach without destroy', () => {
    const r = fire({ kind: 'detached', sessionId: 'session-1', mode: 'auto' }, { kind: 'floating-window-closed' })
    expect(r.state).toEqual({ kind: 'attached' })
    const kinds = actionKinds(r.actions)
    expect(kinds).toContain('redirect-session-to-main')
    // no destroy — window already gone
    expect(kinds).not.toContain('destroy-floating-window')
  })

  it('floating-window-closed while attached → no-op', () => {
    const r = fire({ kind: 'attached' }, { kind: 'floating-window-closed' })
    expect(r.actions).toEqual([])
  })
})

describe('reduce — invariant: no state corruption from random sequences', () => {
  const allEvents: Event[] = [
    { kind: 'app-resign-active' },
    { kind: 'main-focus' },
    { kind: 'floating-focus' },
    { kind: 'floating-blur' },
    { kind: 'floating-window-closed' },
    { kind: 'user-set-enabled', enabled: true },
    { kind: 'user-set-enabled', enabled: false },
    { kind: 'user-toggle-collapse' },
    { kind: 'user-detach' },
    { kind: 'user-reattach' },
    { kind: 'session-id-changed', sessionId: 'session-2' },
    { kind: 'session-id-changed', sessionId: null },
    { kind: 'panel-open-changed', isOpen: true },
    { kind: 'panel-open-changed', isOpen: false }
  ]

  const validKinds = new Set(['attached', 'detached', 'disabled'])
  const validModes = new Set(['auto', 'manual'])

  it('1000 random events from arbitrary start always yield valid state', () => {
    const seed = 42
    let rng = seed
    const next = () => {
      rng = (rng * 1664525 + 1013904223) % 2 ** 32
      return rng / 2 ** 32
    }
    let state: State = { kind: 'attached' }
    let ctx: Context = { ...baseCtx }
    for (let i = 0; i < 1000; i++) {
      const event = allEvents[Math.floor(next() * allEvents.length)]
      // simulate ctx mutations the adapter would do
      if (event.kind === 'user-set-enabled') ctx = { ...ctx, enabled: event.enabled }
      if (event.kind === 'session-id-changed') ctx = { ...ctx, sessionId: event.sessionId }
      if (event.kind === 'panel-open-changed') ctx = { ...ctx, panelOpen: event.isOpen }
      const r = reduce(state, event, ctx)
      state = r.state
      expect(validKinds.has(state.kind)).toBe(true)
      if (state.kind === 'detached') {
        expect(typeof state.sessionId).toBe('string')
        expect(validModes.has(state.mode)).toBe(true)
      }
    }
  })
})
