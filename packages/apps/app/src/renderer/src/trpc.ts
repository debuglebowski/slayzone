import type { AppRouter } from '@slayzone/api'
import { trpcBootFor, trpcFor, type TrpcBoot, type TrpcView } from '@slayzone/transport/client'

/**
 * The desktop renderer's view of the client runtime: the WHOLE app router (an app sits
 * above `@slayzone/api`; domains use `typedTrpc<TheirMounts>()` instead). Same context,
 * socket and cache as every other view (`@slayzone/transport` README, "Typed views").
 * Type-only: nothing from `@slayzone/api` reaches the bundle.
 *
 * Each export is annotated: an inferred type would have to name modules of api's own
 * dependencies, which this package cannot reference (TS2883).
 */
type View = TrpcView<AppRouter>
const view: View = trpcFor<AppRouter>()

export const useTRPC: View['useTRPC'] = view.useTRPC
export const useTRPCClient: View['useTRPCClient'] = view.useTRPCClient
export const getTrpcClient: View['getTrpcClient'] = view.getTrpcClient
export const getClientForHub: View['getClientForHub'] = view.getClientForHub

export const initTrpcClient: TrpcBoot<AppRouter>['initTrpcClient'] =
  trpcBootFor<AppRouter>().initTrpcClient

/** The vanilla client typed with the whole app router (`e2e/globals.d.ts`). */
export type TrpcVanillaClient = ReturnType<typeof getTrpcClient>
