import type { RestApiDeps, TerminalStateBridge } from '@slayzone/transport/server'
import { processAgentHook } from '@slayzone/transport/server'
import { AGENT_HOOK_EVENT_NAME } from '@slayzone/runner-transport/shared'

/**
 * Minimal slice of the hub runner gateway this consumer needs: subscribe to the
 * generic runner→hub `event` notification. Kept structural so the unit test can
 * drive it with a tiny fake instead of a full `createHubRunnerGateway`.
 */
export interface AgentHookRelayGateway {
  events: {
    on(
      event: 'event',
      listener: (payload: { runnerId: string; name: string; payload?: unknown }) => void
    ): void
  }
}

/**
 * Wire the hub-side consumer for runner-RELAYED agent hooks (hub/runner split).
 *
 * A runner-routed pty posts its lifecycle hook to the RUNNER's OWN loopback
 * `/api/agent-hook`; the runner forwards the raw envelope to the hub over its
 * authenticated ws channel as a generic `event` with `name: 'agent-hook'`. This
 * feeds that envelope through the SAME `processAgentHook` authority the local
 * loopback HTTP route uses — identical field resolution, state machine, prompt
 * capture, and conversation-id persistence — so a remote hook and a local hook
 * are byte-for-byte equivalent from the server's point of view.
 *
 * Extracted from the composition root so it is directly unit-testable (the
 * composition root's async gateway init is not). Best-effort by contract: a
 * non-matching event is ignored, and a malformed/failing relayed hook must NEVER
 * throw out of the gateway's event loop (that would destabilize every runner).
 */
export function attachAgentHookRelayConsumer(
  gateway: AgentHookRelayGateway,
  deps: RestApiDeps,
  bridge: TerminalStateBridge | undefined
): void {
  gateway.events.on('event', (evt) => {
    if (evt.name !== AGENT_HOOK_EVENT_NAME) return
    void processAgentHook(evt.payload, deps, bridge).catch(() => {
      /* best-effort — a relayed hook never destabilizes the gateway */
    })
  })
}
