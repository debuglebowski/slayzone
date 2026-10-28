import type { TypedEmitter } from '@slayzone/platform/events'
import type { AgentLifecycleEvent } from '@slayzone/terminal-contracts'

// Hook-driven agent lifecycle bus. The agent-hook REST route emits one event per
// terminal-agent hook (after the agent tree / state machine have handled it); the
// `agentLifecycle.onEvent` subscription streams them. Host-owned, injected at boot.
export type AgentLifecycleEventMap = {
  event: [event: AgentLifecycleEvent]
}

let agentLifecycleEvents: TypedEmitter<AgentLifecycleEventMap> | null = null

export function setAgentLifecycleEvents(ev: TypedEmitter<AgentLifecycleEventMap>): void {
  agentLifecycleEvents = ev
}

export function getAgentLifecycleEvents(): TypedEmitter<AgentLifecycleEventMap> {
  if (!agentLifecycleEvents)
    throw new Error(
      'agentLifecycleEvents not initialized — call setAgentLifecycleEvents() in main host first'
    )
  return agentLifecycleEvents
}
