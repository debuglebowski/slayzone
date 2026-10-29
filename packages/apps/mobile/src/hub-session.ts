/**
 * Signing in to a hub, the way desktop and the CLI do: a hub address plus email +
 * password for a bearer (`@slayzone/hub-auth/client`), kept in the platform's secure
 * storage behind `HubTokenStore`.
 */
import {
  createFetchHubTransport,
  type HubTokenStore,
  probeHubHealth,
  signInWithPassword
} from '@slayzone/hub-auth/client'
import { hubUrlFromAddr, isBareAuthority } from '@slayzone/platform/hub-addr'
import type { HubEntry } from '@slayzone/platform/hub-registry'
import * as SecureStore from 'expo-secure-store'

/** A hub this app is signed in to. */
export interface HubSession {
  entry: HubEntry
  token: string
}

/** React Native's `fetch` — no cookies, no Fetch Metadata headers, so no browser CSRF path. */
const transport = createFetchHubTransport(fetch)

// SecureStore keys allow only [A-Za-z0-9._-].
const storeKey = (hubId: string): string => `hub-token.${hubId.replace(/[^A-Za-z0-9._-]/g, '_')}`

/** `HubTokenStore` over the iOS keychain / Android keystore. */
export const secureTokenStore: HubTokenStore = {
  get: (hubId) => SecureStore.getItemAsync(storeKey(hubId)).catch(() => null),
  set: (hubId, token) => SecureStore.setItemAsync(storeKey(hubId), token),
  delete: (hubId) => SecureStore.deleteItemAsync(storeKey(hubId))
}

const LAST_HUB_KEY = 'last-hub'

/** The registry entry of a hub authority (`host[:port]`): same shape and id as desktop's. */
function hubEntryOf(address: string): HubEntry {
  const url = hubUrlFromAddr(address, 'ws', '/trpc')
  return { id: `hub:${url}`, kind: 'remote', label: address, url }
}

export type SignInResult = { ok: true; session: HubSession } | { ok: false; error: string }

/** Probe the hub, sign in with a password, keep the bearer. */
export async function signIn(
  address: string,
  email: string,
  password: string
): Promise<SignInResult> {
  const addr = address.trim()
  if (!isBareAuthority(addr)) return { ok: false, error: 'Enter the hub as host or host:port' }
  const baseUrl = hubUrlFromAddr(addr, 'http')
  const health = await probeHubHealth(transport, baseUrl)
  if (!health.ok) return { ok: false, error: health.error }
  if (health.signIn && !health.signIn.password) {
    return { ok: false, error: 'This hub does not offer password sign-in' }
  }
  const result = await signInWithPassword(transport, baseUrl, { email: email.trim(), password })
  if (!result.ok) return { ok: false, error: result.hubError ?? result.error }
  const entry = hubEntryOf(addr)
  await secureTokenStore.set(entry.id, result.token)
  await SecureStore.setItemAsync(LAST_HUB_KEY, addr)
  return { ok: true, session: { entry, token: result.token } }
}

/** The session kept from the last sign-in, if its token is still stored. */
export async function restoreSession(): Promise<HubSession | null> {
  const addr = await SecureStore.getItemAsync(LAST_HUB_KEY).catch(() => null)
  if (!addr) return null
  const entry = hubEntryOf(addr)
  const token = await secureTokenStore.get(entry.id)
  return token ? { entry, token } : null
}

/** Forget the session's bearer. */
export async function signOut(session: HubSession): Promise<void> {
  await secureTokenStore.delete(session.entry.id)
  await SecureStore.deleteItemAsync(LAST_HUB_KEY)
}
