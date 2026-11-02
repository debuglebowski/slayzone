import type { ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { createTRPCClient, type TRPCClient } from '@trpc/client'
import type { AnyTRPCRouter } from '@trpc/server'
import {
  type InProcessBackend,
  type InProcessProcedure,
  type InProcessSubscription,
  inProcessLink
} from '../client/inProcessLink'
import { TRPCProvider, type RuntimeClient } from '../client/runtime'
import { makeQueryClient } from '../client/provider'

/** Resolves a query or mutation; a throw/rejection surfaces as the tRPC error. */
export type TestProcedure = InProcessProcedure
/** Starts a subscription; call `emit` per event, return the teardown. */
export type TestSubscription = InProcessSubscription
/** Queries + mutations and subscriptions by dotted path (`inProcessLink`'s backend). */
export type TrpcTestBackend = InProcessBackend

/**
 * `TRouter` types `trpcClient` only (the wire is path-based). Defaults to the
 * router-agnostic runtime type; a test that calls `trpcClient` directly passes its
 * view's router (`createTrpcTest<MountedRouter<XMounts>>(...)`).
 */
export interface TrpcTest<TRouter extends AnyTRPCRouter = AnyTRPCRouter> {
  trpcClient: TRPCClient<TRouter>
  queryClient: QueryClient
  /** `renderHook(..., { wrapper })` / `render(..., { wrapper })`. */
  wrapper: (props: { children: ReactNode }) => ReactNode
}

/**
 * In-memory tRPC backend for client hook/component tests: the REAL client,
 * TRPCProvider and app QueryClient defaults, with a terminating link
 * (`inProcessLink`) that resolves each operation against `backend` instead of a
 * hub socket. An operation with no handler fails loudly (`unexpected op <path>`),
 * so a hook that grows a new call can't silently pass.
 */
export function createTrpcTest<TRouter extends AnyTRPCRouter = AnyTRPCRouter>(
  backend: TrpcTestBackend
): TrpcTest<TRouter> {
  const link = inProcessLink(backend)

  const runtimeClient: RuntimeClient = createTRPCClient<AnyTRPCRouter>({ links: [link] })
  // Same object, re-typed for the caller's router (path-based, see view.ts).
  const trpcClient = runtimeClient as unknown as TRPCClient<TRouter>
  const queryClient = makeQueryClient()
  return {
    trpcClient,
    queryClient,
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={runtimeClient} queryClient={queryClient}>
          {children}
        </TRPCProvider>
      </QueryClientProvider>
    )
  }
}
