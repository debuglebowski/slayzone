/**
 * Signing in to hubs, the way desktop and the CLI do: a hub address plus email +
 * password for a bearer (`@slayzone/hub-auth/client`), kept in the platform's secure
 * storage. The app can be signed in to several hubs at once. "Sign in with Microsoft"
 * (`auth/microsoft-sign-in.ts`) keeps its bearer here the same way.
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
  fetchHubHealth,
  type HubHealthProbe,
  type HubPasswordSignInResult,
  type HubTokenStore,
  type HubTransport,
  DEFAULT_SSO_LABEL,
  healthProbeOf,
  signInWithPassword
} from '@slayzone/hub-auth/client'
import { hubUrlFromAddr, isBareAuthority } from '@slayzone/platform/hub-addr'
import type { HubEntry } from '@slayzone/platform/hub-registry'
import * as SecureStore from 'expo-secure-store'
import type { InProcessHub } from './in-process-hub'

/** A hub this app is signed in to. */
export interface HubSession {
  entry: HubEntry
  token: string
  /**
   * The hub is served inside the app (the demo hub): its tRPC and REST go to this,
   * never to the network, and the session is never kept in the keychain.
   */
  inProcess?: InProcessHub
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

/**
 * React Native's `fetch` — no cookies, no Fetch Metadata headers, so no browser CSRF path.
 * Read at each request, not captured at import, so a test can stand in for the hub.
 */
export const hubTransport: HubTransport = createFetchHubTransport((url, init) => fetch(url, init))

export type SignInResult =
  | { ok: true; session: HubSession }
  /** `cancelled`: the person closed the sign-in themselves — nothing to tell them. */
  | { ok: false; error: string; cancelled?: true }

/**
 * The hub address as people type or paste it → `host[:port]`: trimmed, without a scheme
 * (`https://`, `wss://` …), a path, query or fragment, the host in lower case (iOS
 * capitalises the first letter). What is left is still checked (`isBareAuthority`).
 * The app picks the scheme from the host (`hubUrlFromAddr`), as desktop does. Pure.
 */
export function normalizeHubAddress(typed: string): string {
  return typed
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase()
}

/** What to type, when what was typed is not a hub address. */
const ADDRESS_HELP =
  "Enter the hub's address, like hub.yourcompany.com or hub.yourcompany.com:8788."

/** How long a hub's `/health` may take. */
const HEALTH_TIMEOUT_MS = 5000

/** Why `address` could not be used, as a sentence naming it and what to check. */
const problems = {
  unreachable: (address: string) =>
    `Can't reach ${address}. Check the address, and that this phone is online on a network ` +
    "that can reach the hub (its office Wi-Fi or VPN, if it isn't on the internet).",
  timeout: (address: string) =>
    `${address} didn't answer in time. Check the address and your connection, then try again.`,
  notAHub: (address: string) =>
    `${address} isn't a SlayZone hub. Check the address with whoever set up your hub.`,
  serverError: (address: string, status: number) =>
    `${address} answered with an error (HTTP ${status}). Try again later, or tell whoever runs the hub.`,
  notReady: (address: string) => `${address} isn't ready yet. Try again in a minute.`,
  unexpected: (address: string) =>
    `${address} answered the sign-in in a way this app doesn't understand. The hub or this app may need an update.`
}

/** The hub at `address` gave no answer (`unreachable`) or not in time, as a sentence. */
export function cantReachHub(address: string, reason: 'unreachable' | 'timeout'): string {
  return reason === 'timeout' ? problems.timeout(address) : problems.unreachable(address)
}

type HubHealth = Extract<HubHealthProbe, { ok: true }>

/** Ask the hub at `address` (`host[:port]`) for `/health`; a failure as a sentence. */
async function readHub(
  address: string,
  transport: HubTransport
): Promise<{ ok: true; baseUrl: string; health: HubHealth } | { ok: false; error: string }> {
  const baseUrl = hubUrlFromAddr(address, 'http')
  const read = await fetchHubHealth(transport, baseUrl, HEALTH_TIMEOUT_MS)
  if (!read.reachable) return { ok: false, error: cantReachHub(address, read.reason) }
  if (read.status === 404) return { ok: false, error: problems.notAHub(address) }
  if (read.status !== 200) return { ok: false, error: problems.serverError(address, read.status) }
  const health = healthProbeOf(read.status, read.json)
  if (health.ok) return { ok: true, baseUrl, health }
  const isHub = typeof read.json === 'object' && read.json !== null && 'ok' in read.json
  return { ok: false, error: isHub ? problems.notReady(address) : problems.notAHub(address) }
}

/** A refused or failed password sign-in at `address`, as a sentence. Pure. */
function passwordProblem(
  address: string,
  result: Extract<HubPasswordSignInResult, { ok: false }>
): string {
  switch (result.reason) {
    case 'unreachable':
    case 'timeout':
      return cantReachHub(address, result.reason)
    case 'refused':
      // better-auth's sign-in answers 401 only for a wrong email or password.
      return result.status === 401 && result.code === undefined
        ? 'Wrong email or password.'
        : result.error
    default:
      return problems.unexpected(address)
  }
}

/** How a hub lets this app sign in. */
export interface HubSignInOffer {
  /** "Sign in with <ssoLabel>" (the hub's app sign-in, `/health` `appSignIn.microsoft`
   *  — the field keeps its name whatever the provider). */
  microsoft: boolean
  /** What the hub calls its SSO sign-in (`/health` `ssoLabel`): Microsoft or SSO. */
  ssoLabel: string
  /** Email + password; a hub too old to say is taken to offer it. */
  password: boolean
}

/** The offer a hub's `/health` answer makes. Pure. */
export function signInOfferOf(probe: HubHealth): HubSignInOffer {
  return {
    microsoft: probe.appSignIn?.microsoft === true,
    password: probe.signIn?.password !== false,
    ssoLabel: probe.signIn?.ssoLabel ?? DEFAULT_SSO_LABEL
  }
}

export type SignInOfferResult =
  | { ok: true; address: string; baseUrl: string; offer: HubSignInOffer }
  /** `address`: not `host[:port]`. `hub`: no usable `/health` answer. */
  | { ok: false; reason: 'address' | 'hub'; error: string }

/** Ask a hub (its address as typed, `normalizeHubAddress`) how this app may sign in to it. */
export async function probeSignInOffer(
  typed: string,
  transport: HubTransport = hubTransport
): Promise<SignInOfferResult> {
  const address = normalizeHubAddress(typed)
  if (!isBareAuthority(address)) return { ok: false, reason: 'address', error: ADDRESS_HELP }
  const hub = await readHub(address, transport)
  if (!hub.ok) return { ok: false, reason: 'hub', error: hub.error }
  return { ok: true, address, baseUrl: hub.baseUrl, offer: signInOfferOf(hub.health) }
}

/** Probe the hub, sign in with a password, keep the bearer (`hubSessions`). */
export async function signIn(
  typed: string,
  email: string,
  password: string
): Promise<SignInResult> {
  const address = normalizeHubAddress(typed)
  if (!isBareAuthority(address)) return { ok: false, error: ADDRESS_HELP }
  const hub = await readHub(address, hubTransport)
  if (!hub.ok) return { ok: false, error: hub.error }
  if (hub.health.signIn && !hub.health.signIn.password) {
    return { ok: false, error: 'This hub does not offer password sign-in' }
  }
  const result = await signInWithPassword(hubTransport, hub.baseUrl, {
    email: email.trim(),
    password
  })
  if (!result.ok) return { ok: false, error: passwordProblem(address, result) }
  const session: HubSession = { entry: hubEntryOf(address), token: result.token }
  await hubSessions.save(session)
  return { ok: true, session }
}
