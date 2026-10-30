/**
 * Signing in to hubs, the way desktop and the CLI do: a hub address plus email +
 * password for a bearer (`@slayzone/hub-auth/client`), kept in the platform's secure
 * storage. The app can be signed in to several hubs at once.
 *
 * In the keychain (iOS keychain / Android keystore, `expo-secure-store`):
 * - `hub-token.<hub id>`: each hub's bearer (`HubTokenStore`, the same key as before
 *   several hubs).
 * - `hubs`: `{ v: 1, hubs: [address, …] }`, the signed-in hubs in sign-in order. The
 *   first is the app's primary hub (its theme paints the app, see `hub-connections`).
 * - `last-hub`: the single session of earlier versions; moved into `hubs` at the first
 *   launch that reads it.
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

/** Where the sessions are kept: text values by key (the keychain in the app). */
export interface SessionStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface HubSessionStore {
  /**
   * The sessions kept from earlier sign-ins, in sign-in order. A listed hub whose
   * bearer cannot be read is left out (and stays listed: signing in to it again puts
   * it back in its place). Rejects when the list itself cannot be read.
   */
  restore(): Promise<HubSession[]>
  /** Keep a hub's bearer; a new hub is listed last, a listed one keeps its place. */
  save(session: HubSession): Promise<void>
  /** Forget a hub's bearer and unlist it (sign-out). */
  forget(hubId: string): Promise<void>
}

/** The registry entry of a hub authority (`host[:port]`): same shape and id as desktop's. */
export function hubEntryOf(address: string): HubEntry {
  const url = hubUrlFromAddr(address, 'ws', '/trpc')
  return { id: `hub:${url}`, kind: 'remote', label: address, url }
}

const LIST_KEY = 'hubs'
const LEGACY_LAST_HUB_KEY = 'last-hub'
const LIST_VERSION = 1

// SecureStore keys allow only [A-Za-z0-9._-].
const tokenKey = (hubId: string): string => `hub-token.${hubId.replace(/[^A-Za-z0-9._-]/g, '_')}`

/** `HubTokenStore` (hub-auth's bearer storage contract) over `storage`. */
export function tokenStoreOver(storage: SessionStorage): HubTokenStore {
  return {
    get: (hubId) => storage.get(tokenKey(hubId)).catch(() => null),
    set: (hubId, token) => storage.set(tokenKey(hubId), token),
    delete: (hubId) => storage.delete(tokenKey(hubId))
  }
}

export function createHubSessionStore(storage: SessionStorage): HubSessionStore {
  const tokens = tokenStoreOver(storage)

  /**
   * The listed addresses; null = no list yet; a list that does not parse = none. A
   * storage that throws fails the call: a save must never overwrite a list it could
   * not read.
   */
  const readList = async (): Promise<string[] | null> => {
    const text = await storage.get(LIST_KEY)
    if (text === null) return null
    try {
      const file: unknown = JSON.parse(text)
      if (
        typeof file === 'object' &&
        file !== null &&
        (file as { v?: unknown }).v === LIST_VERSION &&
        Array.isArray((file as { hubs?: unknown }).hubs)
      ) {
        return (file as { hubs: unknown[] }).hubs.filter(
          (a): a is string => typeof a === 'string' && isBareAuthority(a)
        )
      }
    } catch {
      // fall through: unreadable
    }
    return []
  }
  const writeList = (addresses: string[]): Promise<void> =>
    storage.set(LIST_KEY, JSON.stringify({ v: LIST_VERSION, hubs: addresses }))

  /** The list, after moving an earlier version's single session into it. */
  const listWithMigration = async (): Promise<string[]> => {
    const listed = await readList()
    if (listed !== null) return listed
    const legacy = await storage.get(LEGACY_LAST_HUB_KEY)
    if (!legacy || !isBareAuthority(legacy)) return []
    await writeList([legacy])
    await storage.delete(LEGACY_LAST_HUB_KEY)
    return [legacy]
  }

  // Read-modify-write of the list, one at a time: two sign-ins finishing together
  // must both be listed.
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(op: () => Promise<T>): Promise<T> => {
    const run = queue.then(op, op)
    queue = run.catch(() => undefined)
    return run
  }

  return {
    restore: () =>
      serialized(async () => {
        const sessions: HubSession[] = []
        for (const address of await listWithMigration()) {
          const entry = hubEntryOf(address)
          const token = await tokens.get(entry.id)
          if (token) sessions.push({ entry, token })
        }
        return sessions
      }),
    save: (session) =>
      serialized(async () => {
        await tokens.set(session.entry.id, session.token)
        const listed = await listWithMigration()
        if (!listed.some((a) => hubEntryOf(a).id === session.entry.id)) {
          await writeList([...listed, session.entry.label])
        }
      }),
    forget: (hubId) =>
      serialized(async () => {
        await tokens.delete(hubId)
        const listed = await listWithMigration()
        await writeList(listed.filter((a) => hubEntryOf(a).id !== hubId))
      })
  }
}

/** The keychain, through expo-secure-store. */
const secureStorage: SessionStorage = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  delete: (key) => SecureStore.deleteItemAsync(key)
}

/** The app's sessions, in the keychain. */
export const hubSessions: HubSessionStore = createHubSessionStore(secureStorage)

/** React Native's `fetch` — no cookies, no Fetch Metadata headers, so no browser CSRF path. */
const transport = createFetchHubTransport(fetch)

export type SignInResult = { ok: true; session: HubSession } | { ok: false; error: string }

/** Probe the hub, sign in with a password, keep the bearer (`hubSessions`). */
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
  const session: HubSession = { entry: hubEntryOf(addr), token: result.token }
  await hubSessions.save(session)
  return { ok: true, session }
}
