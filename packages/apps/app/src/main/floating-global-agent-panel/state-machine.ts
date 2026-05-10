/**
 * Floating Global Agent Panel State Machine — pure reducer.
 *
 * No Electron imports. Side effects expressed as Action[] returned from reduce().
 * Adapter (../floating-global-agent-panel.ts) executes the actions.
 *
 * Goal: single source of truth for floating global agent panel lifecycle. All
 * focus/blur, user toggles, and session changes funnel through this reducer.
 * Illegal transitions are no-ops with a diagnostic; they cannot crash the adapter.
 */

export type DetachMode = 'auto' | 'manual'

export type State =
  | { kind: 'attached' }
  | { kind: 'detached'; sessionId: string; mode: DetachMode }
  | { kind: 'disabled' }

export type Event =
  // OS app-level signal: user left our app entirely (not just to a menu/tooltip).
  | { kind: 'app-resign-active' }
  // Per-window focus: user activated the main window (drives reattach).
  | { kind: 'main-focus' }
  | { kind: 'floating-focus' }
  | { kind: 'floating-blur' }
  | { kind: 'floating-window-closed' }
  // User-driven intents
  | { kind: 'user-set-enabled'; enabled: boolean }
  | { kind: 'user-toggle-collapse' }
  | { kind: 'user-reset-size' }
  | { kind: 'user-detach' }
  | { kind: 'user-reattach' }
  // Context updates
  | { kind: 'session-id-changed'; sessionId: string | null }
  | { kind: 'panel-open-changed'; isOpen: boolean }

export type Action =
  | { kind: 'create-floating-window' }
  | { kind: 'destroy-floating-window' }
  | { kind: 'redirect-session-to-floating'; sessionId: string }
  | { kind: 'redirect-session-to-main'; sessionId: string }
  | { kind: 'replay-buffer-to-main'; sessionId: string }
  | { kind: 'request-resize-main'; sessionId: string }
  | { kind: 'show-floating' }
  | { kind: 'hide-floating' }
  | { kind: 'apply-floating-bounds'; animate: boolean }
  | { kind: 'broadcast-state' }
  | { kind: 'log-diagnostic'; event: string; payload?: Record<string, unknown> }
  | { kind: 'register-floating-shortcut' }
  | { kind: 'unregister-floating-shortcut' }
  | { kind: 'send-collapse-changed'; collapsed: boolean }
  | { kind: 'set-collapsed'; collapsed: boolean }
  | { kind: 'set-resizable'; resizable: boolean }
  | { kind: 'clear-expanded-size' }

export interface Context {
  enabled: boolean
  panelOpen: boolean
  sessionId: string | null
  /** Whether user wants the floating widget collapsed (true) or expanded (false). */
  collapsed: boolean
}

export interface Result {
  state: State
  actions: Action[]
}

const noop = (state: State): Result => ({ state, actions: [] })

function detach(sessionId: string, mode: DetachMode): Result {
  return {
    state: { kind: 'detached', sessionId, mode },
    actions: [
      { kind: 'create-floating-window' },
      { kind: 'redirect-session-to-floating', sessionId },
      { kind: 'set-collapsed', collapsed: true },
      { kind: 'set-resizable', resizable: false },
      { kind: 'apply-floating-bounds', animate: false },
      { kind: 'send-collapse-changed', collapsed: true },
      { kind: 'show-floating' },
      { kind: 'register-floating-shortcut' },
      { kind: 'broadcast-state' },
      { kind: 'log-diagnostic', event: 'floating.detach', payload: { sessionId, mode } }
    ]
  }
}

function reattach(sessionId: string): Result {
  return {
    state: { kind: 'attached' },
    actions: [
      { kind: 'unregister-floating-shortcut' },
      { kind: 'redirect-session-to-main', sessionId },
      { kind: 'replay-buffer-to-main', sessionId },
      { kind: 'request-resize-main', sessionId },
      { kind: 'hide-floating' },
      { kind: 'broadcast-state' },
      { kind: 'log-diagnostic', event: 'floating.reattach', payload: { sessionId } }
    ]
  }
}

function teardown(sessionId: string | null, nextState: State, reason: string): Result {
  const actions: Action[] = [
    { kind: 'unregister-floating-shortcut' }
  ]
  if (sessionId) {
    actions.push(
      { kind: 'redirect-session-to-main', sessionId },
      { kind: 'replay-buffer-to-main', sessionId },
      { kind: 'request-resize-main', sessionId }
    )
  }
  actions.push(
    { kind: 'destroy-floating-window' },
    { kind: 'broadcast-state' },
    { kind: 'log-diagnostic', event: 'floating.teardown', payload: { sessionId, reason } }
  )
  return { state: nextState, actions }
}

