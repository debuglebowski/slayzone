import type { AppRouter } from '@slayzone/api'
import { trpcBootFor, type TrpcBoot } from '@slayzone/transport/client'

/**
 * The web shell's typed boot of the client runtime, for the whole app router (an app
 * sits above `@slayzone/api`). The shell only boots the singleton; the UI it mounts
 * (`renderer-app`) calls through its own view. Type-only: nothing from `@slayzone/api`
 * reaches the bundle. Annotated: an inferred type would have to name modules of api's
 * own dependencies, which this package cannot reference (TS2883).
 */
export const initTrpcClient: TrpcBoot<AppRouter>['initTrpcClient'] =
  trpcBootFor<AppRouter>().initTrpcClient
