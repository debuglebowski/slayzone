import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The router's runtime stays server-side.
import type { TagsMounts } from '../server/router'

/**
 * This domain's typed view of the shared tRPC client: the same runtime instance as
 * every other view (one context, one socket per hub), typed against only the routers
 * tags mounts. Domain client code imports `useTRPC` from here, never the whole-app
 * `useTRPC` of `@slayzone/transport/client`.
 */
export const { useTRPC } = typedTrpc<TagsMounts>()
