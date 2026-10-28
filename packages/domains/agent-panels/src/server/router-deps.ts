// What the `app.floatingAgent` router needs from its host: the Electron floating
// global agent panel. A member of api's `AppDeps` (built from `FloatingAgentHost`,
// so there is one contract; the side-car's capability bridge forwards it to the host
// by member name). api wires this seam at load to read its registry live on every
// call (`api/src/domain-router-deps.ts`). This domain never imports `@slayzone/api`.
import type { EventEmitter } from 'node:events'

// Floating global agent panel state — the payload `getState()` returns and the
// `state` event emits (mirrors floating-global-agent-panel.ts currentStatePayload).
// Lives server-side here (the host can't be imported); the host conforms.
export type FloatingAgentState = {
  kind: string
  sessionId: string | null
  mode: 'auto' | 'manual' | null
  hasCustomSize: boolean
}

// Floating global agent panel — ops + the 3 streaming emitters the
// floatingAgent subscriptions consume. Same instances back the
// `floating-global-agent-panel:*` IPC handlers (coexistence until slice 5).
export type FloatingAgentHost = {
  setEnabled: (enabled: boolean) => unknown
  setSessionId: (sessionId: string | null) => unknown
  setPanelOpen: (isOpen: boolean) => unknown
  toggleCollapse: () => unknown
  resetSize: () => unknown
  detach: () => unknown
  reattach: () => unknown
  getState: () => FloatingAgentState
  getSession: () => unknown
  getConfig: () => unknown
  events: EventEmitter & {
    on(event: 'state', listener: (payload: FloatingAgentState) => void): EventEmitter
    on(event: 'session-changed', listener: () => void): EventEmitter
    on(event: 'collapse-changed', listener: (collapsed: boolean) => void): EventEmitter
    off(event: string, listener: (...args: unknown[]) => void): EventEmitter
  }
}

export type AgentPanelsRouterDeps = {
  /** The host, read on every call (the registry may be set late). */
  getHost: () => { floatingAgent: FloatingAgentHost }
}

let deps: AgentPanelsRouterDeps | null = null

export function setAgentPanelsRouterDeps(next: AgentPanelsRouterDeps): void {
  deps = next
}

export function getAgentPanelsHost(): { floatingAgent: FloatingAgentHost } {
  if (!deps)
    throw new Error(
      'agent-panels router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps.getHost()
}
