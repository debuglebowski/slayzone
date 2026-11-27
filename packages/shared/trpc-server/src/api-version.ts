/**
 * Client ↔ hub API compatibility contract (docs/plans/client-hub-compat.md).
 *
 * A remote hub and the apps that connect to it (desktop, web shell, mobile, CLI)
 * update independently, so a client can be newer or older than its hub. Covers the
 * tRPC surface (every app's socket); the CLI's REST routes are not part of it yet. This module
 * is the one place both sides read to decide whether they can work together:
 *
 * - {@link HUB_API_VERSION}: the API surface's version. Bumped by the release that
 *   changes the API in a way {@link MIN_CLIENT_API} or {@link MIN_HUB_API} must
 *   exclude — `pnpm check:api-compat` (scripts/check-api-compat.mjs) says when.
 * - {@link MIN_CLIENT_API}: the oldest client API a hub of this release serves. A
 *   client below it gets `CLIENT_TOO_OLD` on every call but `hub.describe`.
 * - {@link MIN_HUB_API}: the oldest hub API a client of this release works with. A
 *   hub below it reads `incompatible` in the client (banner, Hubs card) and the
 *   client sends it nothing but `hub.describe`.
 *
 * A side that predates this contract sends no version and counts as API 0.
 *
 * Client-safe: no Node, no tRPC server imports (`@slayzone/trpc-server/api-version`).
 *
 * @module trpc-server/api-version
 */

/** This release's API version. Raise only with the minimums the compat check asks for. */
export const HUB_API_VERSION = 1

/** Oldest client API a hub of this release serves. 0 = every client, incl. pre-contract ones. */
export const MIN_CLIENT_API = 0

/**
 * Oldest hub API a client of this release works with. 0 would be every hub, incl.
 * pre-contract ones. 1: this app calls procedures a pre-contract hub (≤ v0.43) lacks
 * (open-tabs sync, the batched git panel reads, …) and reads fields it does not send,
 * with no feature flag such a hub could have announced — so it says "update the hub"
 * up front instead (`pnpm check:api-compat`).
 */
export const MIN_HUB_API = 1

/**
 * Optional hub features a client must check before using (`hub.describe` → `features`).
 * A new procedure or behaviour a client depends on goes here, so a client hides it on
 * an older hub instead of calling into a NOT_FOUND. Append-only.
 */
export const HUB_FEATURES = [
  /** A `Uint8Array` in an input may come as base64 (`bytes:base64`, ./wire-bytes). */
  'compact-bytes',
  /** Chat history carries tool previews (`chatDisplay` = display version). */
  'tool-previews'
] as const
export type HubFeature = (typeof HUB_FEATURES)[number]

/** Query parameter a client names its API version with, on its socket's url. */
export const CLIENT_API_QUERY = 'clientApi'

/** `data.appCode` of the refusal a hub sends a client below {@link MIN_CLIENT_API}. */
export const CLIENT_TOO_OLD = 'CLIENT_TOO_OLD'

/** The one procedure every hub answers whatever the versions: it is how they find out. */
export const VERSION_EXEMPT_PATH = 'hub.describe'

/** `url` with this client's API version added as {@link CLIENT_API_QUERY}. */
export function withClientApi(url: string, version: number = HUB_API_VERSION): string {
  const hashAt = url.indexOf('#')
  const base = hashAt === -1 ? url : url.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : url.slice(hashAt)
  if (new RegExp(`[?&]${CLIENT_API_QUERY}=`).test(base)) return url
  return `${base}${base.includes('?') ? '&' : '?'}${CLIENT_API_QUERY}=${version}${hash}`
}

function parseVersion(raw: string | null | undefined): number | null {
  if (raw == null || !/^\d{1,6}$/.test(raw)) return null
  return Number(raw)
}

/**
 * The API version a request url names ({@link CLIENT_API_QUERY}). None (a client older
 * than the contract) = 0; a malformed value is treated the same, never as "current".
 */
export function parseClientApi(url: string | undefined): number {
  const q = url?.indexOf('?') ?? -1
  if (!url || q === -1) return 0
  return parseVersion(new URLSearchParams(url.slice(q + 1)).get(CLIENT_API_QUERY)) ?? 0
}

/** What `hub.describe` says about the API, as a client reads it. */
export type HubApiInfo = {
  /** The hub's API version; 0 for a hub older than the contract. */
  version: number
  /** The oldest client API it serves; 0 when it does not say. */
  minClient: number
  /** The hub's release (`0.43.0`), when it says. */
  release: string | null
  features: readonly string[]
}

/** Read {@link HubApiInfo} from any `hub.describe` answer, old or new. */
export function hubApiInfoOf(describe: unknown): HubApiInfo {
  const d = (describe && typeof describe === 'object' ? describe : {}) as {
    version?: unknown
    api?: { version?: unknown; minClient?: unknown }
    features?: unknown
  }
  const int = (v: unknown): number =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0
  return {
    version: int(d.api?.version),
    minClient: int(d.api?.minClient),
    release: typeof d.version === 'string' ? d.version : null,
    features: Array.isArray(d.features)
      ? d.features.filter((f): f is string => typeof f === 'string')
      : []
  }
}

/** Why a client and a hub cannot work together; null when they can. */
export type ApiIncompatibility =
  | { side: 'hub'; hubApi: number; minHubApi: number; release: string | null }
  | { side: 'app'; clientApi: number; minClientApi: number; release: string | null }

/**
 * Can a client at `clientApi` that needs hubs ≥ `minHubApi` work with this hub?
 * The app is checked first: a hub refusing the app makes the hub's own age moot.
 */
export function apiIncompatibility(
  hub: HubApiInfo,
  client: { clientApi: number; minHubApi: number } = {
    clientApi: HUB_API_VERSION,
    minHubApi: MIN_HUB_API
  }
): ApiIncompatibility | null {
  if (client.clientApi < hub.minClient)
    return {
      side: 'app',
      clientApi: client.clientApi,
      minClientApi: hub.minClient,
      release: hub.release
    }
  if (hub.version < client.minHubApi)
    return { side: 'hub', hubApi: hub.version, minHubApi: client.minHubApi, release: hub.release }
  return null
}
