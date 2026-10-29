import { isPathAllowed, type Scope } from '../shared/scopes'
import type { RuntimeClient } from './runtime'

/** The fields of a `hub.describe` answer this module reads. A hub older than one sends none. */
type HubDescribe = {
  scopes?: readonly Scope[] | null
  switches?: { enableTelemetry?: boolean }
}

/**
 * The one procedure this module calls, typed structurally: transport names no router
 * (`hub` is composed in `@slayzone/api`). Only the fields read here are declared.
 */
type HubDescribeClient = { hub: { describe: { query: () => Promise<HubDescribe> } } }

/**
 * Each hub connection's `hub.describe` answer, asked once per client. Keyed by the
 * client object: a hub whose token changes gets a new client (`getOrCreateHubClient`),
 * so a stale answer never outlives its credential.
 */
const describeByClient = new WeakMap<object, Promise<HubDescribe>>()

function describeOf(client: RuntimeClient): Promise<HubDescribe> {
  let answer = describeByClient.get(client)
  if (!answer) {
    // Every view's client is the one path-based runtime client, and every hub serves
    // `hub.describe`: reading it through this structural type is sound for any view.
    answer = (client as unknown as HubDescribeClient).hub.describe.query().catch((err: unknown) => {
      // Not remembered: the next call asks again, once the hub is back.
      describeByClient.delete(client)
      throw err
    })
    describeByClient.set(client, answer)
  }
  return answer
}

/**
 * May this connection call `path` on the hub behind `client`? The same check the
 * hub's scope gate makes (`scopes.ts`), so a client can skip a call it would only be
 * refused — a web session pushing warm-pool counts (#164). Advisory: the hub's gate
 * stays the boundary.
 *
 * True when nothing restricts the caller (no login, a full principal, a hub older
 * than `describe.scopes`) and when the hub cannot be asked — the call itself then
 * fails the way it always did.
 *
 * Takes any view's client (`RuntimeClient`): the check is about the hub, not about the
 * routers the caller's view types.
 */
export async function hubAllows(client: RuntimeClient, path: string): Promise<boolean> {
  // `?? null`: a hub older than the field sends none.
  const scopes = await describeOf(client).then(
    (d) => d.scopes ?? null,
    () => null
  )
  return scopes === null || isPathAllowed(scopes, path)
}

/**
 * Does the hub behind `client` permit third-party telemetry (PostHog, Convex) —
 * `SLAYZONE_HUB_ENABLE_TELEMETRY`, reported in `hub.describe`'s switches?
 *
 * True for a hub older than the switch (it cannot turn telemetry off). FAILS CLOSED:
 * false when the hub cannot be asked, so a client never starts telemetry it could not
 * confirm. The answer is not remembered then; the next call asks again.
 */
export async function hubPermitsTelemetry(client: RuntimeClient): Promise<boolean> {
  return describeOf(client).then(
    (d) => d.switches?.enableTelemetry !== false,
    () => false
  )
}
