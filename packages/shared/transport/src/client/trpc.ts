import type { TRPCClient, TRPCLink } from '@trpc/client'
import type { AppRouter } from './app-router'
import {
  createTrpcWsClient as createRuntimeWsClient,
  initTrpcClient as initRuntimeClient,
  getOrCreateHubClient as getOrCreateRuntimeHubClient,
  type CreateTrpcClientOpts as RuntimeCreateOpts,
  type RuntimeWsClient
} from './runtime'
import { trpcFor, type TypedHubWsClient } from './view'

/**
 * TEMPORARY: the runtime typed against the WHOLE `AppRouter`, for every caller not yet
 * on its own typed view. This file and `app-router.ts` are the only reason transport
 * still depends on `@slayzone/api`; both are deleted once the last caller has moved
 * (see README.md, "Typed views → migrating a domain"). New code does not import these:
 * a domain uses `typedTrpc<ItsMounts>()`, an app `trpcFor<AppRouter>()`.
 *
 * Components: `const trpc = useTRPC()` then `useQuery(trpc.x.queryOptions(...))`,
 * `useMutation(trpc.x.mutationOptions(...))`, `useSubscription(trpc.x.subscriptionOptions(...))`.
 */
export const {
  useTRPC,
  useTRPCClient,
  getTrpcClient,
  getHubClient,
  listHubClients,
  getClientForHub,
  getClientForProject,
  getClientForTask,
  useClientForProject,
  useClientForTask
} = trpcFor<AppRouter>()

// Type-only re-export so out-of-package callers (e.g. the Chromium fork's
// browser-over-mojo terminating link) can type a `TRPCLink<AppRouter>` without
// reaching into the server entrypoint.
export type { AppRouter }

export type TrpcVanillaClient = TRPCClient<AppRouter>
export type HubWsClient = TypedHubWsClient<AppRouter>

export type CreateTrpcClientOpts = Omit<RuntimeCreateOpts, 'links'> & {
  links?: TRPCLink<AppRouter>[]
}

export const createTrpcWsClient = createRuntimeWsClient as unknown as (
  opts: CreateTrpcClientOpts
) => { wsClient: RuntimeWsClient; client: TrpcVanillaClient }

export const initTrpcClient = initRuntimeClient as unknown as (
  url: string,
  opts?: { links?: TRPCLink<AppRouter>[]; token?: string }
) => { client: TrpcVanillaClient; wsClient: RuntimeWsClient }

export const getOrCreateHubClient = getOrCreateRuntimeHubClient as unknown as (opts: {
  id: string
  url: string
  isDefault?: boolean
  links?: TRPCLink<AppRouter>[]
  token?: string
}) => HubWsClient

export { _resetHubClients, _setTrpcClientSingleton } from './runtime'