export function reduce(state: State, event: Event, ctx: Context): Result {
  switch (event.kind) {
    case 'app-resign-active': {
      // Detach when the user leaves our app entirely. Window-level blur
      // is too noisy (menus, tooltips); app-level is the actual signal.
      if (state.kind !== 'attached') return noop(state)
      if (!ctx.enabled || !ctx.panelOpen || !ctx.sessionId) return noop(state)
      return detach(ctx.sessionId, 'auto')
    }

    case 'main-focus': {
      // Reattach only when in auto mode. Manual mode persists across focus
      // cycles — user must explicitly reattach.
      if (state.kind !== 'detached') return noop(state)
      if (state.mode !== 'auto') return noop(state)
      return reattach(state.sessionId)
    }

    case 'user-detach': {
      // Explicit user action — works regardless of `enabled` setting.
      // Already detached → upgrade to manual mode (overrides auto).
      if (state.kind === 'detached') {
        if (state.mode === 'manual') return noop(state)
        return {
          state: { ...state, mode: 'manual' },
          actions: [
            { kind: 'broadcast-state' },
            { kind: 'log-diagnostic', event: 'floating.upgrade_to_manual' }
          ]
        }
      }
      if (!ctx.sessionId) return noop(state)
      return detach(ctx.sessionId, 'manual')
    }

    case 'user-reattach': {
      // Explicit reattach — ignores mode. Always returns to attached.
      if (state.kind !== 'detached') return noop(state)
      return reattach(state.sessionId)
    }

    case 'floating-focus': {
      // User clicked the floating widget. Stay detached — no-op.
      // This event exists so adapters can record it for diagnostics
      // and so we explicitly document that we don't reattach here.
      return noop(state)
    }

    case 'floating-blur': {
      // Floating lost focus. If main is the recipient we'll get
      // 'main-focus' or 'app-become-active' next. No state change here;
      // this event exists for diagnostic completeness.
      return noop(state)
    }

    case 'floating-window-closed': {
      // External close (e.g., user used OS shortcut). Treat as forced reattach.
      if (state.kind !== 'detached') return noop(state)
      return {
        state: { kind: 'attached' },
        actions: [
          { kind: 'unregister-floating-shortcut' },
          { kind: 'redirect-session-to-main', sessionId: state.sessionId },
          { kind: 'replay-buffer-to-main', sessionId: state.sessionId },
          { kind: 'request-resize-main', sessionId: state.sessionId },
          { kind: 'broadcast-state' },
          { kind: 'log-diagnostic', event: 'floating.window_closed_external' }
        ]
      }
    }

    case 'user-set-enabled': {
      if (event.enabled) {
        if (state.kind === 'disabled') {
          return {
            state: { kind: 'attached' },
            actions: [
              { kind: 'broadcast-state' },
              { kind: 'log-diagnostic', event: 'floating.enabled' }
            ]
          }
        }
        return noop(state)
      }
      // Disabling: tear down everything regardless of current state.
      const sessionId = state.kind === 'detached' ? state.sessionId : ctx.sessionId
      return teardown(sessionId, { kind: 'disabled' }, 'user-disabled')
    }

    case 'user-reset-size': {
      if (state.kind !== 'detached') return noop(state)
      return {
        state,
        actions: [
          { kind: 'clear-expanded-size' },
          { kind: 'apply-floating-bounds', animate: true },
          { kind: 'log-diagnostic', event: 'floating.reset_size' }
        ]
      }
    }

    case 'user-toggle-collapse': {
      if (state.kind !== 'detached') return noop(state)
      const next = !ctx.collapsed
      return {
        state,
        actions: [
          { kind: 'set-collapsed', collapsed: next },
          // Resizable when expanded, fixed when collapsed.
          // Set BEFORE apply-bounds so size constraints are in place.
          { kind: 'set-resizable', resizable: !next },
          { kind: 'apply-floating-bounds', animate: true },
          { kind: 'send-collapse-changed', collapsed: next }
        ]
      }
    }

    case 'session-id-changed': {
      // If a detached session's ID changes (project switch), reattach
      // whatever was floating and let the next blur cycle re-detach.
      if (state.kind === 'detached' && event.sessionId !== state.sessionId) {
        return teardown(state.sessionId, { kind: 'attached' }, 'session-id-changed')
      }
      return noop(state)
    }

    case 'panel-open-changed': {
      // Closing the panel while detached → tear down floating window.
      if (!event.isOpen && state.kind === 'detached') {
        return teardown(state.sessionId, { kind: 'attached' }, 'panel-closed')
      }
      return noop(state)
    }
  }
}
