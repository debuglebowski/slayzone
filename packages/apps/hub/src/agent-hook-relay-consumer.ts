import type { RestApiDeps, TerminalStateBridge } from '@slayzone/api'
import { getAuthGate, processAgentHook } from '@slayzone/api'
import { AGENT_HOOK_EVENT_NAME } from '@slayzone/computer-transport/shared'
import { runWithSecurityContext } from '@slayzone/platform/security-log'

/**
 * Minimal slice of the hub computer gateway this consumer needs: subscribe to the
 * generic computer→hub `event` notification. Kept structural so the unit test can
 * drive it with a tiny fake instead of a full `createHubComputerGateway`.
 */
export interface AgentHookRelayGateway {
  events: {
    on(
      event: 'event',
      listener: (payload: { computerId: string; name: string; payload?: unknown }) => void
    ): void
  }
}

/**
 * The user a computer reports as: its owner (`computers.owner_user_id`), or null for
 * an unowned or unknown computer. `computerId` is the gateway's authenticated
 * connection id (hub-gateway.ts), never a field of the relayed payload.
 */
export async function computerOwnerOf(
  db: RestApiDeps['db'],
  computerId: string
): Promise<string | null> {
  const row = await db.get<{ owner_user_id: string | null }>(
    'SELECT owner_user_id FROM computers WHERE id = ?',
    [computerId]
  )
  return row?.owner_user_id ?? null
}

/**
 * Wire the hub-side consumer for computer-RELAYED agent hooks (hub/computer split).
 *
 * A computer-routed pty posts its lifecycle hook to the COMPUTER's OWN loopback
 * `/api/agent-hook`; the computer forwards the raw envelope to the hub over its
 * authenticated ws channel as a generic `event` with `name: 'agent-hook'`. This
 * feeds that envelope through the SAME `processAgentHook` authority the local
 * loopback HTTP route uses — identical field resolution, state machine, prompt
 * capture, and conversation-id persistence — so a remote hook and a local hook
 * are byte-for-byte equivalent from the server's point of view.
 *
 * On a hub with login (T-18) the event is reported AS THE COMPUTER'S OWNER: it is
 * processed under that user's security context (its refresh pings reach only their
 * streams), and `processAgentHook` drops — with one audit line — an event naming a
 * task or session that owner may not touch. So a computer reports only for the
 * sessions it runs for its owner, and an unowned computer for nobody. Without login
 * (the desktop app's hub) nothing is looked up: as before.
 *
 * Extracted from the composition root so it is directly unit-testable (the
 * composition root's async gateway init is not). Best-effort by contract: a
 * non-matching event is ignored, and a malformed/failing relayed hook must NEVER
 * throw out of the gateway's event loop (that would destabilize every computer).
 */
export function attachAgentHookRelayConsumer(
  gateway: AgentHookRelayGateway,
  deps: RestApiDeps,
  bridge: TerminalStateBridge | undefined
): void {
  gateway.events.on('event', (evt) => {
    if (evt.name !== AGENT_HOOK_EVENT_NAME) return
    void relayAgentHook(evt.computerId, evt.payload, deps, bridge).catch(() => {
      /* best-effort — a relayed hook never destabilizes the gateway */
    })
  })
}

/** One relayed envelope, reported as the computer's owner on a hub with login. */
export async function relayAgentHook(
  computerId: string,
  payload: unknown,
  deps: RestApiDeps,
  bridge: TerminalStateBridge | undefined
): Promise<'ok' | 'unknown' | 'bad' | 'denied'> {
  if (!getAuthGate()) return processAgentHook(payload, deps, bridge)
  const owner = await computerOwnerOf(deps.db, computerId)
  return runWithSecurityContext({ actor: owner, ip: null, route: 'computer agent-hook' }, () =>
    processAgentHook(payload, deps, bridge, { userId: owner, computerId })
  )
}
