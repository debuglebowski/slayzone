import type { TRPCClient, TRPCLink } from '@trpc/client'
import type { AnyTRPCRouter } from '@trpc/server'
import type { TRPCOptionsProxy } from '@trpc/tanstack-react-query'
import type { MountedRouter, RouterMounts } from '@slayzone/trpc-server'
import {
  useRuntimeTRPC,
  useRuntimeTRPCClient,
  getTrpcClient,
  getHubClient,
  listHubClients,
  initTrpcClient,
  type RuntimeWsClient
} from './runtime'
import {
  getClientForHub,
  getClientForProject,
  getClientForTask,
  useClientForProject,
  useClientForTask
} from './hubOwnershipStore'

/**
 * Typed views over the ONE router-agnostic client runtime (`./runtime.ts`).
 *
 * A view is the runtime's own functions, re-typed for a router. Nothing is wrapped
 * or created: `useTRPC` of every view reads the same React context, `getTrpcClient`
 * returns the same boot singleton, `getHubClient` the same per-hub entry. tRPC's
 * clients and option proxies are path-based (a call is `path + input` on the wire;
 * the router type exists only at compile time), so a view typed with a SLICE of the
 * app router is sound exactly when the slice is mounted at the same keys. That is
 * what `MountedRouter` + api's slice assertion guarantee.
 *
 *   // a domain: packages/domains/<x>/src/client/trpc.ts
 *   export const { useTRPC, getTrpcClient } = typedTrpc<XMounts>()
 *
 *   // an app (sees api): the whole router
 *   export const { useTRPC } = trpcFor<AppRouter>()
 */

/** A per-hub WS entry, typed by a view. */
export type TypedHubWsClient<TRouter extends AnyTRPCRouter> = {
  id: string
  url: string
  /** The token this socket was OPENED with (see `getOrCreateHubClient`). */
  token?: string
  client: TRPCClient<TRouter>
  wsClient: RuntimeWsClient
}

type MaybeId = string | null | undefined

export interface TrpcView<TRouter extends AnyTRPCRouter> {
  /** Options proxy of the nearest `TRPCProvider` / `HubScope`. */
  useTRPC: () => TRPCOptionsProxy<TRouter>
  /** Vanilla client of the nearest `TRPCProvider` / `HubScope`. */
  useTRPCClient: () => TRPCClient<TRouter>
  /** The boot singleton (default hub); throws before `initTrpcClient`. */
  getTrpcClient: () => TRPCClient<TRouter>
  getHubClient: (id: string) => TypedHubWsClient<TRouter> | null
  listHubClients: () => TypedHubWsClient<TRouter>[]
  getClientForHub: (hubId: MaybeId, fallback?: TRPCClient<TRouter>) => TRPCClient<TRouter>
  getClientForProject: (projectId: MaybeId) => TRPCClient<TRouter>
  getClientForTask: (taskId: MaybeId) => TRPCClient<TRouter>
  useClientForProject: (projectId: MaybeId) => TRPCClient<TRouter>
  useClientForTask: (taskId: MaybeId) => TRPCClient<TRouter>
}

// The one place the runtime is re-typed. Frozen: every view is this same object.
const runtimeView = Object.freeze({
  useTRPC: useRuntimeTRPC,
  useTRPCClient: useRuntimeTRPCClient,
  getTrpcClient,
  getHubClient,
  listHubClients,
  getClientForHub,
  getClientForProject,
  getClientForTask,
  useClientForProject,
  useClientForTask
})

/**
 * The runtime typed against a whole router. Apps use it with `AppRouter`; domains use
 * `typedTrpc` instead, so the slice they name is checked against the composition.
 */
export function trpcFor<TRouter extends AnyTRPCRouter>(): TrpcView<TRouter> {
  return runtimeView as unknown as TrpcView<TRouter>
}

/**
 * The runtime typed against the routers a domain mounts (`{ tags: TagsRouter }`),
 * plus any of the domains it already depends on (`TagsMounts & ProjectsMounts`).
 */
export function typedTrpc<TMounts extends RouterMounts>(): TrpcView<MountedRouter<TMounts>> {
  return trpcFor<MountedRouter<TMounts>>()
}

/**
 * Boot helpers of the runtime, typed for an app's router. Separate from the view: only
 * an app's entry point boots the client (domains never do). `initTrpcClient` is the
 * runtime's own idempotent boot (first call wins the link stack); typing its links and
 * client with `TRouter` changes nothing on the wire.
 *
 *   // an app's boot (sees api)
 *   export const { initTrpcClient } = trpcBootFor<AppRouter>()
 */
export interface TrpcBoot<TRouter extends AnyTRPCRouter> {
  initTrpcClient: (
    url: string,
    opts?: { links?: TRPCLink<TRouter>[]; token?: string }
  ) => { client: TRPCClient<TRouter>; wsClient: RuntimeWsClient }
}

const runtimeBoot = Object.freeze({ initTrpcClient })

export function trpcBootFor<TRouter extends AnyTRPCRouter>(): TrpcBoot<TRouter> {
  return runtimeBoot as unknown as TrpcBoot<TRouter>
}
