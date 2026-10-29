import { isPathAllowed, type Scope } from '../shared/scopes'
import type { RuntimeClient } from './runtime'

/**
 * The one procedure this module calls, typed structurally: transport names no router
 * (`hub` is composed in `@slayzone/api`). Only the field read here is declared.
 */
type HubDescribeClient = {
  hub: { describe: { query: () => Promise<{ scopes?: readonly Scope[] | null }> } }
}

/**
 * The scopes each hub connection holds, asked once per client (`hub.describe`).
 * Keyed by the client object: a hub whose token changes gets a new client
 * (`getOrCreateHubClient`), so a stale answer never outlives its credential.
 */
const scopesByClient = new WeakMap<object, Promise<readonly Scope[] | null>>()

function scopesOf(client: RuntimeClient): Promise<readonly Scope[] | null> {
  let scopes = scopesByClient.get(client)
  if (!scopes) {
    // Every view's client is the one path-based runtime client, and every hub serves
    // `hub.describe`: reading it through this structural type is sound for any view.
    scopes = (client as unknown as HubDescribeClient).hub.describe.query().then(
      // `?? null`: a hub older than the field sends none.
      (d) => d.scopes ?? null,
      (err: unknown) => {
        // Not remembered: the next call asks again, once the hub is back.
        scopesByClient.delete(client)
        throw err
      }
    )
    scopesByClient.set(client, scopes)
  }
  return scopes
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
  const scopes = await scopesOf(client).catch(() => null)
  return scopes === null || isPathAllowed(scopes, path)
}
