import { CHAT_HISTORY_DISPLAY_VERSION } from '@slayzone/terminal-contracts'
import { isPathAllowed, type Scope } from '../shared/scopes'
import {
  apiIncompatibility,
  type ApiIncompatibility,
  HUB_API_VERSION,
  type HubFeature,
  hubApiInfoOf,
  MIN_HUB_API
} from '@slayzone/trpc-server/api-version'
import type { RuntimeClient } from './runtime'

/** The fields of a `hub.describe` answer this module reads. A hub older than one sends none. */
type HubDescribe = {
  scopes?: readonly Scope[] | null
  switches?: { enableTelemetry?: boolean }
  wire?: { compactBytes?: boolean; toolPreviews?: boolean; chatDisplay?: number }
  features?: readonly string[]
}

/**
 * The one procedure this module calls, typed structurally: transport names no router
 * (`hub` is composed in `@slayzone/api`). Only the fields read here are declared.
 */
type HubDescribeClient = { hub: { describe: { query: () => Promise<HubDescribe> } } }

/**
 * Each hub connection's `hub.describe` answer, asked once per client. Keyed by the
 * client object: a hub whose token changes gets a new client (`getOrCreateHubClient`),
 * so a stale answer never outlives its credential. A fresher answer — the health
 * watch asks again on every socket open (`hubIssues.ts`), so a hub upgraded behind
 * the same client is seen — replaces it through {@link rememberDescribe}.
 */
const describeByClient = new WeakMap<object, Promise<HubDescribe>>()
/** The settled answer, for the synchronous checks ({@link knownApiIncompatibility}). */
const settledByClient = new WeakMap<object, HubDescribe>()

function describeOf(client: RuntimeClient): Promise<HubDescribe> {
  let answer = describeByClient.get(client)
  if (!answer) {
    // Every view's client is the one path-based runtime client, and every hub serves
    // `hub.describe`: reading it through this structural type is sound for any view.
    answer = (client as unknown as HubDescribeClient).hub.describe.query().then(
      (d) => {
        if (describeByClient.get(client) === answer) settledByClient.set(client, d)
        return d
      },
      (err: unknown) => {
        // Not remembered: the next call asks again, once the hub is back.
        if (describeByClient.get(client) === answer) describeByClient.delete(client)
        throw err
      }
    )
    describeByClient.set(client, answer)
  }
  return answer
}

/** Take a fresh `hub.describe` answer for `client` as the one every check reads. */
export function rememberDescribe(client: object, answer: unknown): void {
  const d = (answer && typeof answer === 'object' ? answer : {}) as HubDescribe
  describeByClient.set(client, Promise.resolve(d))
  settledByClient.set(client, d)
}

/**
 * `wire` flags that meant a feature before `features` existed. Read only for a hub
 * that sends no `features`; dropped once such hubs leave the support window
 * (`MIN_HUB_API` ≥ 1).
 */
const LEGACY_WIRE_FLAG: Partial<Record<HubFeature, keyof NonNullable<HubDescribe['wire']>>> = {
  'compact-bytes': 'compactBytes',
  'tool-previews': 'toolPreviews'
}

function describeHas(d: HubDescribe, feature: HubFeature): boolean {
  if (Array.isArray(d.features)) return d.features.includes(feature)
  const flag = LEGACY_WIRE_FLAG[feature]
  return flag !== undefined && d.wire?.[flag] === true
}

/**
 * Does the hub behind `client` have `feature` (`@slayzone/trpc-server/api-version`'s
 * `HUB_FEATURES`)? Check before using anything a hub gained after this client's
 * `MIN_HUB_API`, so an older hub hides it instead of failing it. False when the hub
 * cannot be asked; not remembered then.
 */
export async function hubHasFeature(client: RuntimeClient, feature: HubFeature): Promise<boolean> {
  return describeOf(client).then(
    (d) => describeHas(d, feature),
    () => false
  )
}

/**
 * Can this client and the hub behind `client` work together, as far as the last
 * `hub.describe` answer says? Null while none has come, and when they can.
 * Synchronous, for the link that keeps calls away from an incompatible hub.
 */
export function knownApiIncompatibility(client: object): ApiIncompatibility | null {
  const d = settledByClient.get(client)
  return d
    ? apiIncompatibility(hubApiInfoOf(d), { clientApi: HUB_API_VERSION, minHubApi: MIN_HUB_API })
    : null
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

/**
 * Does the hub behind `client` read compact (base64) bytes in inputs — the
 * `compact-bytes` feature (`compactBytesLink`)?
 *
 * False for a hub older than the field, and when the hub cannot be asked: the client
 * then sends plain superjson, which every hub reads. Not remembered on failure.
 */
export async function hubReadsCompactBytes(client: RuntimeClient): Promise<boolean> {
  return hubHasFeature(client, 'compact-bytes')
}

/** Can a direct preview still read its full tool detail if the direct link drops? */
export async function hubSupportsToolPreviews(
  client: RuntimeClient,
  withDisplay = false
): Promise<boolean> {
  return describeOf(client).then(
    (d) =>
      describeHas(d, 'tool-previews') &&
      (!withDisplay || d.wire?.chatDisplay === CHAT_HISTORY_DISPLAY_VERSION),
    () => false
  )
}
