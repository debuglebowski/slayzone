import { isPathAllowed, type Scope } from '../server/scopes'
import type { TrpcVanillaClient } from './trpc'

/**
 * The scopes each hub connection holds, asked once per client (`hub.describe`).
 * Keyed by the client object: a hub whose token changes gets a new client
 * (`getOrCreateHubClient`), so a stale answer never outlives its credential.
 */
const scopesByClient = new WeakMap<object, Promise<readonly Scope[] | null>>()

function scopesOf(client: TrpcVanillaClient): Promise<readonly Scope[] | null> {
  let scopes = scopesByClient.get(client)
  if (!scopes) {
    scopes = client.hub.describe.query().then(
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
 */
export async function hubAllows(client: TrpcVanillaClient, path: string): Promise<boolean> {
  const scopes = await scopesOf(client).catch(() => null)
  return scopes === null || isPathAllowed(scopes, path)
}
