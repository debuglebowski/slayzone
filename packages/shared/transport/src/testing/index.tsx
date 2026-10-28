import type { ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { TRPCProvider } from '../client/runtime'
import type { TrpcVanillaClient, AppRouter } from '../client/trpc'
import { makeQueryClient } from '../client/provider'

/** Resolves a query or mutation; a throw/rejection surfaces as the tRPC error. */
// biome-ignore lint/suspicious/noExplicitAny: inputs are whatever the hook under test sends
export type TestProcedure = (input: any) => unknown
/** Starts a subscription; call `emit` per event, return the teardown. */
export type TestSubscription = (
  // biome-ignore lint/suspicious/noExplicitAny: see TestProcedure
  input: any,
  emit: (data: unknown) => void
) => (() => void) | void

export interface TrpcTestBackend {
  /** Queries + mutations, keyed by dotted path (`'fileEditor.readFile'`). */
  procedures?: Record<string, TestProcedure>
  /** Subscriptions, keyed by dotted path (`'fileEditor.watch'`). */
  subscriptions?: Record<string, TestSubscription>
}

export interface TrpcTest {
  trpcClient: TrpcVanillaClient
  queryClient: QueryClient
  /** `renderHook(..., { wrapper })` / `render(..., { wrapper })`. */
  wrapper: (props: { children: ReactNode }) => ReactNode
}

/**
 * In-memory tRPC backend for client hook/component tests: the REAL client,
 * TRPCProvider and app QueryClient defaults, with a terminating link that
 * resolves each operation against `backend` instead of a hub socket. An
 * operation with no handler fails loudly (`unexpected op <path>`), so a hook
 * that grows a new call can't silently pass.
 */
export function createTrpcTest(backend: TrpcTestBackend): TrpcTest {
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') {
          const start = backend.subscriptions?.[op.path]
          if (!start) {
            observer.error(new Error(`unexpected op ${op.path}`) as never)
            return () => undefined
          }
          observer.next({ result: { type: 'started' } })
          const teardown = start(op.input, (data) =>
            observer.next({ result: { type: 'data', data } })
          )
          return () => teardown?.()
        }
        const resolve = backend.procedures?.[op.path]
        if (!resolve) {
          observer.error(new Error(`unexpected op ${op.path}`) as never)
          return () => undefined
        }
        Promise.resolve()
          .then(() => resolve(op.input))
          .then(
            (data) => {
              observer.next({ result: { type: 'data', data } })
              observer.complete()
            },
            (err: unknown) => observer.error(err as never)
          )
        return () => undefined
      })

  const trpcClient = createTRPCClient<AppRouter>({ links: [link] })
  const queryClient = makeQueryClient()
  return {
    trpcClient,
    queryClient,
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          {children}
        </TRPCProvider>
      </QueryClientProvider>
    )
  }
}
