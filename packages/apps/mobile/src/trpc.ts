import type { AppRouter } from '@slayzone/api'
import { trpcFor, type TrpcView } from '@slayzone/transport/client'
import type { inferRouterOutputs } from '@trpc/server'

/**
 * The mobile app's view of the shared client runtime: the whole app router (an app sits
 * above `@slayzone/api`). Type-only: nothing from `@slayzone/api` reaches the bundle.
 * Annotated: an inferred type would have to name modules of api's own dependencies
 * (TS2883), same as renderer-app's `trpc.ts`.
 */
type View = TrpcView<AppRouter>
const view: View = trpcFor<AppRouter>()

export const useTRPC: View['useTRPC'] = view.useTRPC

export type RouterOutputs = inferRouterOutputs<AppRouter>
